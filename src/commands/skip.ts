import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const skipCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Pula a música atual ou avança várias posições na fila')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('quantidade')
        .setDescription('Quantidade de músicas para pular (padrão: 1)')
        .setMinValue(1)
        .setRequired(false),
    ),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      requireVoice: true,
      requireControl: true,
    });
    if (!guard.ok) {
      return;
    }

    const amount = interaction.options.getInteger('quantidade') ?? 1;
    const result = await context.musicService.skip(guard.guildId, amount);
    const title = result.ok && result.endedQueue ? '⏹️ Fila Encerrada' : '⏭️ Música Pulada';
    await replyActionResult(interaction, title, result);
  },
};
