import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const pauseCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pausa a música atual')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      requireVoice: true,
      requireControl: true,
    });
    if (!guard.ok) {
      return;
    }

    const result = await context.musicService.pause(guard.guildId);
    await replyActionResult(interaction, '⏸️ Reprodução Pausada', result);
  },
};
