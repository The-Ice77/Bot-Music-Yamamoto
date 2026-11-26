import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const moveCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move uma música para outra posição da fila')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('origem')
        .setDescription('Posição atual da música na fila (a partir de 1)')
        .setMinValue(1)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('destino')
        .setDescription('Nova posição na fila (a partir de 1)')
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

    const fromPosition = interaction.options.getInteger('origem', true);
    const toPosition = interaction.options.getInteger('destino', true);
    const result = await context.musicService.moveTrack(
      guard.guildId,
      fromPosition,
      toPosition,
    );
    await replyActionResult(interaction, '↕️ Fila Reorganizada', result);
  },
};
