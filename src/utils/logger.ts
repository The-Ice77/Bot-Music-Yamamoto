import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { EnvConfig } from '../config/env.js';

export type AppLogger = Logger;

const REDACT_PATHS = [
  'token',
  'password',
  'authorization',
  'clientSecret',
  'spDc',
  '*.token',
  '*.password',
  '*.authorization',
  '*.clientSecret',
  '*.spDc',
];

/**
 * Creates a Pino logger with automatic redaction for secret fields.
 * Enables pino-pretty formatting only outside production when no explicit destination is passed.
 */
export function createLogger(
  level: EnvConfig['LOG_LEVEL'],
  destination?: DestinationStream,
): AppLogger {
  const options: LoggerOptions = {
    level,
    redact: REDACT_PATHS,
  };

  if (destination) {
    return pino(options, destination);
  }

  if (process.env.NODE_ENV !== 'production') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
      },
    };
  }

  return pino(options);
}
