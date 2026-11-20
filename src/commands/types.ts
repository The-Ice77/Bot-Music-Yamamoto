import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { EnvConfig } from '../config/env.js';
import type { GuildSettingsRepository } from '../db/guildSettingsRepository.js';
import type { MusicService } from '../music/musicService.js';
import type { AppLogger } from '../utils/logger.js';

export type SlashCommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface CommandContext {
  musicService: MusicService;
  settingsRepo: GuildSettingsRepository;
  logger: AppLogger;
  env?: EnvConfig;
}

export interface SlashCommand {
  data: SlashCommandData;
  execute(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<void>;
}
