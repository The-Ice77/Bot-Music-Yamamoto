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
const LAVALINK_READY_TIMEOUT_MS = 120_000;
const LAVALINK_PROBE_INTERVAL_MS = 2_000;
const LAVALINK_RESTART_DELAY_MS = 5_000;

const LAVALINK_ERROR_PATTERN = /ERROR|Exception|OutOfMemory/;
const LAVALINK_INFO_PATTERN = /Lavalink is ready|Started Launcher|WARN|Found plugin|Loaded '/;

function attachLineLogger(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) {
    return;
  }
  let remainder = '';
  stream.on('data', (chunk: Buffer | string) => {
    remainder += chunk.toString();
    const lines = remainder.split(/\r?\n/);
    remainder = lines.pop() ?? '';
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed) {
        onLine(trimmed);
      }
    }
  });
  stream.on('end', () => {
    const trimmed = remainder.trim();
    remainder = '';
    if (trimmed) {
      onLine(trimmed);
    }
  });
}

function logLavalinkStdoutLine(line: string, logger: AppLogger): void {
  if (LAVALINK_ERROR_PATTERN.test(line)) {
    logger.error({ lavalink: line }, 'Lavalink error');
    return;
  }
  if (LAVALINK_INFO_PATTERN.test(line)) {
    if (line.includes('WARN')) {
      logger.warn({ lavalink: line }, 'Lavalink warn');
      return;
    }
    logger.info({ lavalink: line }, 'Lavalink stdout');
    return;
  }
  logger.debug({ lavalink: line }, 'Lavalink stdout');
}

function probeLavalinkVersion(port: number, password: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/version',
        headers: { Authorization: password },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('Tempo esgotado ao consultar /version do Lavalink'));
    });
    req.on('error', reject);
  });
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function waitForLavalinkReady(
  env: EnvConfig,
  child: ChildProcess,
  logger: AppLogger,
  timeoutMs = LAVALINK_READY_TIMEOUT_MS,
  shutdownSignal?: AbortSignal,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || shutdownSignal?.aborted) {
    return false;
  }

  const waitAbort = new AbortController();
  let exitedEarly = false;

  const handleEarlyStop = () => {
    exitedEarly = true;
    waitAbort.abort();
  };
  const handleShutdownAbort = () => {
    waitAbort.abort();
  };

  child.once('exit', handleEarlyStop);
  child.once('error', handleEarlyStop);
  shutdownSignal?.addEventListener('abort', handleShutdownAbort, { once: true });

  const deadline = Date.now() + timeoutMs;
  logger.info(
    { port: env.LAVALINK_PORT, timeoutMs },
    'Aguardando Lavalink embutido ficar pronto antes de conectar o bot...',
  );

  try {
    while (!exitedEarly && !waitAbort.signal.aborted) {
      try {
        const status = await probeLavalinkVersion(env.LAVALINK_PORT, env.LAVALINK_PASSWORD);
        if (status === 200) {
          logger.info(
            { port: env.LAVALINK_PORT },
            'Lavalink embutido respondeu /version (200 OK); iniciando cliente Discord...',
          );
          return true;
        }
      } catch {
        // Lavalink ainda está iniciando; aguarda o próximo ciclo de verificação.
      }

      if (exitedEarly || waitAbort.signal.aborted) {
        break;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      await sleepAbortable(Math.min(LAVALINK_PROBE_INTERVAL_MS, remaining), waitAbort.signal);
    }
  } finally {
    child.removeListener('exit', handleEarlyStop);
    child.removeListener('error', handleEarlyStop);
    shutdownSignal?.removeEventListener('abort', handleShutdownAbort);
  }

  if (exitedEarly) {
    logger.warn('Processo Lavalink embutido encerrou antes de ficar pronto');
  } else if (!shutdownSignal?.aborted) {
    logger.warn(
      { port: env.LAVALINK_PORT, timeoutMs },
      'Tempo limite atingido aguardando Lavalink embutido; iniciando bot com reconexão automática',
    );
  }

  return false;
}

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

function startEmbeddedLavalinkIfPresent(
  env: EnvConfig,
  logger: AppLogger,
  onUnexpectedExit?: () => void,
): ChildProcess | null {
  const isLocalHost =
    env.LAVALINK_HOST === '127.0.0.1' || env.LAVALINK_HOST.toLowerCase() === 'localhost';
  if (!isLocalHost || !fs.existsSync(EMBEDDED_LAVALINK_JAR)) {
    return null;
  }

  logger.info('Iniciando Lavalink v4.2.2 embutido no mesmo container...');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LAVALINK_SERVER_PASSWORD: env.LAVALINK_PASSWORD,
  };
  delete childEnv.PORT;

  const child = spawn(
    'java',
    [
      '-Xms64M',
      '-Xmx256M',
      '-XX:+UseSerialGC',
      `-Dserver.port=${env.LAVALINK_PORT}`,
      '-Dserver.address=127.0.0.1',
      '-jar',
      EMBEDDED_LAVALINK_JAR,
    ],
    {
      cwd: EMBEDDED_LAVALINK_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  attachLineLogger(child.stdout, (line) => {
    logLavalinkStdoutLine(line, logger);
  });

  attachLineLogger(child.stderr, (line) => {
    logger.warn({ lavalink: line }, 'Lavalink stderr');
  });

  child.on('error', (error) => {
    logger.error({ err: error }, 'Erro no processo Lavalink embutido');
  });

  child.on('exit', (code, signal) => {
    logger.warn({ code, signal }, 'Processo Lavalink embutido encerrado');
    onUnexpectedExit?.();
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

  let shuttingDown = false;
  let lavalinkRespawnTimer: NodeJS.Timeout | null = null;
  let embeddedLavalink: ChildProcess | null = null;
  const startupAbort = new AbortController();

  const scheduleLavalinkRespawn = () => {
    if (shuttingDown || lavalinkRespawnTimer !== null) {
      return;
    }
    logger.warn(
      { delayMs: LAVALINK_RESTART_DELAY_MS },
      'Lavalink embutido caiu; reiniciando automaticamente...',
    );
    lavalinkRespawnTimer = setTimeout(() => {
      lavalinkRespawnTimer = null;
      if (shuttingDown) {
        return;
      }
      embeddedLavalink = startEmbeddedLavalinkIfPresent(env, logger, scheduleLavalinkRespawn);
    }, LAVALINK_RESTART_DELAY_MS);
  };

  embeddedLavalink = startEmbeddedLavalinkIfPresent(env, logger, scheduleLavalinkRespawn);
  const bot = buildBot(env, { logger });

  const cleanupExtras = () => {
    shuttingDown = true;
    startupAbort.abort();
    if (lavalinkRespawnTimer !== null) {
      clearTimeout(lavalinkRespawnTimer);
      lavalinkRespawnTimer = null;
    }
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
    if (embeddedLavalink) {
      await waitForLavalinkReady(
        env,
        embeddedLavalink,
        logger,
        LAVALINK_READY_TIMEOUT_MS,
        startupAbort.signal,
      );
    }
    if (shuttingDown) {
      return bot;
    }
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
