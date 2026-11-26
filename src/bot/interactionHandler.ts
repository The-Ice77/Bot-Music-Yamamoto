import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { enforceButtonControl, resolveVoiceChannel } from '../commands/guards.js';
import { commandsByName } from '../commands/index.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import {
  PANEL_BUTTON_IDS,
  QUEUE_ACTION_PREFIX,
  QUEUE_BUTTON_PREFIX,
  buildNowPlayingEmbed,
  buildPanelComponents,
  buildQueueEmbed,
  disableMessageButtonsSafely,
  type EditablePanelMessage,
} from '../music/playerPanel.js';
import type { AppLogger } from '../utils/logger.js';

export interface InteractionHandlerDeps extends CommandContext {
  commands?: ReadonlyMap<string, SlashCommand>;
}

const PANEL_BUTTON_ID_SET = new Set<string>(Object.values(PANEL_BUTTON_IDS));

async function safeReplyEphemeral(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  content: string,
  logger: AppLogger,
): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.warn(
      { err: error, guildId: interaction.guildId, userId: interaction.user?.id },
      'Falha ao enviar resposta efêmera para interação',
    );
  }
}

async function finishButtonReply(
  interaction: ButtonInteraction,
  content: string,
  logger: AppLogger,
  deferredByUs: boolean,
): Promise<void> {
  if (deferredByUs && typeof interaction.editReply === 'function') {
    try {
      await interaction.editReply({ content });
      return;
    } catch (error) {
      logger.warn(
        { err: error, guildId: interaction.guildId, userId: interaction.user?.id },
        'Falha ao editar resposta efêmera adiada do botão',
      );
      return;
    }
  }

  await safeReplyEphemeral(interaction, content, logger);
}

async function disableStaleButtonMessage(
  interaction: ButtonInteraction,
  logger: AppLogger,
): Promise<void> {
  const message = interaction.message as unknown as EditablePanelMessage | undefined;
  if (!message || typeof message.edit !== 'function') {
    return;
  }

  await disableMessageButtonsSafely(message, (error) => {
    logger.warn(
      { err: error, guildId: interaction.guildId },
      'Erro inesperado ao desabilitar botões de painel obsoleto',
    );
  });
}

async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps,
): Promise<void> {
  const registry = deps.commands ?? commandsByName;
  const command = registry.get(interaction.commandName);

  if (!command) {
    deps.logger.warn(
      { commandName: interaction.commandName, guildId: interaction.guildId },
      'Comando slash desconhecido recebido',
    );
    await safeReplyEphemeral(interaction, 'Comando não reconhecido.', deps.logger);
    return;
  }

  try {
    await command.execute(interaction, deps);
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        commandName: interaction.commandName,
        guildId: interaction.guildId,
        userId: interaction.user?.id,
      },
      'Erro inesperado ao executar comando slash',
    );
    await safeReplyEphemeral(
      interaction,
      'Ocorreu um erro inesperado ao executar este comando. Tente novamente em instantes.',
      deps.logger,
    );
  }
}

async function handlePanelButton(
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
): Promise<void> {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!interaction.inGuild() || !guild || !guildId) {
    await safeReplyEphemeral(
      interaction,
      'Este controle só pode ser usado dentro de um servidor.',
      deps.logger,
    );
    return;
  }

  const botVoice = resolveVoiceChannel(guild, guild.members?.me?.voice);
  if (botVoice.channelId === null && !deps.musicService.getNowPlaying(guildId)) {
    await safeReplyEphemeral(
      interaction,
      '❌ Não há nenhuma reprodução ativa no momento.',
      deps.logger,
    );
    await disableStaleButtonMessage(interaction, deps.logger);
    return;
  }

  if (interaction.customId === PANEL_BUTTON_IDS.queue) {
    const queueSnapshot = deps.musicService.getQueue(guildId);
    if (!queueSnapshot) {
      await safeReplyEphemeral(
        interaction,
        'Não há nenhuma música tocando ou na fila no momento.',
        deps.logger,
      );
      return;
    }

    try {
      const embed = buildQueueEmbed({
        currentTrack: queueSnapshot.currentTrack,
        currentPositionMs: queueSnapshot.currentPositionMs,
        queue: queueSnapshot.queue,
        page: 1,
        repeatMode: queueSnapshot.repeatMode,
        paused: queueSnapshot.paused,
      });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (error) {
      deps.logger.warn(
        { err: error, guildId, userId: interaction.user?.id },
        'Falha ao exibir fila rápida do painel',
      );
    }
    return;
  }

  const controlGuard = await enforceButtonControl(interaction, deps.settingsRepo, deps.logger);
  if (!controlGuard.ok) {
    return;
  }

  const isNonUpdateControl =
    interaction.customId === PANEL_BUTTON_IDS.skip ||
    interaction.customId === PANEL_BUTTON_IDS.shuffle ||
    interaction.customId === PANEL_BUTTON_IDS.stop;

  const isUpdateControl =
    interaction.customId === PANEL_BUTTON_IDS.toggle ||
    interaction.customId === PANEL_BUTTON_IDS.loop ||
    interaction.customId === PANEL_BUTTON_IDS.volumeDown ||
    interaction.customId === PANEL_BUTTON_IDS.volumeUp ||
    interaction.customId === PANEL_BUTTON_IDS.mute;

  let deferredByUs = false;
  try {
    if (isNonUpdateControl && typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      deferredByUs = true;
    }

    let result: { ok: boolean; reason?: string; message: string };
    let endedQueue = false;

    switch (interaction.customId) {
      case PANEL_BUTTON_IDS.toggle:
        result = await deps.musicService.togglePause(guildId);
        break;
      case PANEL_BUTTON_IDS.skip: {
        const skipResult = await deps.musicService.skip(guildId, 1);
        result = skipResult;
        if (skipResult.ok) {
          endedQueue = skipResult.endedQueue;
        }
        break;
      }
      case PANEL_BUTTON_IDS.loop:
        result = await deps.musicService.cycleLoop(guildId);
        break;
      case PANEL_BUTTON_IDS.shuffle:
        result = await deps.musicService.shuffle(guildId);
        break;
      case PANEL_BUTTON_IDS.stop:
        result = await deps.musicService.stop(guildId);
        break;
      case PANEL_BUTTON_IDS.volumeDown:
        result = await deps.musicService.adjustVolume(guildId, -10);
        break;
      case PANEL_BUTTON_IDS.volumeUp:
        result = await deps.musicService.adjustVolume(guildId, 10);
        break;
      case PANEL_BUTTON_IDS.mute:
        result = await deps.musicService.toggleMute(guildId);
        break;
      default:
        return;
    }

    if (!result.ok) {
      await finishButtonReply(interaction, `❌ ${result.message}`, deps.logger, deferredByUs);
      if (result.reason === 'NO_PLAYER' || result.reason === 'NO_ACTIVE_TRACK') {
        await disableStaleButtonMessage(interaction, deps.logger);
      }
      return;
    }

    if (isUpdateControl) {
      const snapshot = deps.musicService.getNowPlaying(guildId);
      if (snapshot && typeof interaction.update === 'function') {
        await interaction.update({
          embeds: [
            buildNowPlayingEmbed({
              track: snapshot.track,
              paused: snapshot.paused,
              volume: snapshot.volume,
              repeatMode: snapshot.repeatMode,
              queueLength: snapshot.queueLength,
            }),
          ],
          components: buildPanelComponents({
            paused: snapshot.paused,
            repeatMode: snapshot.repeatMode,
            volume: snapshot.volume,
          }),
        });
        return;
      }

      await finishButtonReply(interaction, result.message, deps.logger, deferredByUs);
      return;
    }

    if (interaction.customId === PANEL_BUTTON_IDS.stop) {
      await finishButtonReply(interaction, `⏹️ ${result.message}`, deps.logger, deferredByUs);
      await disableStaleButtonMessage(interaction, deps.logger);
      return;
    }

    if (interaction.customId === PANEL_BUTTON_IDS.skip) {
      await finishButtonReply(interaction, `⏭️ ${result.message}`, deps.logger, deferredByUs);
      if (endedQueue) {
        await disableStaleButtonMessage(interaction, deps.logger);
      }
      return;
    }

    await finishButtonReply(interaction, `🔀 ${result.message}`, deps.logger, deferredByUs);
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        customId: interaction.customId,
        guildId,
        userId: interaction.user?.id,
      },
      'Erro inesperado ao processar botão do painel de música',
    );
    await finishButtonReply(
      interaction,
      'Ocorreu um erro inesperado ao processar este botão. Tente novamente.',
      deps.logger,
      deferredByUs,
    );
  }
}

/**
 * Dispatches Discord slash commands and `music:*` interactive player panel buttons.
 * Leaves `queue:page:` and `queue:action:` buttons to `/queue`'s dedicated component collector.
 */
export async function handleInteraction(
  interaction: Interaction,
  deps: InteractionHandlerDeps,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleChatInputCommand(interaction, deps);
    return;
  }

  if (interaction.isButton()) {
    if (
      interaction.customId.startsWith(QUEUE_BUTTON_PREFIX) ||
      interaction.customId.startsWith(QUEUE_ACTION_PREFIX)
    ) {
      return;
    }
    if (!PANEL_BUTTON_ID_SET.has(interaction.customId)) {
      return;
    }
    await handlePanelButton(interaction, deps);
  }
}
