import {
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Interaction,
} from 'discord.js';
import { resolveVoiceChannel } from '../commands/guards.js';
import { commandsByName } from '../commands/index.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import { canControlPlayer } from '../music/permissions.js';
import {
  PANEL_BUTTON_IDS,
  QUEUE_BUTTON_PREFIX,
  buildControlButtons,
  buildNowPlayingEmbed,
  disableMessageButtonsSafely,
  type EditablePanelMessage,
} from '../music/playerPanel.js';
import type { AppLogger } from '../utils/logger.js';
import { countHumansInVoiceChannel } from './voiceStateHandler.js';

export interface InteractionHandlerDeps extends CommandContext {
  commands?: ReadonlyMap<string, SlashCommand>;
}

const PANEL_BUTTON_ID_SET = new Set<string>(Object.values(PANEL_BUTTON_IDS));

function resolveMember(
  interaction: ButtonInteraction,
  guild: Guild,
): GuildMember | null {
  const raw = interaction.member;
  if (raw && typeof raw === 'object' && 'voice' in raw) {
    return raw as GuildMember;
  }
  return guild.members?.cache?.get(interaction.user.id) ?? null;
}

function extractRoleIds(member: GuildMember): readonly string[] | ReadonlySet<string> {
  const roles = member.roles as unknown;
  if (Array.isArray(roles)) {
    return roles as string[];
  }
  if (roles && typeof roles === 'object' && 'cache' in roles) {
    const cache = (roles as { cache?: Map<string, unknown> }).cache;
    if (cache && typeof cache.keys === 'function') {
      return new Set(cache.keys());
    }
  }
  return [];
}

function isAdminOrManager(interaction: ButtonInteraction, member: GuildMember): boolean {
  const perms = interaction.memberPermissions ?? member.permissions;
  return Boolean(
    perms?.has?.(PermissionFlagsBits.Administrator) ||
      perms?.has?.(PermissionFlagsBits.ManageGuild),
  );
}

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

  const member = resolveMember(interaction, guild);
  if (!member) {
    await safeReplyEphemeral(
      interaction,
      'Não foi possível identificar seu membro neste servidor.',
      deps.logger,
    );
    return;
  }

  const memberVoice = resolveVoiceChannel(guild, member.voice);
  if (!memberVoice.channelId) {
    await safeReplyEphemeral(
      interaction,
      'Você precisa estar conectado a um canal de voz para usar os controles do player.',
      deps.logger,
    );
    return;
  }

  const botVoice = resolveVoiceChannel(guild, guild.members?.me?.voice);
  if (botVoice.channelId !== null && botVoice.channelId !== memberVoice.channelId) {
    await safeReplyEphemeral(
      interaction,
      `Você precisa estar no mesmo canal de voz que eu (<#${botVoice.channelId}>) para usar os controles.`,
      deps.logger,
    );
    return;
  }

  const settings = deps.settingsRepo.getOrDefault(guildId);
  const allowed = canControlPlayer({
    djRoleId: settings.djRoleId,
    memberRoleIds: extractRoleIds(member),
    isAdminOrManager: isAdminOrManager(interaction, member),
    humanCountInBotChannel: countHumansInVoiceChannel(botVoice.channel ?? memberVoice.channel),
  });

  if (!allowed) {
    const message = settings.djRoleId
      ? `Você precisa do cargo <@&${settings.djRoleId}> (DJ), permissão de administrador/gerenciar servidor ou estar sozinho com o bot no canal de voz para usar os controles.`
      : 'Você não tem permissão para controlar o player no momento.';
    await safeReplyEphemeral(interaction, message, deps.logger);
    return;
  }

  try {
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
      default:
        return;
    }

    if (!result.ok) {
      await safeReplyEphemeral(interaction, `❌ ${result.message}`, deps.logger);
      if (result.reason === 'NO_PLAYER' || result.reason === 'NO_ACTIVE_TRACK') {
        await disableStaleButtonMessage(interaction, deps.logger);
      }
      return;
    }

    if (
      interaction.customId === PANEL_BUTTON_IDS.toggle ||
      interaction.customId === PANEL_BUTTON_IDS.loop
    ) {
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
          components: [
            buildControlButtons({
              paused: snapshot.paused,
              repeatMode: snapshot.repeatMode,
            }),
          ],
        });
        return;
      }

      await safeReplyEphemeral(interaction, result.message, deps.logger);
      return;
    }

    if (interaction.customId === PANEL_BUTTON_IDS.stop) {
      await disableStaleButtonMessage(interaction, deps.logger);
      await safeReplyEphemeral(interaction, `⏹️ ${result.message}`, deps.logger);
      return;
    }

    if (interaction.customId === PANEL_BUTTON_IDS.skip) {
      if (endedQueue) {
        await disableStaleButtonMessage(interaction, deps.logger);
      }
      await safeReplyEphemeral(interaction, `⏭️ ${result.message}`, deps.logger);
      return;
    }

    await safeReplyEphemeral(interaction, `🔀 ${result.message}`, deps.logger);
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
    await safeReplyEphemeral(
      interaction,
      'Ocorreu um erro inesperado ao processar este botão. Tente novamente.',
      deps.logger,
    );
  }
}

/**
 * Dispatches Discord slash commands and `music:*` interactive player panel buttons.
 * Leaves `queue:page:` pagination buttons to `/queue`'s dedicated component collector.
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
    if (interaction.customId.startsWith(QUEUE_BUTTON_PREFIX)) {
      return;
    }
    if (!PANEL_BUTTON_ID_SET.has(interaction.customId)) {
      return;
    }
    await handlePanelButton(interaction, deps);
  }
}
