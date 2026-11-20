import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const volumeCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Ajusta o volume da reprodução atual')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('nivel')
        .setDescription('Nível de volume (0 a 150)')
        .setMinValue(0)
        .setMaxValue(150)
        .setRequired(true),
    ),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      requireVoice: true,
      requireControl: true,
    });
    if (!guard.ok) {
      return;
    }

    const level = interaction.options.getInteger('nivel', true);
    const result = await context.musicService.setVolume(guard.guildId, level);
    await replyActionResult(interaction, '🔊 Volume Ajustado', result);
  },
};
