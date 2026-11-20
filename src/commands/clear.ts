import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const clearCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Remove todas as músicas pendentes da fila')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      requireVoice: true,
      requireControl: true,
    });
    if (!guard.ok) {
      return;
    }

    const result = await context.musicService.clearQueue(guard.guildId);
    await replyActionResult(interaction, '🧹 Fila Limpa', result);
  },
};
