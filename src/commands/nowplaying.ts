import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { buildControlButtons, buildNowPlayingEmbed } from '../music/playerPanel.js';
import { enforceCommandGuards, replyEphemeral } from './guards.js';
import type { SlashCommand } from './types.js';

export const nowPlayingCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Exibe a música tocando agora com painel interativo')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context);
    if (!guard.ok) {
      return;
    }

    const snapshot = context.musicService.getNowPlaying(guard.guildId);
    if (!snapshot) {
      await replyEphemeral(interaction, 'Não há nenhuma música tocando no momento.');
      return;
    }

    const embed = buildNowPlayingEmbed({
      track: snapshot.track,
      paused: snapshot.paused,
      volume: snapshot.volume,
      repeatMode: snapshot.repeatMode,
      queueLength: snapshot.queueLength,
    });
    const row = buildControlButtons({
      paused: snapshot.paused,
      repeatMode: snapshot.repeatMode,
    });

    const response = await interaction.reply({
      embeds: [embed],
      components: [row],
    });

    const fetched =
      typeof response?.fetch === 'function'
        ? await response.fetch().catch(() => null)
        : typeof interaction.fetchReply === 'function'
          ? await interaction.fetchReply().catch(() => null)
          : null;

    const messageId = fetched?.id ?? (response as { id?: string } | undefined)?.id;
    const channelId = fetched?.channelId ?? interaction.channelId;

    if (messageId && channelId) {
      await context.musicService.registerPanel(guard.guildId, { channelId, messageId });
    }
  },
};
