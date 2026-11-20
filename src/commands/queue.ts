import { ComponentType, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { QueueSnapshot } from '../music/musicService.js';
import {
  QUEUE_BUTTON_PREFIX,
  buildQueueEmbed,
  buildQueuePaginationButtons,
  disableMessageButtonsSafely,
  type EditablePanelMessage,
} from '../music/playerPanel.js';
import { enforceCommandGuards, replyEphemeral } from './guards.js';
import type { SlashCommand } from './types.js';

const QUEUE_PAGE_SIZE = 10;
const QUEUE_COLLECTOR_TIMEOUT_MS = 120_000;
const IGNORED_DISCORD_CODES = new Set([10008, 50001, 10003, 50013]);

function buildQueueView(snapshot: QueueSnapshot, requestedPage: number) {
  const totalPages = Math.max(1, Math.ceil(snapshot.queue.length / QUEUE_PAGE_SIZE));
  const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);

  return {
    embed: buildQueueEmbed({
      currentTrack: snapshot.currentTrack,
      queue: snapshot.queue,
      page: currentPage,
      pageSize: QUEUE_PAGE_SIZE,
      repeatMode: snapshot.repeatMode,
      paused: snapshot.paused,
    }),
    row: buildQueuePaginationButtons({ currentPage, totalPages }),
  };
}

export const queueCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Mostra a música atual e a fila de reprodução paginada')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('pagina')
        .setDescription('Número da página da fila (padrão: 1)')
        .setMinValue(1)
        .setRequired(false),
    ),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context);
    if (!guard.ok) {
      return;
    }

    const snapshot = context.musicService.getQueue(guard.guildId);
    if (!snapshot) {
      await replyEphemeral(interaction, 'Não há nenhuma música tocando ou na fila no momento.');
      return;
    }

    const requestedPage = interaction.options.getInteger('pagina') ?? 1;
    const initialView = buildQueueView(snapshot, requestedPage);

    const response = await interaction.reply({
      embeds: [initialView.embed],
      components: [initialView.row],
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: QUEUE_COLLECTOR_TIMEOUT_MS,
      filter: (buttonInteraction) => buttonInteraction.customId.startsWith(QUEUE_BUTTON_PREFIX),
    });

    collector.on('collect', async (buttonInteraction) => {
      try {
        const rawPage = buttonInteraction.customId.slice(QUEUE_BUTTON_PREFIX.length);
        const parsedPage = Number.parseInt(rawPage, 10);
        const targetPage = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;

        const latest = context.musicService.getQueue(guard.guildId);
        if (!latest) {
          const emptyEmbed = buildQueueEmbed({
            currentTrack: null,
            queue: [],
            page: 1,
            pageSize: QUEUE_PAGE_SIZE,
            repeatMode: 'off',
          });
          const disabledRow = buildQueuePaginationButtons({
            currentPage: 1,
            totalPages: 1,
            disabled: true,
          });
          await buttonInteraction.update({ embeds: [emptyEmbed], components: [disabledRow] });
          collector.stop('queue_empty');
          return;
        }

        const nextView = buildQueueView(latest, targetPage);
        await buttonInteraction.update({
          embeds: [nextView.embed],
          components: [nextView.row],
        });
      } catch (error) {
        context.logger.warn(
          { err: error, guildId: guard.guildId },
          'Erro ao atualizar página da fila',
        );
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'queue_empty') {
        return;
      }

      try {
        const message =
          typeof response.fetch === 'function'
            ? await response.fetch()
            : await interaction.fetchReply();

        if (!message) {
          return;
        }

        await disableMessageButtonsSafely(message as EditablePanelMessage, (err) => {
          context.logger.warn(
            { err, guildId: guard.guildId },
            'Erro inesperado ao desabilitar botões de paginação da fila',
          );
        });
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        if (typeof code === 'number' && IGNORED_DISCORD_CODES.has(code)) {
          return;
        }
        context.logger.warn(
          { err: error, guildId: guard.guildId },
          'Falha ao buscar mensagem da fila para desabilitar botões no timeout',
        );
      }
    });
  },
};
