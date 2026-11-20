import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';
import type { GuildSettings } from '../db/guildSettingsRepository.js';
import {
  canControlPlayer,
  validateMusicChannel,
  validateVoiceAccess,
} from '../music/permissions.js';
import type { CommandContext } from './types.js';

export const COMMAND_EMBED_COLOR = 0x5865f2;

export interface GuardOptions {
  /** Whether to enforce `music_channel_id` restriction (default: `true`). */
  enforceMusicChannel?: boolean;
  /** Whether the member must be connected to a valid voice channel (default: `false`). */
  requireVoice?: boolean;
  /** Whether the member must pass `canControlPlayer` DJ/Admin/lone-listener checks (default: `false`). */
  requireControl?: boolean;
  /** Whether the member must have `ManageGuild` permission (default: `false`). */
  requireManageGuild?: boolean;
}

export type GuardResult =
  | {
      ok: true;
      guild: Guild;
      guildId: string;
      member: GuildMember;
      settings: GuildSettings;
      voiceChannelId: string | null;
    }
  | { ok: false };

export interface BotVoicePermsCheck {
  ok: boolean;
  missing: string[];
  isStage: boolean;
}

type VoiceChannelLike = Pick<VoiceBasedChannel, 'id' | 'type' | 'permissionsFor' | 'members'>;

function resolveGuildMember(interaction: ChatInputCommandInteraction, guild: Guild): GuildMember | null {
  const raw = interaction.member;
  if (raw && typeof raw === 'object' && 'voice' in raw) {
    return raw as GuildMember;
  }
  return guild.members?.cache?.get(interaction.user.id) ?? null;
}

function resolveMemberPermissions(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
) {
  return interaction.memberPermissions ?? member.permissions;
}

function hasManageGuildPermission(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
): boolean {
  const perms = resolveMemberPermissions(interaction, member);
  return Boolean(perms?.has?.(PermissionFlagsBits.ManageGuild));
}

function hasAdminOrManagerPermission(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
): boolean {
  const perms = resolveMemberPermissions(interaction, member);
  return Boolean(
    perms?.has?.(PermissionFlagsBits.Administrator) ||
      perms?.has?.(PermissionFlagsBits.ManageGuild),
  );
}

function extractMemberRoleIds(member: GuildMember): readonly string[] | ReadonlySet<string> {
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

function countHumansInChannel(channel: VoiceChannelLike | GuildBasedChannel | null | undefined): number {
  if (
    !channel ||
    !('members' in channel) ||
    !channel.members ||
    !('values' in channel.members) ||
    typeof channel.members.values !== 'function'
  ) {
    return 0;
  }

  let humans = 0;
  for (const member of channel.members.values()) {
    if (!member.user?.bot) {
      humans += 1;
    }
  }
  return humans;
}

/**
 * Resolves a member's active voice channel from their voice state or the guild channel cache.
 */
export function resolveVoiceChannel(
  guild: Guild,
  voice: { channelId?: string | null; channel?: VoiceBasedChannel | null } | null | undefined,
): { channelId: string | null; channel: VoiceBasedChannel | GuildBasedChannel | null } {
  const channelId = voice?.channelId ?? voice?.channel?.id ?? null;
  const channel = voice?.channel ?? (channelId ? guild.channels?.cache?.get(channelId) : null) ?? null;
  return { channelId, channel };
}

/**
 * Checks whether the bot holds `ViewChannel`, `Connect`, and `Speak` in the given voice/stage channel.
 */
export function checkBotVoicePermissions(
  channel: VoiceChannelLike | GuildBasedChannel | null | undefined,
  botMember: GuildMember | null | undefined,
): BotVoicePermsCheck {
  const isStage = channel?.type === ChannelType.GuildStageVoice;
  if (!channel || !botMember || !('permissionsFor' in channel) || typeof channel.permissionsFor !== 'function') {
    return {
      ok: false,
      missing: ['Ver Canal', 'Conectar', 'Falar'],
      isStage,
    };
  }

  const perms = channel.permissionsFor(botMember);
  const missing: string[] = [];
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) {
    missing.push('Ver Canal');
  }
  if (!perms?.has(PermissionFlagsBits.Connect)) {
    missing.push('Conectar');
  }
  if (!perms?.has(PermissionFlagsBits.Speak)) {
    missing.push('Falar');
  }

  return {
    ok: missing.length === 0,
    missing,
    isStage,
  };
}

/**
 * Formats a clear `pt-BR` error message describing missing voice permissions and Stage Channel guidance.
 */
export function formatMissingVoicePermissionsMessage(
  channelId: string,
  check: BotVoicePermsCheck,
): string {
  const missingList = check.missing.length > 0 ? check.missing.join(', ') : 'Ver Canal, Conectar, Falar';
  const stageHint = check.isStage
    ? ' Em **Canais de Palco (Stage)**, certifique-se também de conceder permissão de fala/orador (ou Moderador de Palco) ao bot.'
    : '';
  return `Não tenho as permissões necessárias no canal <#${channelId}> (${missingList}).${stageHint}`;
}

/**
 * Sends an ephemeral error or notice reply safely whether or not the interaction was deferred.
 */
export async function replyEphemeral(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/**
 * Builds a clean public confirmation embed for slash commands.
 */
export function buildStatusEmbed(
  title: string,
  description: string,
  color = COMMAND_EMBED_COLOR,
): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

/**
 * Replies ephemerally on action failure or with a clean confirmation embed on success.
 */
export async function replyActionResult(
  interaction: ChatInputCommandInteraction,
  successTitle: string,
  result: { ok: boolean; message: string },
): Promise<void> {
  if (!result.ok) {
    await replyEphemeral(interaction, `❌ ${result.message}`);
    return;
  }

  await interaction.reply({
    embeds: [buildStatusEmbed(successTitle, result.message)],
  });
}

/**
 * Enforces guild context, optional ManageGuild permission, restricted music text channel,
 * voice channel alignment + bot permissions (`ViewChannel`/`Connect`/`Speak`), and DJ control rules.
 */
export async function enforceCommandGuards(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  options: GuardOptions = {},
): Promise<GuardResult> {
  const enforceMusicChannel = options.enforceMusicChannel ?? true;
  const requireVoice = options.requireVoice ?? false;
  const requireControl = options.requireControl ?? false;
  const requireManageGuild = options.requireManageGuild ?? false;

  const guild = interaction.guild;
  const guildId = interaction.guildId;
  if (!guild || !guildId) {
    await replyEphemeral(interaction, 'Este comando só pode ser usado dentro de um servidor.');
    return { ok: false };
  }

  const member = resolveGuildMember(interaction, guild);
  if (!member) {
    await replyEphemeral(interaction, 'Não foi possível identificar seu membro neste servidor.');
    return { ok: false };
  }

  if (requireManageGuild && !hasManageGuildPermission(interaction, member)) {
    await replyEphemeral(
      interaction,
      'Você precisa da permissão **Gerenciar Servidor** para usar este comando.',
    );
    return { ok: false };
  }

  const settings = context.settingsRepo.getOrDefault(guildId);

  if (enforceMusicChannel) {
    const channelCheck = validateMusicChannel(interaction.channelId, settings);
    if (!channelCheck.ok) {
      await replyEphemeral(
        interaction,
        `Os comandos de música deste servidor só podem ser usados em <#${channelCheck.allowedChannelId}>.`,
      );
      return { ok: false };
    }
  }

  const memberVoice = resolveVoiceChannel(guild, member.voice);
  const botMember = guild.members?.me ?? null;
  const botVoice = resolveVoiceChannel(guild, botMember?.voice);

  if (requireVoice) {
    const permsCheck = checkBotVoicePermissions(memberVoice.channel, botMember);
    const voiceAccess = validateVoiceAccess({
      memberVoiceChannelId: memberVoice.channelId,
      botVoiceChannelId: botVoice.channelId,
      botHasVoicePerms: permsCheck.ok,
    });

    if (!voiceAccess.ok) {
      if (voiceAccess.reason === 'NOT_IN_VOICE') {
        await replyEphemeral(
          interaction,
          'Você precisa estar conectado a um canal de voz para usar este comando.',
        );
        return { ok: false };
      }

      if (voiceAccess.reason === 'DIFFERENT_CHANNEL') {
        await replyEphemeral(
          interaction,
          `Já estou conectado em outro canal de voz (<#${voiceAccess.botChannelId}>). Entre no mesmo canal para usar este comando.`,
        );
        return { ok: false };
      }

      await replyEphemeral(
        interaction,
        formatMissingVoicePermissionsMessage(memberVoice.channelId!, permsCheck),
      );
      return { ok: false };
    }
  }

  if (requireControl) {
    const allowed = canControlPlayer({
      djRoleId: settings.djRoleId,
      memberRoleIds: extractMemberRoleIds(member),
      isAdminOrManager: hasAdminOrManagerPermission(interaction, member),
      humanCountInBotChannel: countHumansInChannel(botVoice.channel ?? memberVoice.channel),
    });

    if (!allowed) {
      const msg = settings.djRoleId
        ? `Você precisa do cargo <@&${settings.djRoleId}> (DJ), permissão de administrador/gerenciar servidor ou estar sozinho com o bot no canal de voz para usar este comando.`
        : 'Você não tem permissão para controlar o player no momento.';
      await replyEphemeral(interaction, msg);
      return { ok: false };
    }
  }

  return {
    ok: true,
    guild,
    guildId,
    member,
    settings,
    voiceChannelId: memberVoice.channelId,
  };
}
