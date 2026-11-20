import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';
import { loadEnv, type EnvConfig } from './config/env.js';
import { createLogger, type AppLogger } from './utils/logger.js';
import { allCommands } from './commands/index.js';
import type { SlashCommand } from './commands/types.js';

export interface RestClient {
  put(fullRoute: `/${string}`, options: { body: unknown }): Promise<unknown>;
}

export interface DeployCliArgs {
  guildId?: string;
  global: boolean;
}

export interface DeployCommandsOptions {
  token?: string;
  clientId?: string;
  guildId?: string;
  global?: boolean;
  argv?: readonly string[];
  env?: Pick<EnvConfig, 'DISCORD_TOKEN' | 'DISCORD_CLIENT_ID' | 'DEV_GUILD_ID'>;
  commands?: readonly SlashCommand[];
  rest?: RestClient;
  logger?: AppLogger;
}

export interface DeployCommandsResult {
  scope: 'guild' | 'global';
  route: `/${string}`;
  commandCount: number;
  guildId?: string;
}

/**
 * Parses CLI flags (`--global`, `--guild <id>`, `--guild=<id>`) for slash command registration.
 */
export function parseDeployCliArgs(argv: readonly string[] = []): DeployCliArgs {
  let guildId: string | undefined;
  let global = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--global') {
      global = true;
      continue;
    }

    if (arg === '--guild') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('A flag --guild requer um ID de servidor válido.');
      }
      guildId = value.trim();
      i += 1;
      continue;
    }

    if (arg.startsWith('--guild=')) {
      const value = arg.slice('--guild='.length).trim();
      if (!value) {
        throw new Error('A flag --guild requer um ID de servidor válido.');
      }
      guildId = value;
    }
  }

  if (global && guildId) {
    throw new Error('Não utilize --global e --guild simultaneamente.');
  }

  return { guildId, global };
}

function resolveDeployCredentials(options: DeployCommandsOptions): {
  token: string;
  clientId: string;
  devGuildId?: string;
} {
  if (options.env) {
    return {
      token: options.token ?? options.env.DISCORD_TOKEN,
      clientId: options.clientId ?? options.env.DISCORD_CLIENT_ID,
      devGuildId: options.env.DEV_GUILD_ID,
    };
  }

  if (options.token && options.clientId) {
    return {
      token: options.token,
      clientId: options.clientId,
      devGuildId: undefined,
    };
  }

  const rawToken = options.token ?? process.env.DISCORD_TOKEN?.trim();
  const rawClientId = options.clientId ?? process.env.DISCORD_CLIENT_ID?.trim();
  const rawDevGuildId = process.env.DEV_GUILD_ID?.trim() || undefined;

  if (!rawToken || !rawClientId) {
    const env = loadEnv();
    return {
      token: options.token ?? env.DISCORD_TOKEN,
      clientId: options.clientId ?? env.DISCORD_CLIENT_ID,
      devGuildId: env.DEV_GUILD_ID,
    };
  }

  return {
    token: rawToken,
    clientId: rawClientId,
    devGuildId: rawDevGuildId,
  };
}

/**
 * Registers all slash commands either to a specific guild (when `guildId`, `--guild`, or `DEV_GUILD_ID`
 * is present and `--global` is not set) or globally across all guilds.
 */
export async function deployCommands(
  options: DeployCommandsOptions = {},
): Promise<DeployCommandsResult> {
  const cliArgs = options.argv ? parseDeployCliArgs(options.argv) : { guildId: undefined, global: false };
  const useGlobal = Boolean(options.global || cliArgs.global);

  if (useGlobal && (options.guildId || cliArgs.guildId)) {
    throw new Error('Não utilize modo global e ID de servidor simultaneamente.');
  }

  const { token, clientId, devGuildId } = resolveDeployCredentials(options);
  const targetGuildId = useGlobal ? undefined : (options.guildId ?? cliArgs.guildId ?? devGuildId);

  const commands = options.commands ?? allCommands;
  const payload = commands.map((command) => command.data.toJSON());

  const route = targetGuildId
    ? Routes.applicationGuildCommands(clientId, targetGuildId)
    : Routes.applicationCommands(clientId);

  const scope: 'guild' | 'global' = targetGuildId ? 'guild' : 'global';
  const logger = options.logger ?? createLogger('info');
  const rest: RestClient = options.rest ?? new REST({ version: '10' }).setToken(token);

  logger.info(
    { scope, guildId: targetGuildId, commandCount: payload.length },
    'Publicando slash commands no Discord...',
  );

  await rest.put(route, { body: payload });

  logger.info(
    { scope, guildId: targetGuildId, commandCount: payload.length },
    'Slash commands publicados com sucesso.',
  );

  return {
    scope,
    route,
    commandCount: payload.length,
    ...(targetGuildId ? { guildId: targetGuildId } : {}),
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const currentFile = path.resolve(fileURLToPath(import.meta.url));
  const entryFile = path.resolve(entry);
  if (process.platform === 'win32') {
    return currentFile.toLowerCase() === entryFile.toLowerCase();
  }
  return currentFile === entryFile;
}

if (isDirectExecution()) {
  await import('dotenv/config');
  const logger = createLogger('info');
  try {
    await deployCommands({ argv: process.argv.slice(2), logger });
  } catch (error) {
    logger.error({ err: error }, 'Falha ao publicar slash commands');
    process.exitCode = 1;
  }
}
