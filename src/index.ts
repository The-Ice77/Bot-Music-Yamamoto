import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot, type BotRuntime } from './bot/createBot.js';
import { loadEnv } from './config/env.js';
import { createLogger, type AppLogger } from './utils/logger.js';

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
export async function main(): Promise<BotRuntime> {
  const env = loadEnv();
  const logger: AppLogger = createLogger(env.LOG_LEVEL);
  const bot = createBot(env, { logger });

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
  main().catch(() => {
    process.exitCode = 1;
  });
}
