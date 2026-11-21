import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { createBot, type BotRuntime } from './bot/createBot.js';
import { loadEnv, type EnvConfig } from './config/env.js';
import { createLogger, type AppLogger } from './utils/logger.js';

export interface MainDeps {
  loadEnv?: () => EnvConfig;
  createLogger?: typeof createLogger;
  createBot?: typeof createBot;
  writeStderr?: (message: string) => void;
}

/**
 * Formats startup/env errors safely without dumping raw environment secrets.
 */
export function formatStartupError(error: unknown): string {
  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    return `Configuração de ambiente inválida: ${details}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

/**
 * Loads validated environment config, wires process signal/error handlers, and starts the bot.
 */
export async function main(deps: MainDeps = {}): Promise<BotRuntime> {
  const resolveEnv = deps.loadEnv ?? loadEnv;
  const buildLogger = deps.createLogger ?? createLogger;
  const buildBot = deps.createBot ?? createBot;
  const writeStderr = deps.writeStderr ?? ((msg: string) => {
    process.stderr.write(`${msg}\n`);
  });

  let env: EnvConfig;
  try {
    env = resolveEnv();
  } catch (error) {
    writeStderr(`Falha ao validar configuração de inicialização: ${formatStartupError(error)}`);
    throw error;
  }

  const logger: AppLogger = buildLogger(env.LOG_LEVEL);
  const bot = buildBot(env, { logger });

  const handleSignal = (signal: NodeJS.Signals) => {
    void bot
      .shutdown(signal)
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        logger.error({ err: error, signal }, 'Erro durante encerramento gracioso');
        process.exit(1);
      });
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'Uncaught exception');
  });

  try {
    await bot.start();
    return bot;
  } catch (error) {
    logger.fatal({ err: error }, 'Falha fatal ao iniciar o bot');
    await bot.shutdown('startup_failure');
    throw error;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    if (!(error instanceof ZodError)) {
      process.stderr.write(`Falha fatal na inicialização: ${formatStartupError(error)}\n`);
    }
    process.exitCode = 1;
  });
}
