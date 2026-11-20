import type { GuildSettings } from '../db/guildSettingsRepository.js';

export interface ControlPermissionInput {
  djRoleId: string | null;
  memberRoleIds: readonly string[] | ReadonlySet<string>;
  isAdminOrManager: boolean;
  humanCountInBotChannel: number;
}

export interface VoiceAccessInput {
  memberVoiceChannelId: string | null;
  botVoiceChannelId: string | null;
  botHasVoicePerms: boolean;
}

function hasRole(roleIds: readonly string[] | ReadonlySet<string>, roleId: string): boolean {
  return Array.isArray(roleIds) ? roleIds.includes(roleId) : (roleIds as ReadonlySet<string>).has(roleId);
}

/**
 * Determines whether a member can execute playback control actions in a guild.
 * Allowed if no DJ role is configured, the member is Admin/ManageGuild,
 * the member is the lone human in the bot's voice channel, or holds the DJ role.
 */
export function canControlPlayer(input: ControlPermissionInput): boolean {
  if (!input.djRoleId) {
    return true;
  }

  if (input.isAdminOrManager) {
    return true;
  }

  if (input.humanCountInBotChannel <= 1) {
    return true;
  }

  return hasRole(input.memberRoleIds, input.djRoleId);
}

/**
 * Checks whether a command invocation in `channelId` satisfies the guild's restricted music channel setting.
 */
export function validateMusicChannel(
  channelId: string,
  settings: GuildSettings,
): { ok: true } | { ok: false; allowedChannelId: string } {
  if (settings.musicChannelId === null || channelId === settings.musicChannelId) {
    return { ok: true };
  }

  return { ok: false, allowedChannelId: settings.musicChannelId };
}

/**
 * Validates that a member is in voice, aligned with any active bot voice channel,
 * and that the bot holds ViewChannel + Connect + Speak permissions in that channel.
 */
export function validateVoiceAccess(
  input: VoiceAccessInput,
): { ok: true } | { ok: false; reason: 'NOT_IN_VOICE' | 'DIFFERENT_CHANNEL' | 'MISSING_PERMISSIONS'; botChannelId?: string } {
  if (!input.memberVoiceChannelId) {
    return { ok: false, reason: 'NOT_IN_VOICE' };
  }

  if (input.botVoiceChannelId !== null && input.botVoiceChannelId !== input.memberVoiceChannelId) {
    return {
      ok: false,
      reason: 'DIFFERENT_CHANNEL',
      botChannelId: input.botVoiceChannelId,
    };
  }

  if (!input.botHasVoicePerms) {
    return { ok: false, reason: 'MISSING_PERMISSIONS' };
  }

  return { ok: true };
}
