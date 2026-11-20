import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { RepeatMode } from '../music/musicService.js';
import { enforceCommandGuards, replyActionResult } from './guards.js';
import type { SlashCommand } from './types.js';

export const loopCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Define o modo de repetição da reprodução')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('modo')
        .setDescription('Modo de repetição desejado')
        .setRequired(true)
        .addChoices(
          { name: 'Desativado', value: 'off' },
          { name: 'Música', value: 'track' },
          { name: 'Fila', value: 'queue' },
        ),
    ),

  async execute(interaction, context) {
    const guard = await enforceCommandGuards(interaction, context, {
      requireVoice: true,
      requireControl: true,
    });
    if (!guard.ok) {
      return;
    }

    const mode = interaction.options.getString('modo', true) as RepeatMode;
    const result = await context.musicService.setLoop(guard.guildId, mode);
    await replyActionResult(interaction, '🔁 Modo de Repetição', result);
  },
};
