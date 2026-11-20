import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const removeCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove uma música específica da fila')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('posicao')
        .setDescription('Posição da música na fila (a partir de 1)')
        .setMinValue(1)
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

    const position = interaction.options.getInteger('posicao', true);
    const result = await context.musicService.remove(guard.guildId, position);
    await replyActionResult(interaction, '🗑️ Música Removida', result);
  },
};
