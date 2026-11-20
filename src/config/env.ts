import { z } from 'zod';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface EnvConfig {
  DISCORD_TOKEN: string;
  DISCORD_CLIENT_ID: string;
  DEV_GUILD_ID?: string;
  LAVALINK_HOST: string;
  LAVALINK_PORT: number;
  LAVALINK_PASSWORD: string;
  LAVALINK_SECURE: boolean;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_SP_DC?: string;
  DATABASE_PATH: string;
  MAX_QUEUE_SIZE: number;
  LOG_LEVEL: LogLevel;
  spotifyEnabled: boolean;
}

function emptyToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}

const requiredString = z.string().trim().min(1);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

const envBoolean = z.preprocess((value) => {
  const normalized = emptyToUndefined(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (typeof normalized === 'boolean') {
    return normalized;
  }
  if (typeof normalized === 'string') {
    const lower = normalized.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return normalized;
}, z.boolean().default(false));

const positiveIntWithDefault = (defaultValue: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(defaultValue));

const envSchema = z.object({
  DISCORD_TOKEN: requiredString,
  DISCORD_CLIENT_ID: requiredString,
  DEV_GUILD_ID: optionalString,
  LAVALINK_HOST: requiredString,
  LAVALINK_PORT: positiveIntWithDefault(2333),
  LAVALINK_PASSWORD: requiredString,
  LAVALINK_SECURE: envBoolean,
  SPOTIFY_CLIENT_ID: optionalString,
  SPOTIFY_CLIENT_SECRET: optionalString,
  SPOTIFY_SP_DC: optionalString,
  DATABASE_PATH: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(1).default('./data/bot.sqlite'),
  ),
  MAX_QUEUE_SIZE: positiveIntWithDefault(500),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ),
});

/**
 * Validates and normalizes process environment variables into a typed configuration object.
 */
export function loadEnv(rawEnv: NodeJS.ProcessEnv = process.env): EnvConfig {
  const parsed = envSchema.parse(rawEnv);
  return {
    ...parsed,
    spotifyEnabled: Boolean(parsed.SPOTIFY_CLIENT_ID && parsed.SPOTIFY_CLIENT_SECRET),
  };
}
