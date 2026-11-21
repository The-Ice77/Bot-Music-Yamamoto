import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { createBot, type BotRuntime } from './bot/createBot.js';
import { loadEnv, type EnvConfig } from './config/env.js';
import { createLogger, type AppLogger } from './utils/logger.js';

const EMBEDDED_LAVALINK_DIR = '/opt/Lavalink';
const EMBEDDED_LAVALINK_JAR = '/opt/Lavalink/Lavalink.jar';

function startCloudHealthServer(logger: AppLogger): http.Server | null {
  const rawPort = process.env.PORT?.trim();
  if (!rawPort) {
    return null;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', service: 'discord-music-bot' }));
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Servidor HTTP de healthcheck (nuvem 24/7) ativo');
  });

  return server;
}

function startEmbeddedLavalinkIfPresent(env: EnvConfig, logger: AppLogger): ChildProcess | null {
  const isLocalHost =
    env.LAVALINK_HOST === '127.0.0.1' || env.LAVALINK_HOST.toLowerCase() === 'localhost';
  if (!isLocalHost || !fs.existsSync(EMBEDDED_LAVALINK_JAR)) {
    return null;
  }

  logger.info('Iniciando Lavalink v4.2.2 embutido no mesmo container...');
  const child = spawn(
    'java',
    ['-Xms64M', '-Xmx220M', '-XX:+UseSerialGC', '-jar', EMBEDDED_LAVALINK_JAR],
    {
      cwd: EMBEDDED_LAVALINK_DIR,
      env: {
        ...process.env,
        LAVALINK_SERVER_PASSWORD: env.LAVALINK_PASSWORD,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      logger.debug({ lavalink: line }, 'Lavalink stdout');
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      logger.warn({ lavalink: line }, 'Lavalink stderr');
    }
  });

  child.on('exit', (code, signal) => {
    logger.warn({ code, signal }, 'Processo Lavalink embutido encerrado');
  });

  return child;
}

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
  const healthServer = startCloudHealthServer(logger);
  const embeddedLavalink = startEmbeddedLavalinkIfPresent(env, logger);
  const bot = buildBot(env, { logger });

  const cleanupExtras = () => {
    if (healthServer) {
      healthServer.close();
    }
    if (embeddedLavalink && !embeddedLavalink.killed) {
      embeddedLavalink.kill('SIGTERM');
    }
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    cleanupExtras();
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
    cleanupExtras();
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
