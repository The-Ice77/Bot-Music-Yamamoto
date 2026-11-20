import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const shuffleCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Embaralha as próximas músicas da fila')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      requireVoice: true,
      requireControl: true,
    });
    if (!guard.ok) {
      return;
    }

    const result = await context.musicService.shuffle(guard.guildId);
    await replyActionResult(interaction, '🔀 Fila Embaralhada', result);
  },
};
