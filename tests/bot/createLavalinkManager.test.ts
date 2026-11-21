import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
} from 'discord.js';
import type { LavalinkPlayer, LavalinkTrack, Player, Track } from 'lavalink-client';
import type { EnvConfig } from '../../src/config/env.ts';
import { openDatabase } from '../../src/db/database.ts';
import { GuildSettingsRepository } from '../../src/db/guildSettingsRepository.ts';
import { SessionStoreRepository } from '../../src/db/sessionStoreRepository.ts';
import { SqliteQueueStore } from '../../src/db/sqliteQueueStore.ts';
import { createLogger } from '../../src/utils/logger.ts';
import {
  MusicService,
  type GuildMessenger,
} from '../../src/music/musicService.ts';
import { buildControlButtons, type EditablePanelMessage, type PanelMessageRef } from '../../src/music/playerPanel.ts';
import { createLavalinkManager, MAIN_NODE_ID } from '../../src/bot/createLavalinkManager.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    DISCORD_TOKEN: 'disc-token',
    DISCORD_CLIENT_ID: 'client-1',
    DEV_GUILD_ID: undefined,
    LAVALINK_HOST: 'localhost',
    LAVALINK_PORT: 2333,
    LAVALINK_PASSWORD: 'secret',
    LAVALINK_SECURE: false,
    DATABASE_PATH: ':memory:',
    MAX_QUEUE_SIZE: 500,
    LOG_LEVEL: 'fatal',
    spotifyEnabled: true,
    ...overrides,
  };
}

function makeSilentLogger() {
  const stream = new PassThrough();
  return createLogger('fatal', stream);
}

function makeRawLavalinkTrack(id: string, title = `Track ${id}`): LavalinkTrack {
  return {
    encoded: `encoded-${id}`,
    info: {
      identifier: id,
      title,
      author: `Artist ${id}`,
      length: 210_000,
      artworkUrl: `https://img.example.com/${id}.jpg`,
      uri: `https://www.youtube.com/watch?v=${id}`,
      sourceName: 'youtube',
      isSeekable: true,
      isStream: false,
      isrc: null,
    },
    pluginInfo: {},
    userData: {
      requester: { id: 'user-1', tag: 'User#0001' },
    },
  };
}

function makeBuiltTrack(bridge: ReturnType<typeof createLavalinkManager>, id: string): Track {
  return bridge.lavalink.utils.buildTrack(makeRawLavalinkTrack(id), {
    id: 'user-1',
    tag: 'User#0001',
  });
}

function makeFakeClient(options: {
  ready?: boolean;
  guildsCache?: Map<string, unknown>;
  fetchGuild?: (guildId: string) => Promise<unknown>;
} = {}) {
  const guildsCache = options.guildsCache ?? new Map<string, unknown>();
  return {
    user: { id: 'client-1', username: 'MusicBot' },
    isReady: () => options.ready ?? true,
    guilds: {
      cache: guildsCache,
      fetch: options.fetchGuild ?? (async (guildId: string) => {
        const err = Object.assign(new Error('Unknown Guild'), { code: 10004 });
        if (!guildsCache.has(guildId)) {
          throw err;
        }
        return guildsCache.get(guildId);
      }),
    },
  } as unknown as Client;
}

class FakeMessenger implements GuildMessenger {
  sentMessages: Array<{ channelId: string; content: string }> = [];
  sentPanels: Array<{ channelId: string; ref: PanelMessageRef }> = [];
  disabledPanels: string[] = [];
  messages = new Map<string, EditablePanelMessage>();
  seq = 1;
  onSendMessage?: () => Promise<void>;

  async sendMessage(channelId: string, content: string): Promise<void> {
    if (this.onSendMessage) {
      await this.onSendMessage();
    }
    this.sentMessages.push({ channelId, content });
  }

  async sendNowPlayingPanel(channelId: string): Promise<PanelMessageRef> {
    const ref = { channelId, messageId: `panel-${this.seq++}` };
    this.sentPanels.push({ channelId, ref });
    this.messages.set(ref.messageId, {
      components: [buildControlButtons({ paused: false, repeatMode: 'off' })],
      edit: async () => {
        this.disabledPanels.push(ref.messageId);
      },
    });
    return ref;
  }

  async fetchPanelMessage(ref: PanelMessageRef): Promise<EditablePanelMessage | undefined> {
    return this.messages.get(ref.messageId);
  }
}

test('createLavalinkManager handles nodeManager#raw fresh ready microtask cleanup, sessionId update, and MusicService calls', async () => {
  const db = openDatabase(':memory:');
  const sessionStore = new SessionStoreRepository(db);
  const queueStore = new SqliteQueueStore(db);
  sessionStore.saveNodeSessionId(MAIN_NODE_ID, 'stale-session-0');

  const logger = makeSilentLogger();
  const client = makeFakeClient();
  const bridge = createLavalinkManager({
    client,
    env: makeEnv(),
    queueStore,
    sessionStore,
    logger,
  });

  const calls: string[] = [];
  const fakeMusicService = {
    handleNodeConnect: async (nodeId: string, sessionId: string | null | undefined) => {
      calls.push(`connect:${nodeId}:${sessionId}`);
    },
    handleFreshNodeSession: async (nodeId?: string, sessionId?: string) => {
      calls.push(`fresh:${nodeId}:${sessionId}`);
    },
  } as unknown as MusicService;

  bridge.bindEvents(fakeMusicService);

  const node = bridge.lavalink.nodeManager.getNode(MAIN_NODE_ID)!;
  Object.defineProperty(node, 'connected', { get: () => true, configurable: true });
  node.sessionId = 'stale-session-0';

  const stalePlayer = bridge.lavalink.createPlayer({
    guildId: 'g-stale',
    voiceChannelId: 'vc-old',
    textChannelId: 'tc-old',
  });
  stalePlayer.connected = true;

  let disconnectCalled = false;
  stalePlayer.disconnect = async () => {
    disconnectCalled = true;
    return stalePlayer;
  };
  let destroyCalledOnNode = false;
  node.destroyPlayer = async () => {
    destroyCalledOnNode = true;
  };

  // Emit raw op='ready', resumed=false and simulate lavalink-client assigning node.sessionId synchronously right after emit('raw')
  bridge.lavalink.nodeManager.emit('raw', node, {
    op: 'ready',
    resumed: false,
    sessionId: 'fresh-session-42',
  });
  node.sessionId = 'fresh-session-42';

  await delay(20);

  assert.equal(node.options.sessionId, 'fresh-session-42');
  assert.equal(bridge.lavalink.getPlayer('g-stale'), undefined);
  assert.equal(disconnectCalled, false);
  assert.equal(destroyCalledOnNode, false);
  assert.deepEqual(calls, [
    `connect:${MAIN_NODE_ID}:fresh-session-42`,
    `fresh:${MAIN_NODE_ID}:fresh-session-42`,
  ]);

  db.close();
});

test('createLavalinkManager handles nodeManager#resumed, rehydratePlayer, and queue.utils.sync', async () => {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  const sessionStore = new SessionStoreRepository(db);
  const queueStore = new SqliteQueueStore(db);
  const logger = makeSilentLogger();
  const client = makeFakeClient();

  const bridge = createLavalinkManager({
    client,
    env: makeEnv(),
    queueStore,
    sessionStore,
    logger,
  });

  const queuedTrack = makeBuiltTrack(bridge, 'queued-1');
  const prevTrack = makeBuiltTrack(bridge, 'prev-1');
  await queueStore.set('g-resumed', {
    current: null,
    tracks: [queuedTrack],
    previous: [prevTrack],
  });

  sessionStore.saveActivePlayer({
    guildId: 'g-resumed',
    voiceChannelId: 'vc-resumed',
    textChannelId: 'tc-resumed',
    repeatMode: 'queue',
    panelChannelId: 'tc-resumed',
    panelMessageId: 'panel-99',
  });

  const messenger = new FakeMessenger();
  const musicService = new MusicService({
    gateway: bridge.gateway,
    messenger,
    settingsRepo,
    sessionStore,
    queueStore,
    logger,
    spotifyEnabled: true,
    maxQueueSize: 500,
    rejoinStaggerMs: 0,
  });
  bridge.bindEvents(musicService);

  const node = bridge.lavalink.nodeManager.getNode(MAIN_NODE_ID)!;
  Object.defineProperty(node, 'connected', { get: () => true, configurable: true });
  let updateSessionArgs: { resuming?: boolean; timeout?: number } | null = null;
  node.updateSession = async (resuming, timeout) => {
    updateSessionArgs = { resuming, timeout };
    return null;
  };
  node.sessionId = 'resumed-session-7';

  const resumedLavalinkPlayer: LavalinkPlayer = {
    guildId: 'g-resumed',
    track: makeRawLavalinkTrack('now-1', 'Tocando Agora'),
    volume: 85,
    paused: true,
    voice: {
      token: 'v-tok',
      endpoint: 'voice.discord.gg',
      sessionId: 'v-sess',
      channelId: 'vc-resumed',
    },
    filters: {},
    state: {
      time: Date.now(),
      position: 12_000,
      connected: true,
      ping: 15,
    },
  };

  bridge.lavalink.nodeManager.emit(
    'resumed',
    node,
    { op: 'ready', resumed: true, sessionId: 'resumed-session-7' },
    [resumedLavalinkPlayer],
  );

  await delay(30);

  assert.equal(node.options.sessionId, 'resumed-session-7');
  assert.deepEqual(updateSessionArgs, { resuming: true, timeout: 60 });
  assert.equal(sessionStore.getNodeSessionId(MAIN_NODE_ID), 'resumed-session-7');

  const rehydrated = bridge.lavalink.getPlayer('g-resumed');
  assert.ok(rehydrated);
  assert.equal(rehydrated.connected, true);
  assert.equal(rehydrated.paused, true);
  assert.equal(rehydrated.repeatMode, 'queue');
  assert.equal(rehydrated.voiceChannelId, 'vc-resumed');
  assert.equal(rehydrated.textChannelId, 'tc-resumed');
  assert.equal(rehydrated.queue.current?.info.title, 'Tocando Agora');
  assert.equal(rehydrated.queue.current?.info.duration, 210_000);
  assert.equal(rehydrated.queue.tracks.length, 1);
  assert.equal(rehydrated.queue.tracks[0].info.title, 'Track queued-1');
  assert.equal(rehydrated.queue.previous.length, 1);
  assert.deepEqual(rehydrated.voice, {
    token: 'v-tok',
    endpoint: 'voice.discord.gg',
    sessionId: 'v-sess',
    channelId: 'vc-resumed',
  });

  // Also ensure rehydratePlayer works cleanly when queueStore has no stored queue row (idle 24/7)
  const idlePlayer = await bridge.gateway.rehydratePlayer({
    guildId: 'g-idle',
    voiceChannelId: 'vc-idle',
    textChannelId: 'tc-idle',
    volume: 80,
    paused: false,
    repeatMode: 'off',
    currentTrack: null,
  });
  assert.ok(idlePlayer);
  assert.equal(idlePlayer.playing, false);
  assert.equal(idlePlayer.queue.tracks.length, 0);

  db.close();
});

test('createLavalinkManager coordinates pendingAutoAdvance on 1st/2nd trackError/trackStuck and trips circuit breaker on 3rd failure', async () => {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  const sessionStore = new SessionStoreRepository(db);
  const queueStore = new SqliteQueueStore(db);
  const logger = makeSilentLogger();
  const client = makeFakeClient();

  const bridge = createLavalinkManager({
    client,
    env: makeEnv(),
    queueStore,
    sessionStore,
    logger,
  });

  const messenger = new FakeMessenger();
  const musicService = new MusicService({
    gateway: bridge.gateway,
    messenger,
    settingsRepo,
    sessionStore,
    queueStore,
    logger,
    spotifyEnabled: true,
    maxQueueSize: 500,
    rejoinStaggerMs: 0,
  });
  bridge.bindEvents(musicService);

  const node = bridge.lavalink.nodeManager.getNode(MAIN_NODE_ID)!;
  Object.defineProperty(node, 'connected', { get: () => true, configurable: true });
  node.sessionId = 'sess-cb';

  const player = bridge.lavalink.createPlayer({
    guildId: 'g-cb',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    volume: 80,
  });
  player.connected = true;
  player.playing = true;

  const t1 = makeBuiltTrack(bridge, '1');
  const t2 = makeBuiltTrack(bridge, '2');
  const t3 = makeBuiltTrack(bridge, '3');
  const t4 = makeBuiltTrack(bridge, '4');
  player.queue.current = t1;
  player.queue.tracks.push(t2, t3, t4);

  let skipCalls = 0;
  let stopPlayingCalls = 0;
  let destroyCalls = 0;

  player.skip = async () => {
    skipCalls += 1;
    return player;
  };
  player.stopPlaying = async (clearQueue = true) => {
    stopPlayingCalls += 1;
    if (clearQueue) {
      player.queue.tracks.splice(0, player.queue.tracks.length);
    }
    player.queue.current = null;
    player.playing = false;
    return player;
  };
  player.disconnect = async () => player;
  player.node.destroyPlayer = async () => {};
  const origDestroy = player.destroy.bind(player);
  player.destroy = async (reason, disconnect) => {
    destroyCalls += 1;
    return origDestroy(reason, disconnect);
  };

  // Failure 1 (trackError): simulate lavalink-client shifting queue during async sendMessage
  messenger.onSendMessage = async () => {
    player.queue.current = player.queue.tracks.shift() ?? null;
    await delay(5);
  };
  bridge.lavalink.emit('trackError', player, t1, {
    type: 'TrackExceptionEvent',
    guildId: 'g-cb',
    track: makeRawLavalinkTrack('1'),
    exception: { message: 'Boom 1', severity: 'COMMON', cause: 'test' },
  } as never);
  await delay(25);

  assert.equal(skipCalls, 0);
  assert.equal(stopPlayingCalls, 0);
  assert.equal(player.queue.current?.info.identifier, '2');
  assert.equal(messenger.sentMessages.length, 1);

  // Failure 2 (trackStuck): simulate queue dropping to 0 queued tracks after shift while sendMessage awaits
  player.queue.tracks.splice(0, player.queue.tracks.length, t3);
  messenger.onSendMessage = async () => {
    player.queue.current = player.queue.tracks.shift() ?? null;
    await delay(5);
  };
  bridge.lavalink.emit('trackStuck', player, t2, {
    type: 'TrackStuckEvent',
    guildId: 'g-cb',
    track: makeRawLavalinkTrack('2'),
    thresholdMs: 5000,
  } as never);
  await delay(25);

  // pendingAutoAdvance prevented premature stopPlaying even though real tracks became empty after shift
  assert.equal(skipCalls, 0);
  assert.equal(stopPlayingCalls, 0);
  assert.equal(player.queue.current?.info.identifier, '3');
  assert.equal(messenger.sentMessages.length, 2);

  // Failure 3 (trackError): circuit breaker trips -> stopPlaying(true, false) + destroy/disconnect
  player.queue.tracks.push(t4);
  messenger.onSendMessage = undefined;
  bridge.lavalink.emit('trackError', player, t3, {
    type: 'TrackExceptionEvent',
    guildId: 'g-cb',
    track: makeRawLavalinkTrack('3'),
    exception: { message: 'Boom 3', severity: 'FAULT', cause: 'test' },
  } as never);
  await delay(25);

  assert.equal(stopPlayingCalls, 1);
  assert.equal(destroyCalls, 1);
  assert.equal(player.queue.tracks.length, 0);
  assert.match(messenger.sentMessages[2].content, /Várias músicas falharam em sequência/);

  db.close();
});

test('createLavalinkManager normalizes Spotify URIs in search and minifies requester in requesterTransformer', async () => {
  const db = openDatabase(':memory:');
  const sessionStore = new SessionStoreRepository(db);
  const queueStore = new SqliteQueueStore(db);
  const logger = makeSilentLogger();
  const client = makeFakeClient();

  const bridge = createLavalinkManager({
    client,
    env: makeEnv(),
    queueStore,
    sessionStore,
    logger,
  });

  const node = bridge.lavalink.nodeManager.getNode(MAIN_NODE_ID)!;
  Object.defineProperty(node, 'connected', { get: () => true });
  node.sessionId = 'sess-search';

  const searchCalls: Array<{ query: unknown; requester: unknown }> = [];
  node.search = async (query, requester) => {
    searchCalls.push({ query, requester });
    return {
      loadType: 'track',
      exception: null,
      pluginInfo: {},
      playlist: null,
      tracks: [makeBuiltTrack(bridge, 'sp-1')],
    };
  };

  await bridge.gateway.search(
    'g1',
    { query: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' },
    { id: 'u1', tag: 'User#1', username: 'user' },
  );
  await bridge.gateway.search(
    'g1',
    { query: 'spotify:album:123ABC' },
    { id: 'u1' },
  );
  await bridge.gateway.search(
    'g1',
    { query: 'evidências', source: 'ytmsearch' },
    { id: 'u1' },
  );

  assert.deepEqual(searchCalls[0].query, {
    query: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
  });
  assert.deepEqual(searchCalls[1].query, {
    query: 'https://open.spotify.com/album/123ABC',
  });
  assert.deepEqual(searchCalls[2].query, {
    query: 'evidências',
    source: 'ytmsearch',
  });

  const transformer = bridge.lavalink.options.playerOptions?.requesterTransformer;
  assert.equal(typeof transformer, 'function');
  const transformed = transformer!({
    id: 'user-99',
    tag: 'User#0099',
    username: 'user99',
    client: { token: 'secret-should-not-remain' },
    guilds: ['huge-cache'],
  });
  assert.deepEqual(transformed, {
    id: 'user-99',
    tag: 'User#0099',
    username: 'user99',
  });

  db.close();
});

test('createLavalinkManager.gateway.validateVoiceChannel maps Discord error codes vs transient errors accurately', async () => {
  const db = openDatabase(':memory:');
  const sessionStore = new SessionStoreRepository(db);
  const queueStore = new SqliteQueueStore(db);
  const logger = makeSilentLogger();

  const guildsCache = new Map<string, unknown>();
  let fetchGuildImpl: (guildId: string) => Promise<unknown> = async () => {
    throw Object.assign(new Error('Unknown Guild'), { code: 10004 });
  };

  const client = makeFakeClient({
    guildsCache,
    fetchGuild: (guildId) => fetchGuildImpl(guildId),
  });

  const bridge = createLavalinkManager({
    client,
    env: makeEnv(),
    queueStore,
    sessionStore,
    logger,
  });

  // 10004 -> GUILD_NOT_FOUND
  assert.deepEqual(await bridge.gateway.validateVoiceChannel('missing-guild', 'vc-1'), {
    ok: false,
    reason: 'GUILD_NOT_FOUND',
  });

  // 50001 on guilds.fetch -> GUILD_NOT_FOUND
  fetchGuildImpl = async () => {
    throw Object.assign(new Error('Missing Access'), { code: 50001 });
  };
  assert.deepEqual(await bridge.gateway.validateVoiceChannel('forbidden-guild', 'vc-1'), {
    ok: false,
    reason: 'GUILD_NOT_FOUND',
  });

  // Transient error on guilds.fetch -> TRANSIENT_ERROR
  fetchGuildImpl = async () => {
    throw new Error('ECONNRESET');
  };
  const transientGuild = await bridge.gateway.validateVoiceChannel('flaky-guild', 'vc-1');
  assert.equal(transientGuild.ok, false);
  assert.equal(!transientGuild.ok && transientGuild.reason, 'TRANSIENT_ERROR');

  // Guild present in cache with customizable channels.fetch + members.fetchMe
  let fetchChannelImpl: (id: string) => Promise<unknown> = async () => {
    throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
  };
  let fetchMeImpl: () => Promise<unknown> = async () => ({
    id: 'bot-1',
    user: { bot: true },
  });

  const fakeGuild = {
    id: 'g1',
    channels: {
      cache: new Map<string, unknown>(),
      fetch: (id: string) => fetchChannelImpl(id),
    },
    members: {
      me: null as unknown,
      fetchMe: () => fetchMeImpl(),
    },
  };
  guildsCache.set('g1', fakeGuild);

  // 10003 -> CHANNEL_NOT_FOUND
  assert.deepEqual(await bridge.gateway.validateVoiceChannel('g1', 'vc-missing'), {
    ok: false,
    reason: 'CHANNEL_NOT_FOUND',
  });

  // 50013 on channels.fetch -> MISSING_PERMISSIONS
  fetchChannelImpl = async () => {
    throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
  };
  assert.deepEqual(await bridge.gateway.validateVoiceChannel('g1', 'vc-noperms'), {
    ok: false,
    reason: 'MISSING_PERMISSIONS',
  });

  // 50001 on channels.fetch -> MISSING_PERMISSIONS
  fetchChannelImpl = async () => {
    throw Object.assign(new Error('Missing Access'), { code: 50001 });
  };
  assert.deepEqual(await bridge.gateway.validateVoiceChannel('g1', 'vc-noaccess'), {
    ok: false,
    reason: 'MISSING_PERMISSIONS',
  });

  // Transient error on channels.fetch -> TRANSIENT_ERROR
  fetchChannelImpl = async () => {
    throw Object.assign(new Error('Service Unavailable'), { code: 503 });
  };
  const transientChannel = await bridge.gateway.validateVoiceChannel('g1', 'vc-flaky');
  assert.equal(transientChannel.ok, false);
  assert.equal(!transientChannel.ok && transientChannel.reason, 'TRANSIENT_ERROR');

  // Non-voice channel -> CHANNEL_NOT_FOUND
  fetchChannelImpl = async () => ({
    id: 'tc-1',
    type: ChannelType.GuildText,
    isVoiceBased: () => false,
  });
  assert.deepEqual(await bridge.gateway.validateVoiceChannel('g1', 'tc-1'), {
    ok: false,
    reason: 'CHANNEL_NOT_FOUND',
  });

  // Voice channel with 50001 on fetchMe -> MISSING_PERMISSIONS, transient -> TRANSIENT_ERROR
  fetchChannelImpl = async () => ({
    id: 'vc-1',
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () =>
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ]),
  });
  fetchMeImpl = async () => {
    throw Object.assign(new Error('Missing Access'), { code: 50001 });
  };
  assert.deepEqual(await bridge.gateway.validateVoiceChannel('g1', 'vc-1'), {
    ok: false,
    reason: 'MISSING_PERMISSIONS',
  });

  fetchMeImpl = async () => {
    throw new Error('ETIMEDOUT');
  };
  const transientMe = await bridge.gateway.validateVoiceChannel('g1', 'vc-1');
  assert.equal(transientMe.ok, false);
  assert.equal(!transientMe.ok && transientMe.reason, 'TRANSIENT_ERROR');

  // Missing Speak perm -> MISSING_PERMISSIONS
  fetchMeImpl = async () => ({ id: 'bot-1' });
  fetchChannelImpl = async () => ({
    id: 'vc-nospeak',
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () =>
      new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]),
  });
  const missingSpeak = await bridge.gateway.validateVoiceChannel('g1', 'vc-nospeak');
  assert.equal(missingSpeak.ok, false);
  assert.equal(!missingSpeak.ok && missingSpeak.reason, 'MISSING_PERMISSIONS');

  // Full perms -> { ok: true }
  fetchChannelImpl = async () => ({
    id: 'vc-ok',
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    permissionsFor: () =>
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ]),
  });
  assert.deepEqual(await bridge.gateway.validateVoiceChannel('g1', 'vc-ok'), { ok: true });

  db.close();
});
