import type { GuildBasedChannel, VoiceBasedChannel, VoiceState } from 'discord.js';
import type { MusicService } from '../music/musicService.js';
import type { AppLogger } from '../utils/logger.js';

type VoiceChannelMembersLike = Pick<VoiceBasedChannel, 'members'> | GuildBasedChannel;

/**
 * Counts non-bot members currently present in a voice/stage channel.
 */
export function countHumansInVoiceChannel(
  channel: VoiceChannelMembersLike | null | undefined,
): number {
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
 * Routes Discord `voiceStateUpdate` events to `MusicService` for bot disconnects,
 * empty voice channels, and human listener rejoins while ignoring other bots.
 */
export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  musicService: Pick<
    MusicService,
    'handleVoiceDisconnect' | 'handleVoiceChannelEmpty' | 'handleVoiceHumanJoined'
  >,
  logger?: AppLogger,
): Promise<void> {
  const guild = newState.guild ?? oldState.guild;
  const guildId = guild?.id;
  if (!guildId) {
    return;
  }

  const oldChannelId = oldState.channelId ?? null;
  const newChannelId = newState.channelId ?? null;
  if (oldChannelId === newChannelId) {
    return;
  }

  const botUserId =
    newState.client?.user?.id ?? oldState.client?.user?.id ?? guild.members?.me?.id ?? null;
  const actorUserId = newState.id ?? oldState.id ?? newState.member?.id ?? oldState.member?.id ?? null;

  try {
    // Single disconnect source for bot-left events (prevents duplicate handling with Lavalink playerDisconnect).
    if (botUserId && actorUserId === botUserId) {
      if (oldChannelId !== null && newChannelId === null) {
        await musicService.handleVoiceDisconnect(guildId);
        return;
      }

      if (oldChannelId !== null && newChannelId !== null) {
        const destinationChannel = newState.channel ?? guild.channels?.cache?.get(newChannelId);
        if (countHumansInVoiceChannel(destinationChannel) === 0) {
          await musicService.handleVoiceChannelEmpty(guildId);
        } else {
          await musicService.handleVoiceHumanJoined(guildId);
        }
      }
      return;
    }

    const isBot = Boolean(newState.member?.user?.bot ?? oldState.member?.user?.bot);
    if (isBot) {
      return;
    }

    const botVoiceChannelId = guild.members?.me?.voice?.channelId ?? null;
    if (!botVoiceChannelId) {
      return;
    }

    if (oldChannelId === botVoiceChannelId && newChannelId !== botVoiceChannelId) {
      const botChannel = oldState.channel ?? guild.channels?.cache?.get(botVoiceChannelId);
      if (countHumansInVoiceChannel(botChannel) === 0) {
        await musicService.handleVoiceChannelEmpty(guildId);
      }
      return;
    }

    if (newChannelId === botVoiceChannelId && oldChannelId !== botVoiceChannelId) {
      await musicService.handleVoiceHumanJoined(guildId);
    }
  } catch (error) {
    logger?.error({ err: error, guildId }, 'Erro inesperado ao processar evento voiceStateUpdate');
  }
}
