import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayIntentBits, type VoiceState } from 'discord.js';
import { loadEnv, type EnvConfig } from '../../src/config/env.ts';
import { openDatabase } from '../../src/db/database.ts';
import { SessionStoreRepository } from '../../src/db/sessionStoreRepository.ts';
import { SqliteQueueStore } from '../../src/db/sqliteQueueStore.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { MusicService } from '../../src/music/musicService.ts';
import { createBot } from '../../src/bot/createBot.ts';
import { MAIN_NODE_ID } from '../../src/bot/createLavalinkManager.ts';
import { handleVoiceStateUpdate } from '../../src/bot/voiceStateHandler.ts';
import { main } from '../../src/index.ts';

function makeLogger() {
  const stream = new PassThrough();
  return createLogger('fatal', stream);
}

interface FakeMember {
  id: string;
  user: { bot: boolean };
}

function makeVoiceChannel(id: string, membersList: FakeMember[]) {
  return {
    id,
    members: new Map(membersList.map((m) => [m.id, m])),
  };
}

function makeVoiceState(options: {
  guildId?: string;
  userId: string;
  isBot?: boolean;
  channelId: string | null;
  channel?: ReturnType<typeof makeVoiceChannel> | null;
  botChannelId?: string | null;
  botChannel?: ReturnType<typeof makeVoiceChannel> | null;
  botUserId?: string;
}): VoiceState {
  const guildId = options.guildId ?? 'g1';
  const botUserId = options.botUserId ?? 'bot-1';
  const channelsCache = new Map<string, ReturnType<typeof makeVoiceChannel>>();

  if (options.channel) {
    channelsCache.set(options.channel.id, options.channel);
  }
  if (options.botChannel) {
    channelsCache.set(options.botChannel.id, options.botChannel);
  }

  return {
    id: options.userId,
    channelId: options.channelId,
    channel: options.channel ?? null,
    client: {
      user: { id: botUserId },
    },
    member: {
      id: options.userId,
      user: { bot: options.isBot ?? false },
    },
    guild: {
      id: guildId,
      channels: { cache: channelsCache },
      members: {
        me: {
          id: botUserId,
          voice: {
            channelId: options.botChannelId ?? options.botChannel?.id ?? null,
            channel: options.botChannel ?? null,
          },
        },
      },
    },
  } as unknown as VoiceState;
}

function createMusicServiceSpy() {
  const calls: Array<{ method: string; guildId: string }> = [];
  const service = {
    handleVoiceDisconnect: async (guildId: string) => {
      calls.push({ method: 'handleVoiceDisconnect', guildId });
    },
    handleVoiceChannelEmpty: async (guildId: string) => {
      calls.push({ method: 'handleVoiceChannelEmpty', guildId });
    },
    handleVoiceHumanJoined: async (guildId: string) => {
      calls.push({ method: 'handleVoiceHumanJoined', guildId });
    },
  } as unknown as MusicService;

  return { service, calls };
}

test('handleVoiceStateUpdate calls handleVoiceDisconnect when bot itself leaves a voice channel', async () => {
  const { service, calls } = createMusicServiceSpy();
  const logger = makeLogger();

  const oldChannel = makeVoiceChannel('vc-1', [{ id: 'user-1', user: { bot: false } }]);
  const oldState = makeVoiceState({
    userId: 'bot-1',
    isBot: true,
    channelId: 'vc-1',
    channel: oldChannel,
    botChannelId: null,
  });
  const newState = makeVoiceState({
    userId: 'bot-1',
    isBot: true,
    channelId: null,
    channel: null,
    botChannelId: null,
  });

  await handleVoiceStateUpdate(oldState, newState, service, logger);

  assert.deepEqual(calls, [{ method: 'handleVoiceDisconnect', guildId: 'g1' }]);
});

test('handleVoiceStateUpdate calls handleVoiceChannelEmpty when last human leaves bot channel (ignoring other bots)', async () => {
  const { service, calls } = createMusicServiceSpy();
  const logger = makeLogger();

  // Bot + another bot remain in vc-1, zero non-bot humans remain
  const botChannel = makeVoiceChannel('vc-1', [
    { id: 'bot-1', user: { bot: true } },
    { id: 'other-bot-2', user: { bot: true } },
  ]);

  const oldState = makeVoiceState({
    userId: 'user-1',
    isBot: false,
    channelId: 'vc-1',
    channel: botChannel,
    botChannel,
  });
  const newState = makeVoiceState({
    userId: 'user-1',
    isBot: false,
    channelId: null,
    channel: null,
    botChannel,
  });

  await handleVoiceStateUpdate(oldState, newState, service, logger);

  assert.deepEqual(calls, [{ method: 'handleVoiceChannelEmpty', guildId: 'g1' }]);
});

test('handleVoiceStateUpdate does NOT call handleVoiceChannelEmpty when at least one human remains in bot channel', async () => {
  const { service, calls } = createMusicServiceSpy();
  const logger = makeLogger();

  const botChannel = makeVoiceChannel('vc-1', [
    { id: 'bot-1', user: { bot: true } },
    { id: 'user-2', user: { bot: false } },
  ]);

  const oldState = makeVoiceState({
    userId: 'user-1',
    isBot: false,
    channelId: 'vc-1',
    channel: botChannel,
    botChannel,
  });
  const newState = makeVoiceState({
    userId: 'user-1',
    isBot: false,
    channelId: null,
    channel: null,
    botChannel,
  });

  await handleVoiceStateUpdate(oldState, newState, service, logger);

  assert.deepEqual(calls, []);
});

test('handleVoiceStateUpdate calls handleVoiceHumanJoined when a human joins bot channel and ignores other bots', async () => {
  const { service, calls } = createMusicServiceSpy();
  const logger = makeLogger();

  const botChannel = makeVoiceChannel('vc-1', [
    { id: 'bot-1', user: { bot: true } },
    { id: 'user-1', user: { bot: false } },
  ]);

  // Human joins vc-1
  await handleVoiceStateUpdate(
    makeVoiceState({
      userId: 'user-1',
      isBot: false,
      channelId: null,
      channel: null,
      botChannel,
    }),
    makeVoiceState({
      userId: 'user-1',
      isBot: false,
      channelId: 'vc-1',
      channel: botChannel,
      botChannel,
    }),
    service,
    logger,
  );

  // Another bot joins vc-1 -> should be ignored
  await handleVoiceStateUpdate(
    makeVoiceState({
      userId: 'other-bot-2',
      isBot: true,
      channelId: null,
      channel: null,
      botChannel,
    }),
    makeVoiceState({
      userId: 'other-bot-2',
      isBot: true,
      channelId: 'vc-1',
      channel: botChannel,
      botChannel,
    }),
    service,
    logger,
  );

  // Same-channel mute/deaf update -> should be ignored
  await handleVoiceStateUpdate(
    makeVoiceState({
      userId: 'user-1',
      isBot: false,
      channelId: 'vc-1',
      channel: botChannel,
      botChannel,
    }),
    makeVoiceState({
      userId: 'user-1',
      isBot: false,
      channelId: 'vc-1',
      channel: botChannel,
      botChannel,
    }),
    service,
    logger,
  );

  assert.deepEqual(calls, [{ method: 'handleVoiceHumanJoined', guildId: 'g1' }]);
});

test('createBot wires minimal intents, Lavalink options, raw forwarding, Spotify warning, single disconnect source, and graceful shutdown', async () => {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk) => chunks.push(chunk.toString()));
  const logger = createLogger('warn', stream);

  const db = openDatabase(':memory:');
  const preSessionStore = new SessionStoreRepository(db);
  preSessionStore.saveNodeSessionId(MAIN_NODE_ID, 'persisted-sess-99');

  const env: EnvConfig = {
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: 'bot-client-id',
    DEV_GUILD_ID: undefined,
    LAVALINK_HOST: 'lavalink',
    LAVALINK_PORT: 2333,
    LAVALINK_PASSWORD: 'lavalink-password',
    LAVALINK_SECURE: false,
    DATABASE_PATH: ':memory:',
    MAX_QUEUE_SIZE: 500,
    LOG_LEVEL: 'warn',
    spotifyEnabled: false,
  };

  const bot = createBot(env, { logger, db });

  // Strictly only Guilds and GuildVoiceStates (never MessageContent)
  assert.equal(
    bot.client.options.intents.bitfield,
    GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates,
  );
  assert.equal(bot.client.options.intents.has(GatewayIntentBits.MessageContent), false);

  // LavalinkManager configuration matches spec
  const firstNode = bot.lavalink.options.nodes[0] as {
    id?: string;
    sessionId?: string;
    retryAmount?: number;
    retryDelay?: number;
  };
  assert.equal(firstNode.id, MAIN_NODE_ID);
  assert.equal(firstNode.sessionId, 'persisted-sess-99');
  assert.equal(firstNode.retryAmount, 100);
  assert.equal(firstNode.retryDelay, 5_000);
  assert.equal(bot.lavalink.options.playerOptions?.onDisconnect?.autoReconnect, false);
  assert.equal(bot.lavalink.options.playerOptions?.onEmptyQueue?.autoPlayFunction, null);
  assert.equal(bot.lavalink.options.queueOptions?.queueStore instanceof SqliteQueueStore, true);

  // Raw packet forwarding reaches lavalink.sendRawData
  const rawPackets: unknown[] = [];
  bot.lavalink.sendRawData = async (packet) => {
    rawPackets.push(packet);
  };
  bot.client.emit('raw' as never, { t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1' } } as never);
  assert.equal(rawPackets.length, 1);

  // playerDisconnect does NOT double-fire handleVoiceDisconnect (voiceStateUpdate is single source)
  let disconnectCalls = 0;
  bot.musicService.handleVoiceDisconnect = async () => {
    disconnectCalls += 1;
  };
  bot.lavalink.emit('playerDisconnect', { guildId: 'g1' } as never, 'vc-1');
  assert.equal(disconnectCalls, 0);

  // Boot warns when Spotify credentials are missing without failing
  bot.client.login = async () => 'mock-token';
  await bot.start();
  assert.match(chunks.join(''), /Spotify/i);

  // Graceful shutdown cancels timers, destroys Discord client, closes SQLite, never destroys players
  let destroyPlayerCalled = false;
  bot.lavalink.destroyPlayer = async () => {
    destroyPlayerCalled = true;
  };
  let shutdownGracefullyCalled = false;
  const origShutdownGracefully = bot.musicService.shutdownGracefully.bind(bot.musicService);
  bot.musicService.shutdownGracefully = async () => {
    shutdownGracefullyCalled = true;
    await origShutdownGracefully();
  };

  await bot.shutdown('SIGTERM');
  assert.equal(shutdownGracefullyCalled, true);
  assert.equal(destroyPlayerCalled, false);
  assert.throws(() => db.prepare('SELECT 1').get());
});

test('main logs safe startup validation errors to stderr without leaking secrets', async () => {
  const stderrLines: string[] = [];

  await assert.rejects(() =>
    main({
      loadEnv: () =>
        loadEnv({
          LAVALINK_PASSWORD: 'secret-lavalink-do-not-leak',
          SPOTIFY_CLIENT_SECRET: 'secret-spotify-do-not-leak',
        }),
      writeStderr: (line) => stderrLines.push(line),
    }),
  );

  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0], /DISCORD_TOKEN/);
  assert.equal(stderrLines[0].includes('secret-lavalink-do-not-leak'), false);
  assert.equal(stderrLines[0].includes('secret-spotify-do-not-leak'), false);

  // Direct execution check: missing env vars exit with code 1 and write non-empty stderr without secrets
  const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const child = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/index.ts'],
    {
      cwd: worktreeRoot,
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        LAVALINK_PASSWORD: 'secret-direct-run-password',
      },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );

  assert.equal(child.status, 1);
  assert.match(child.stderr, /DISCORD_TOKEN/);
  assert.equal(child.stderr.includes('secret-direct-run-password'), false);
});


