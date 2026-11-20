import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const stopCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Para a reprodução e limpa a fila')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      requireVoice: true,
      requireControl: true,
    });
    if (!guard.ok) {
      return;
    }

    const result = await context.musicService.stop(guard.guildId);
    await replyActionResult(interaction, '⏹️ Reprodução Parada', result);
  },
};
