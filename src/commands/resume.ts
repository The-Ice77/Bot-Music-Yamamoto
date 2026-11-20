import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const resumeCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Retoma a reprodução da música pausada')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      requireVoice: true,
      requireControl: true,
    });
    if (!guard.ok) {
      return;
    }

    const result = await context.musicService.resume(guard.guildId);
    await replyActionResult(interaction, '▶️ Reprodução Retomada', result);
  },
};
