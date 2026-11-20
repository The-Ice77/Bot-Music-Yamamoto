import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { formatDuration } from '../music/formatters.js';
import { COMMAND_EMBED_COLOR, enforceCommandGuards } from './guards.js';
import type { SlashCommand } from './types.js';

export const playCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Toca uma música ou playlist do YouTube ou Spotify')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('busca')
        .setDescription('Nome da música ou link do YouTube/Spotify')
        .setRequired(true),
    ),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, { requireVoice: true });
    if (!guard.ok || !guard.voiceChannelId) {
      return;
    }

    const query = interaction.options.getString('busca', true);
    await interaction.deferReply();

    const result = await context.musicService.play({
      guildId: guard.guildId,
      voiceChannelId: guard.voiceChannelId,
      textChannelId: interaction.channelId,
      query,
      requester: interaction.user,
    });

    if (!result.ok) {
      await interaction.editReply({ content: `❌ ${result.message}` });
      return;
    }

    const embed = new EmbedBuilder().setColor(result.startedImmediately ? 0x1db954 : COMMAND_EMBED_COLOR);

    if (result.isPlaylist) {
      embed.setTitle('🎶 Playlist Adicionada').setDescription(result.message);
    } else {
      const { info } = result.firstTrack;
      const trackTitle = info.uri ? `[${info.title}](${info.uri})` : info.title;
      const duration = formatDuration(info.duration, Boolean(info.isStream));
      embed
        .setTitle(result.startedImmediately ? '🎵 Tocando Agora' : '➕ Adicionada à Fila')
        .setDescription(
          `**${trackTitle}**\npor ${info.author ?? 'Desconhecido'} • \`${duration}\``,
        );

      if (info.artworkUrl) {
        embed.setThumbnail(info.artworkUrl);
      }
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
