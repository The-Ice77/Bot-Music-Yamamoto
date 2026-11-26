import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { openDatabase } from '../../src/db/database.ts';
import { GuildSettingsRepository } from '../../src/db/guildSettingsRepository.ts';
import { SessionStoreRepository } from '../../src/db/sessionStoreRepository.ts';
import { SqliteQueueStore } from '../../src/db/sqliteQueueStore.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { buildControlButtons, type EditablePanelMessage, type PanelMessageRef } from '../../src/music/playerPanel.ts';
import {
  LAVALINK_RESUME_TIMEOUT_SECONDS,
  MusicService,
  type CreatePlayerOptions,
  type GatewayPlayer,
  type GatewaySearchQuery,
  type GatewaySearchResult,
  type GatewayTrack,
  type GuildMessenger,
  type LavalinkGateway,
  type NowPlayingPanelPayload,
  type RehydratePlayerOptions,
  type RepeatMode,
  type VoiceChannelCheckResult,
} from '../../src/music/musicService.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTrack(id: string, title = `Track ${id}`, duration = 180_000): GatewayTrack {
  return {
    encoded: `enc-${id}`,
    info: {
      identifier: id,
      title,
      author: `Artist ${id}`,
      duration,
      uri: `https://www.youtube.com/watch?v=${id}`,
      artworkUrl: `https://img.example.com/${id}.jpg`,
      isStream: false,
    },
    requester: { id: 'user-1', tag: 'User#0001' },
  };
}

class FakePlayer implements GatewayPlayer {
  guildId: string;
  voiceChannelId: string | null;
  textChannelId: string | null;
  playing = false;
  paused = false;
  volume: number;
  position = 0;
  repeatMode: RepeatMode = 'off';
  connected = false;
  connectCalls = 0;
  playCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  skipCalls: number[] = [];
  stopPlayingCalls: Array<{ clearQueue: boolean; executeAutoplay: boolean }> = [];
  setVolumeCalls: number[] = [];
  setRepeatModeCalls: RepeatMode[] = [];
  shuffleCalls = 0;
  readonly tracks: GatewayTrack[] = [];
  current: GatewayTrack | null = null;

  readonly queue = {
    get current(): GatewayTrack | null {
      return this.owner.current;
    },
    set current(value: GatewayTrack | null) {
      this.owner.current = value;
    },
    get tracks(): readonly GatewayTrack[] {
      return this.owner.tracks;
    },
    owner: null as unknown as FakePlayer,
    add: async (item: GatewayTrack | GatewayTrack[], index?: number) => {
      const items = Array.isArray(item) ? item : [item];
      if (typeof index === 'number' && index >= 0 && index < this.tracks.length) {
        this.tracks.splice(index, 0, ...items);
      } else {
        this.tracks.push(...items);
      }
      return this.tracks.length;
    },
    shuffle: async () => {
      this.shuffleCalls += 1;
      if (this.tracks.length > 1) {
        const first = this.tracks.shift()!;
        this.tracks.push(first);
      }
      return this.tracks.length;
    },
    splice: async (index: number, amount: number, item?: GatewayTrack | GatewayTrack[]) => {
      const insert = item === undefined ? [] : Array.isArray(item) ? item : [item];
      return this.tracks.splice(index, amount, ...insert);
    },
  };

  constructor(options: {
    guildId: string;
    voiceChannelId: string | null;
    textChannelId: string | null;
    volume: number;
  }) {
    this.guildId = options.guildId;
    this.voiceChannelId = options.voiceChannelId;
    this.textChannelId = options.textChannelId;
    this.volume = options.volume;
    this.queue.owner = this;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    if (!this.current && this.tracks.length > 0) {
      this.current = this.tracks.shift()!;
    }
    if (this.current) {
      this.playing = true;
      this.paused = false;
    }
  }

  async pause(): Promise<void> {
    this.pauseCalls += 1;
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.paused = false;
  }

  async skip(skipTo = 1): Promise<void> {
    this.skipCalls.push(skipTo);
    if (skipTo > this.tracks.length) {
      throw new RangeError("Can't skip more than the queue size");
    }
    if (skipTo > 1) {
      this.tracks.splice(0, skipTo - 1);
    }
    this.current = this.tracks.shift() ?? null;
    this.playing = this.current !== null;
    this.paused = false;
  }

  async stopPlaying(clearQueue = true, executeAutoplay = false): Promise<void> {
    this.stopPlayingCalls.push({ clearQueue, executeAutoplay });
    if (clearQueue) {
      this.tracks.length = 0;
    }
    this.current = null;
    this.playing = false;
    this.paused = false;
  }

  async setVolume(volume: number): Promise<void> {
    this.setVolumeCalls.push(volume);
    this.volume = volume;
  }

  async setRepeatMode(mode: RepeatMode): Promise<void> {
    this.setRepeatModeCalls.push(mode);
    this.repeatMode = mode;
  }

  async changeVoiceState(data: { voiceChannelId?: string }): Promise<void> {
    if (data.voiceChannelId) {
      this.voiceChannelId = data.voiceChannelId;
    }
  }
}

class FakeLavalinkGateway implements LavalinkGateway {
  connectedNode = true;
  discordReady = true;
  players = new Map<string, FakePlayer>();
  searchCalls: Array<{ guildId: string; query: GatewaySearchQuery; requester: unknown }> = [];
  searchHandler: (query: GatewaySearchQuery) => GatewaySearchResult | Promise<GatewaySearchResult> =
    () => ({
      loadType: 'track',
      tracks: [makeTrack('default-1')],
      playlist: null,
      exception: null,
    });
  updateSessionCalls: Array<{ nodeId: string; resuming: boolean; timeoutSeconds: number }> = [];
  destroyCalls: Array<{ guildId: string; reason?: string }> = [];
  rehydrateCalls: RehydratePlayerOptions[] = [];
  voiceChannelChecks = new Map<string, VoiceChannelCheckResult>();
  joinTimestamps: Array<{ guildId: string; at: number }> = [];

  hasConnectedNode(): boolean {
    return this.connectedNode;
  }

  isDiscordReady(): boolean {
    return this.discordReady;
  }

  getPlayer(guildId: string): FakePlayer | null {
    return this.players.get(guildId) ?? null;
  }

  async createPlayer(options: CreatePlayerOptions): Promise<FakePlayer> {
    this.joinTimestamps.push({ guildId: options.guildId, at: Date.now() });
    const player = new FakePlayer({
      guildId: options.guildId,
      voiceChannelId: options.voiceChannelId,
      textChannelId: options.textChannelId,
      volume: options.volume,
    });
    this.players.set(options.guildId, player);
    return player;
  }

  async destroyPlayer(guildId: string, reason?: string): Promise<void> {
    this.destroyCalls.push({ guildId, reason });
    const player = this.players.get(guildId);
    if (player) {
      player.connected = false;
    }
    this.players.delete(guildId);
  }

  async search(
    guildId: string,
    searchQuery: GatewaySearchQuery,
    requester: unknown,
  ): Promise<GatewaySearchResult> {
    this.searchCalls.push({ guildId, query: searchQuery, requester });
    return await this.searchHandler(searchQuery);
  }

  async updateSession(nodeId: string, resuming: boolean, timeoutSeconds: number): Promise<void> {
    this.updateSessionCalls.push({ nodeId, resuming, timeoutSeconds });
  }

  async rehydratePlayer(options: RehydratePlayerOptions): Promise<FakePlayer> {
    this.rehydrateCalls.push(options);
    const player = new FakePlayer({
      guildId: options.guildId,
      voiceChannelId: options.voiceChannelId,
      textChannelId: options.textChannelId,
      volume: options.volume,
    });
    player.connected = true;
    player.paused = options.paused;
    player.repeatMode = options.repeatMode;
    player.current = options.currentTrack ?? null;
    player.playing = Boolean(options.currentTrack);
    this.players.set(options.guildId, player);
    return player;
  }

  async validateVoiceChannel(
    guildId: string,
    voiceChannelId: string,
  ): Promise<VoiceChannelCheckResult> {
    return this.voiceChannelChecks.get(`${guildId}:${voiceChannelId}`) ?? { ok: true };
  }
}

class FakeGuildMessenger implements GuildMessenger {
  sentMessages: Array<{ channelId: string; content: string }> = [];
  sentPanels: Array<{ channelId: string; payload: NowPlayingPanelPayload; ref: PanelMessageRef }> = [];
  updatedPanels: Array<{ messageId: string; payload: Record<string, unknown> }> = [];
  disabledMessages: string[] = [];
  messageStore = new Map<string, EditablePanelMessage>();
  nextMsgSeq = 1;

  async sendMessage(channelId: string, content: string): Promise<void> {
    this.sentMessages.push({ channelId, content });
  }

  async sendNowPlayingPanel(
    channelId: string,
    payload: NowPlayingPanelPayload,
  ): Promise<PanelMessageRef> {
    const messageId = `panel-${this.nextMsgSeq++}`;
    const ref = { channelId, messageId };
    this.sentPanels.push({ channelId, payload, ref });
    this.messageStore.set(messageId, {
      components: [buildControlButtons({ paused: payload.paused, repeatMode: payload.repeatMode })],
      edit: async (editPayload) => {
        if (editPayload && 'embeds' in editPayload && editPayload.embeds) {
          this.updatedPanels.push({
            messageId,
            payload: editPayload as unknown as Record<string, unknown>,
          });
          return;
        }
        this.disabledMessages.push(messageId);
      },
    });
    return ref;
  }

  async fetchPanelMessage(ref: PanelMessageRef): Promise<EditablePanelMessage | undefined> {
    return this.messageStore.get(ref.messageId);
  }
}

function createHarness(options?: {
  spotifyEnabled?: boolean;
  maxQueueSize?: number;
  rejoinStaggerMs?: number;
  panelUpdateIntervalMs?: number;
}) {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  const sessionStore = new SessionStoreRepository(db);
  const queueStore = new SqliteQueueStore(db);
  const gateway = new FakeLavalinkGateway();
  const messenger = new FakeGuildMessenger();
  const logger = createLogger('silent' as any, new PassThrough());
  const service = new MusicService({
    gateway,
    messenger,
    settingsRepo,
    sessionStore,
    queueStore,
    logger,
    spotifyEnabled: options?.spotifyEnabled ?? true,
    maxQueueSize: options?.maxQueueSize ?? 500,
    rejoinStaggerMs: options?.rejoinStaggerMs,
    panelUpdateIntervalMs: options?.panelUpdateIntervalMs ?? 0,
  });

  return { db, settingsRepo, sessionStore, queueStore, gateway, messenger, service };
}

test('play rejects unsupported URL and disabled Spotify before hitting Lavalink', async () => {
  const { db, gateway, service } = createHarness({ spotifyEnabled: false });

  const badUrl = await service.play({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    query: 'https://soundcloud.com/artist/song',
    requester: { id: 'u1' },
  });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.reason, 'UNSUPPORTED_URL');
  assert.equal(gateway.searchCalls.length, 0);
  assert.equal(gateway.players.size, 0);

  const disabledSpotify = await service.play({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    query: 'https://open.spotify.com/track/123456',
    requester: { id: 'u1' },
  });
  assert.equal(disabledSpotify.ok, false);
  assert.equal(disabledSpotify.reason, 'SPOTIFY_DISABLED');
  assert.equal(gateway.searchCalls.length, 0);

  await service.shutdownGracefully();
  db.close();
});

test('play returns friendly pt-BR notice when no Lavalink node is connected', async () => {
  const { db, gateway, service } = createHarness();
  gateway.connectedNode = false;

  const res = await service.play({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    query: 'evidências',
    requester: { id: 'u1' },
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'NO_NODE');
  assert.match(res.message, /servidor de áudio|reconectando/i);
  assert.equal(gateway.searchCalls.length, 0);

  await service.shutdownGracefully();
  db.close();
});

test('play applies defaultVolume on new player, updates 24/7 channels, and starts idle playback', async () => {
  const { db, settingsRepo, sessionStore, gateway, service } = createHarness();
  settingsRepo.update('g1', { defaultVolume: 115, alwaysOn247: true });

  const track = makeTrack('abc', 'Evidências');
  gateway.searchHandler = () => ({
    loadType: 'search',
    tracks: [track, makeTrack('other', 'Other Candidate')],
    playlist: null,
    exception: null,
  });

  const res = await service.play({
    guildId: 'g1',
    voiceChannelId: 'vc-99',
    textChannelId: 'tc-99',
    query: 'evidências',
    requester: { id: 'u1', tag: 'U1' },
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.addedCount, 1);
    assert.equal(res.truncatedCount, 0);
    assert.equal(res.startedImmediately, true);
  }
  assert.equal(gateway.searchCalls[0].query.source, 'ytmsearch');

  const player = gateway.getPlayer('g1')!;
  assert.equal(player.volume, 115);
  assert.equal(player.connected, true);
  assert.equal(player.playCalls, 1);
  assert.equal(player.current?.info.identifier, 'abc');
  assert.equal(player.tracks.length, 0);

  const savedSettings = settingsRepo.getOrDefault('g1');
  assert.equal(savedSettings.voiceChannelId247, 'vc-99');
  assert.equal(savedSettings.textChannelId247, 'tc-99');
  assert.equal(sessionStore.getActivePlayer('g1')?.voiceChannelId, 'vc-99');

  await service.shutdownGracefully();
  db.close();
});

test('Review Focus #2: play slices playlist exceeding maxQueueSize and rejects when queue is already full', async () => {
  const { db, gateway, service } = createHarness({ maxQueueSize: 5 });

  // Pre-seed active player with 1 playing and 2 queued tracks
  const player = await gateway.createPlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    volume: 80,
  });
  await player.connect();
  player.current = makeTrack('cur');
  player.playing = true;
  await player.queue.add([makeTrack('q1'), makeTrack('q2')]);

  const playlistTracks = Array.from({ length: 10 }, (_, idx) => makeTrack(`pl-${idx}`));
  gateway.searchHandler = () => ({
    loadType: 'playlist',
    tracks: playlistTracks,
    playlist: { name: 'Mix Gigante', title: 'Mix Gigante' },
    exception: null,
  });

  const partial = await service.play({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    query: 'https://www.youtube.com/watch?v=x&list=PL123',
    requester: { id: 'u1' },
  });

  assert.equal(partial.ok, true);
  if (partial.ok) {
    assert.equal(partial.addedCount, 3);
    assert.equal(partial.truncatedCount, 7);
    assert.equal(partial.isPlaylist, true);
    assert.equal(partial.startedImmediately, false);
  }
  assert.equal(player.tracks.length, 5);
  assert.equal(player.playCalls, 0);

  const full = await service.play({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    query: 'https://www.youtube.com/watch?v=extra',
    requester: { id: 'u1' },
  });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'QUEUE_FULL');
  assert.match(full.message, /limite máximo|fila/i);
  assert.equal(player.tracks.length, 5);

  await service.shutdownGracefully();
  db.close();
});

test('skip advances amount tracks and safely stops remaining queue when amount > queue.length', async () => {
  const { db, settingsRepo, gateway, service } = createHarness();
  const player = await gateway.createPlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    volume: 80,
  });
  await player.connect();
  player.current = makeTrack('0');
  player.playing = true;
  await player.queue.add([makeTrack('1'), makeTrack('2'), makeTrack('3')]);

  const skipTwo = await service.skip('g1', 2);
  assert.equal(skipTwo.ok, true);
  assert.deepEqual(player.skipCalls, [2]);
  assert.equal(player.current?.info.identifier, '2');
  assert.equal(player.tracks.length, 1);

  // Now queue has 1 track; skip 5 exceeds queue.length -> stopPlaying safely without throwing
  const skipOverflow = await service.skip('g1', 5);
  assert.equal(skipOverflow.ok, true);
  assert.equal(player.stopPlayingCalls.length, 1);
  assert.equal(player.tracks.length, 0);
  assert.equal(player.current, null);

  // With alwaysOn247 = true, player stays connected and no auto-leave timer is scheduled
  settingsRepo.update('g2', { alwaysOn247: true, voiceChannelId247: 'vc2', textChannelId247: 'tc2' });
  const player247 = await gateway.createPlayer({
    guildId: 'g2',
    voiceChannelId: 'vc2',
    textChannelId: 'tc2',
    volume: 80,
  });
  await player247.connect();
  player247.current = makeTrack('cur247');
  player247.playing = true;
  const skip247 = await service.skip('g2', 1);
  assert.equal(skip247.ok, true);
  assert.equal(player247.stopPlayingCalls.length, 1);
  assert.equal(gateway.destroyCalls.length, 0);

  await service.shutdownGracefully();
  db.close();
});

test('stop disconnects when alwaysOn247 = false and stays connected when alwaysOn247 = true', async () => {
  const { db, settingsRepo, gateway, service } = createHarness();

  const p1 = await gateway.createPlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    volume: 80,
  });
  await p1.connect();
  p1.current = makeTrack('1');
  p1.playing = true;
  await p1.queue.add([makeTrack('2')]);

  const resOff = await service.stop('g1');
  assert.equal(resOff.ok, true);
  assert.equal(gateway.destroyCalls.length, 1);
  assert.equal(gateway.getPlayer('g1'), null);

  // With 24/7 enabled, stop clears queue & stops playback without disconnecting
  settingsRepo.update('g2', {
    alwaysOn247: true,
    voiceChannelId247: 'vc2',
    textChannelId247: 'tc2',
  });
  const p2 = await gateway.createPlayer({
    guildId: 'g2',
    voiceChannelId: 'vc2',
    textChannelId: 'tc2',
    volume: 80,
  });
  await p2.connect();
  p2.current = makeTrack('a');
  p2.playing = true;
  await p2.queue.add([makeTrack('b')]);

  const resOn = await service.stop('g2');
  assert.equal(resOn.ok, true);
  assert.equal(p2.stopPlayingCalls.length, 1);
  assert.equal(p2.tracks.length, 0);
  assert.equal(gateway.destroyCalls.length, 1);
  assert.notEqual(gateway.getPlayer('g2'), null);

  await service.shutdownGracefully();
  db.close();
});

test('playback control actions (pause, resume, togglePause, shuffle, setLoop, cycleLoop, setVolume, remove, clearQueue, getNowPlaying, getQueue)', async () => {
  const { db, sessionStore, gateway, service } = createHarness();
  const player = await gateway.createPlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    volume: 80,
  });
  await player.connect();
  player.current = makeTrack('0', 'Música Atual');
  player.playing = true;
  await player.queue.add([makeTrack('1', 'Um'), makeTrack('2', 'Dois'), makeTrack('3', 'Três')]);

  assert.equal((await service.pause('g1')).ok, true);
  assert.equal((await service.pause('g1')).ok, false); // already paused
  assert.equal((await service.resume('g1')).ok, true);
  assert.equal((await service.resume('g1')).ok, false); // already playing

  const toggle1 = await service.togglePause('g1');
  assert.equal(toggle1.ok && toggle1.paused, true);
  const toggle2 = await service.togglePause('g1');
  assert.equal(toggle2.ok && toggle2.paused, false);

  const volBad = await service.setVolume('g1', 151);
  assert.equal(volBad.ok, false);
  const volGood = await service.setVolume('g1', 120);
  assert.equal(volGood.ok, true);
  assert.equal(player.volume, 120);

  const cycle1 = await service.cycleLoop('g1');
  assert.equal(cycle1.ok && cycle1.repeatMode, 'track');
  const cycle2 = await service.cycleLoop('g1');
  assert.equal(cycle2.ok && cycle2.repeatMode, 'queue');
  assert.equal(sessionStore.getActivePlayer('g1')?.repeatMode, 'queue');
  const setOff = await service.setLoop('g1', 'off');
  assert.equal(setOff.ok && setOff.repeatMode, 'off');

  const shuffled = await service.shuffle('g1');
  assert.equal(shuffled.ok, true);
  assert.equal(player.shuffleCalls, 1);

  const removedOutOfRange = await service.remove('g1', 99);
  assert.equal(removedOutOfRange.ok, false);
  const removed = await service.remove('g1', 2);
  assert.equal(removed.ok, true);
  assert.equal(player.tracks.length, 2);

  const np = service.getNowPlaying('g1');
  assert.ok(np);
  assert.equal(np.track.title, 'Música Atual');
  assert.equal(np.volume, 120);
  assert.equal(np.queueLength, 2);

  const queueSnap = service.getQueue('g1');
  assert.ok(queueSnap);
  assert.equal(queueSnap.currentTrack?.title, 'Música Atual');
  assert.equal(queueSnap.queue.length, 2);

  const cleared = await service.clearQueue('g1');
  assert.equal(cleared.ok, true);
  assert.equal(player.tracks.length, 0);

  await service.shutdownGracefully();
  db.close();
});

test('ensureConnected247 connects immediately and handle247Disabled schedules auto-leave when idle or empty', async () => {
  const { db, settingsRepo, gateway, service } = createHarness();
  settingsRepo.update('g1', {
    alwaysOn247: true,
    voiceChannelId247: 'vc-247',
    textChannelId247: 'tc-247',
    autoLeaveSeconds: 0.03 as unknown as number, // fast test interval (30ms)
  });

  const conn = await service.ensureConnected247('g1', 'vc-247', 'tc-247');
  assert.equal(conn.ok, true);
  const player = gateway.getPlayer('g1')!;
  assert.equal(player.connected, true);
  assert.equal(player.voiceChannelId, 'vc-247');

  // Simulate disabling 24/7 while idle
  settingsRepo.update('g1', { alwaysOn247: false, voiceChannelId247: null, textChannelId247: null });
  await service.handle247Disabled('g1');

  await delay(60);
  assert.equal(gateway.destroyCalls.length, 1);
  assert.equal(gateway.getPlayer('g1'), null);

  await service.shutdownGracefully();
  db.close();
});

test('handleTrackStart disables previous panel and resets failures; handleTrackError/Stuck trip circuit breaker on 3rd consecutive failure', async () => {
  const { db, settingsRepo, gateway, messenger, service } = createHarness();
  const player = await gateway.createPlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    volume: 80,
  });
  await player.connect();
  player.current = makeTrack('t1');
  player.playing = true;
  await player.queue.add([makeTrack('t2'), makeTrack('t3'), makeTrack('t4'), makeTrack('t5')]);

  // Track start sends first panel
  await service.handleTrackStart('g1', player.current);
  assert.equal(messenger.sentPanels.length, 1);
  const firstPanelId = messenger.sentPanels[0].ref.messageId;

  // 1st error notifies and advances
  await service.handleTrackError('g1', player.current, 'network error');
  assert.equal(messenger.sentMessages.length, 1);
  assert.equal(player.skipCalls.length, 1);

  // 2nd error (via handleTrackStuck) notifies and advances
  await service.handleTrackStuck('g1', player.current, 10_000);
  assert.equal(messenger.sentMessages.length, 2);
  assert.equal(player.skipCalls.length, 2);

  // A successful track start resets consecutive failures and disables old panel before sending new panel
  await service.handleTrackStart('g1', player.current);
  assert.deepEqual(messenger.disabledMessages, [firstPanelId]);
  assert.equal(messenger.sentPanels.length, 2);

  // 3 consecutive errors now trip the circuit breaker (1, 2, 3)
  await service.handleTrackError('g1', player.current, 'err1');
  await service.handleTrackStuck('g1', player.current, 10_000);
  await service.handleTrackError('g1', player.current, 'err3');

  assert.equal(gateway.destroyCalls.length, 1);
  assert.equal(gateway.getPlayer('g1'), null);
  assert.match(messenger.sentMessages.at(-1)!.content, /sequência|falharam/i);

  // Repeat with alwaysOn247 = true -> clears queue & stops, does NOT disconnect
  settingsRepo.update('g2', { alwaysOn247: true, voiceChannelId247: 'vc2', textChannelId247: 'tc2' });
  const p2 = await gateway.createPlayer({
    guildId: 'g2',
    voiceChannelId: 'vc2',
    textChannelId: 'tc2',
    volume: 80,
  });
  await p2.connect();
  p2.current = makeTrack('x1');
  p2.playing = true;
  await p2.queue.add([makeTrack('x2'), makeTrack('x3'), makeTrack('x4')]);

  await service.handleTrackError('g2', p2.current, 'e1');
  await service.handleTrackError('g2', p2.current, 'e2');
  await service.handleTrackError('g2', p2.current, 'e3');

  assert.equal(p2.tracks.length, 0);
  assert.equal(p2.stopPlayingCalls.length, 1);
  assert.notEqual(gateway.getPlayer('g2'), null);

  await service.shutdownGracefully();
  db.close();
});

test('handleQueueEnd and handleVoiceChannelEmpty schedule auto-leave when 24/7 is off, cancelled by play/human join; 24/7 pauses on empty', async () => {
  const { db, settingsRepo, gateway, service } = createHarness();
  settingsRepo.update('g1', { autoLeaveSeconds: 0.03 as unknown as number });

  const p1 = await gateway.createPlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    volume: 80,
  });
  await p1.connect();
  p1.playing = false;
  p1.current = null;

  // Queue end schedules timer, cancelled by human join
  await service.handleQueueEnd('g1');
  await service.handleVoiceHumanJoined('g1');
  await delay(50);
  assert.notEqual(gateway.getPlayer('g1'), null);

  // Empty channel schedules timer, cancelled by play
  await service.handleVoiceChannelEmpty('g1');
  await service.play({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    query: 'test song',
    requester: { id: 'u1' },
  });
  await delay(50);
  assert.notEqual(gateway.getPlayer('g1'), null);

  // Empty channel fires auto-leave when not cancelled
  await service.handleVoiceChannelEmpty('g1');
  await delay(55);
  assert.equal(gateway.getPlayer('g1'), null);

  // 24/7 pauses on empty channel instead of leaving, and resumes when human joins
  settingsRepo.update('g2', { alwaysOn247: true, voiceChannelId247: 'vc2', textChannelId247: 'tc2' });
  const p2 = await gateway.createPlayer({
    guildId: 'g2',
    voiceChannelId: 'vc2',
    textChannelId: 'tc2',
    volume: 80,
  });
  await p2.connect();
  p2.current = makeTrack('s2');
  p2.playing = true;

  await service.handleVoiceChannelEmpty('g2');
  assert.equal(p2.paused, true);
  assert.notEqual(gateway.getPlayer('g2'), null);

  await service.handleVoiceHumanJoined('g2');
  assert.equal(p2.paused, false);

  await service.shutdownGracefully();
  db.close();
});

test('Review Focus #4: handleVoiceDisconnect clears voiceChannelId247 on external kick but preserves on bot-initiated disconnect', async () => {
  const { db, settingsRepo, gateway, service } = createHarness();

  // Bot-initiated disconnect (stop) preserves voiceChannelId247 if configured in DB
  settingsRepo.update('g-bot', {
    alwaysOn247: false,
    voiceChannelId247: 'vc-saved',
    textChannelId247: 'tc-saved',
  });
  const pBot = await gateway.createPlayer({
    guildId: 'g-bot',
    voiceChannelId: 'vc-saved',
    textChannelId: 'tc-saved',
    volume: 80,
  });
  await pBot.connect();
  await service.stop('g-bot');
  await service.handleVoiceDisconnect('g-bot');
  assert.equal(settingsRepo.getOrDefault('g-bot').voiceChannelId247, 'vc-saved');

  // Auto-leave bot-initiated disconnect preserves voiceChannelId247
  settingsRepo.update('g-auto', {
    alwaysOn247: false,
    autoLeaveSeconds: 0.02 as unknown as number,
    voiceChannelId247: 'vc-auto',
    textChannelId247: 'tc-auto',
  });
  const pAuto = await gateway.createPlayer({
    guildId: 'g-auto',
    voiceChannelId: 'vc-auto',
    textChannelId: 'tc-auto',
    volume: 80,
  });
  await pAuto.connect();
  await service.handleQueueEnd('g-auto');
  await delay(45);
  await service.handleVoiceDisconnect('g-auto');
  assert.equal(settingsRepo.getOrDefault('g-auto').voiceChannelId247, 'vc-auto');

  // External moderator kick clears voiceChannelId247
  settingsRepo.update('g-kick', {
    alwaysOn247: true,
    voiceChannelId247: 'vc-kick',
    textChannelId247: 'tc-kick',
  });
  const pKick = await gateway.createPlayer({
    guildId: 'g-kick',
    voiceChannelId: 'vc-kick',
    textChannelId: 'tc-kick',
    volume: 80,
  });
  await pKick.connect();
  await service.handleVoiceDisconnect('g-kick');
  assert.equal(settingsRepo.getOrDefault('g-kick').voiceChannelId247, null);
  assert.equal(settingsRepo.getOrDefault('g-kick').textChannelId247, null);
  assert.equal(gateway.getPlayer('g-kick'), null);

  await service.shutdownGracefully();
  db.close();
});

test('Review Focus #3: handleNodeConnect, handleNodeResumed, and handleFreshNodeSession manage session persistence and 250ms staggered 24/7 rejoin', async () => {
  const { db, settingsRepo, sessionStore, queueStore, gateway, messenger, service } = createHarness();

  // 1. handleNodeConnect saves sessionId and calls updateSession(nodeId, true, 60)
  await service.handleNodeConnect('main', 'sess-123');
  assert.equal(sessionStore.getNodeSessionId('main'), 'sess-123');
  assert.deepEqual(gateway.updateSessionCalls, [
    { nodeId: 'main', resuming: true, timeoutSeconds: LAVALINK_RESUME_TIMEOUT_SECONDS },
  ]);
  assert.equal(LAVALINK_RESUME_TIMEOUT_SECONDS, 60);

  // 2. handleNodeResumed rehydrates active players & panel references from active_player_sessions
  let disabledResumedPanel = false;
  messenger.messageStore.set('panel-r', {
    components: [buildControlButtons({ paused: false, repeatMode: 'queue' })],
    edit: async () => {
      disabledResumedPanel = true;
    },
  });
  sessionStore.saveActivePlayer({
    guildId: 'g-resumed',
    voiceChannelId: 'vc-r',
    textChannelId: 'tc-r',
    repeatMode: 'queue',
    panelChannelId: 'tc-r',
    panelMessageId: 'panel-r',
  });
  sessionStore.saveActivePlayer({
    guildId: 'g-ended',
    voiceChannelId: 'vc-e',
    textChannelId: 'tc-e',
    repeatMode: 'off',
    panelChannelId: null,
    panelMessageId: null,
  });
  await queueStore.set('g-ended', JSON.stringify({ current: null, previous: [], tracks: [] }));

  await service.handleNodeResumed('main', 'sess-123', [
    { guildId: 'g-resumed', voiceChannelId: 'vc-r', volume: 95, paused: false, currentTrack: makeTrack('r1') },
  ]);

  assert.equal(gateway.rehydrateCalls.length, 1);
  assert.equal(gateway.getPlayer('g-resumed')?.repeatMode, 'queue');
  assert.equal(gateway.getPlayer('g-resumed')?.volume, 95);
  assert.equal(sessionStore.getActivePlayer('g-ended'), null);
  assert.equal(await queueStore.get('g-ended'), undefined);

  // Starting next track disables the panel restored from active_player_sessions
  await service.handleTrackStart('g-resumed', makeTrack('r2'));
  assert.equal(disabledResumedPanel, true);

  // 3. handleFreshNodeSession purges stale queues + active sessions, clears bad 24/7 channels, and staggers valid ones by 250ms
  gateway.players.clear();
  gateway.joinTimestamps.length = 0;
  await queueStore.set('g-stale', JSON.stringify({ current: null, previous: [], tracks: [makeTrack('s1')] }));
  sessionStore.saveActivePlayer({
    guildId: 'g-stale',
    voiceChannelId: 'vc-s',
    textChannelId: 'tc-s',
    repeatMode: 'track',
    panelChannelId: null,
    panelMessageId: null,
  });

  settingsRepo.update('g-247-1', { alwaysOn247: true, voiceChannelId247: 'vc-1', textChannelId247: 'tc-1' });
  settingsRepo.update('g-247-bad', { alwaysOn247: true, voiceChannelId247: 'vc-bad', textChannelId247: 'tc-bad' });
  settingsRepo.update('g-247-2', { alwaysOn247: true, voiceChannelId247: 'vc-2', textChannelId247: 'tc-2' });
  gateway.voiceChannelChecks.set('g-247-bad:vc-bad', {
    ok: false,
    reason: 'MISSING_PERMISSIONS',
  });

  await service.handleFreshNodeSession('main', 'sess-fresh');

  assert.equal(sessionStore.getNodeSessionId('main'), 'sess-fresh');
  assert.equal(await queueStore.get('g-stale'), undefined);
  assert.equal(sessionStore.getActivePlayer('g-stale'), null);
  assert.equal(settingsRepo.getOrDefault('g-247-bad').voiceChannelId247, null);
  assert.notEqual(gateway.getPlayer('g-247-1'), null);
  assert.notEqual(gateway.getPlayer('g-247-2'), null);
  assert.equal(gateway.getPlayer('g-247-bad'), null);

  const validJoins = gateway.joinTimestamps.filter(
    (j) => j.guildId === 'g-247-1' || j.guildId === 'g-247-2',
  );
  assert.equal(validJoins.length, 2);
  assert.ok(
    validJoins[1].at - validJoins[0].at >= 200,
    `Expected >=200ms stagger between 24/7 joins, got ${validJoins[1].at - validJoins[0].at}ms`,
  );

  await service.shutdownGracefully();
  db.close();
});

test('shutdownGracefully cancels pending timers without destroying active Lavalink players', async () => {
  const { db, settingsRepo, gateway, service } = createHarness();
  settingsRepo.update('g1', { autoLeaveSeconds: 0.025 as unknown as number });

  const p1 = await gateway.createPlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    volume: 80,
  });
  await p1.connect();
  await service.handleQueueEnd('g1');

  await service.shutdownGracefully();
  await delay(45);

  assert.equal(gateway.destroyCalls.length, 0);
  assert.notEqual(gateway.getPlayer('g1'), null);
  db.close();
});

test('concurrent play calls in same guild serialize createPlayer and strictly enforce maxQueueSize', async () => {
  const { db, gateway, service } = createHarness({ maxQueueSize: 5 });

  let createCount = 0;
  const originalCreatePlayer = gateway.createPlayer.bind(gateway);
  gateway.createPlayer = async (options) => {
    createCount += 1;
    await delay(25);
    return originalCreatePlayer(options);
  };

  let batch = 0;
  gateway.searchHandler = () => {
    batch += 1;
    return {
      loadType: 'playlist',
      tracks: Array.from({ length: 4 }, (_, idx) => makeTrack(`b${batch}-${idx}`)),
      playlist: { name: `Playlist ${batch}`, title: `Playlist ${batch}` },
      exception: null,
    };
  };

  const [first, second] = await Promise.all([
    service.play({
      guildId: 'g-race',
      voiceChannelId: 'vc1',
      textChannelId: 'tc1',
      query: 'https://www.youtube.com/playlist?list=PL1',
      requester: { id: 'u1' },
    }),
    service.play({
      guildId: 'g-race',
      voiceChannelId: 'vc1',
      textChannelId: 'tc1',
      query: 'https://www.youtube.com/playlist?list=PL2',
      requester: { id: 'u2' },
    }),
  ]);

  assert.equal(createCount, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.addedCount, 4);
    assert.equal(first.truncatedCount, 0);
    assert.equal(second.addedCount, 2);
    assert.equal(second.truncatedCount, 2);
  }

  const player = gateway.getPlayer('g-race')!;
  assert.equal(player.tracks.length, 5);

  // Two concurrent single-track requests when queue is already full must both reject cleanly
  gateway.searchHandler = () => ({
    loadType: 'track',
    tracks: [makeTrack('overflow')],
    playlist: null,
    exception: null,
  });
  const [over1, over2] = await Promise.all([
    service.play({
      guildId: 'g-race',
      voiceChannelId: 'vc1',
      textChannelId: 'tc1',
      query: 'https://www.youtube.com/watch?v=overflow1',
      requester: { id: 'u1' },
    }),
    service.play({
      guildId: 'g-race',
      voiceChannelId: 'vc1',
      textChannelId: 'tc1',
      query: 'https://www.youtube.com/watch?v=overflow2',
      requester: { id: 'u2' },
    }),
  ]);
  assert.equal(over1.ok, false);
  assert.equal(over2.ok, false);
  assert.equal(player.tracks.length, 5);

  await service.shutdownGracefully();
  db.close();
});

test('shutdownGracefully immediately settles mid-stagger rejoin247Guilds promise', async () => {
  const { db, settingsRepo, gateway, service } = createHarness({ rejoinStaggerMs: 500 });
  settingsRepo.update('g-247-a', { alwaysOn247: true, voiceChannelId247: 'vc-a', textChannelId247: 'tc-a' });
  settingsRepo.update('g-247-b', { alwaysOn247: true, voiceChannelId247: 'vc-b', textChannelId247: 'tc-b' });
  settingsRepo.update('g-247-c', { alwaysOn247: true, voiceChannelId247: 'vc-c', textChannelId247: 'tc-c' });

  const rejoinPromise = service.rejoin247Guilds();
  await delay(30);
  assert.equal(gateway.joinTimestamps.length, 1);

  await service.shutdownGracefully();
  const outcome = await Promise.race([
    rejoinPromise.then(() => 'settled' as const),
    delay(150).then(() => 'timed-out' as const),
  ]);

  assert.equal(outcome, 'settled');
  assert.equal(gateway.joinTimestamps.length, 1);
  db.close();
});

test('handleNodeResumed cleans stale panel and schedules auto-leave for idle non-24/7 player with currentTrack === null', async () => {
  const { db, settingsRepo, sessionStore, gateway, messenger, service } = createHarness();

  settingsRepo.update('g-idle-off', {
    alwaysOn247: false,
    autoLeaveSeconds: 0.03 as unknown as number,
  });
  let disabledIdleOffPanel = false;
  messenger.messageStore.set('panel-idle-off', {
    components: [buildControlButtons({ paused: false, repeatMode: 'off' })],
    edit: async () => {
      disabledIdleOffPanel = true;
    },
  });
  sessionStore.saveActivePlayer({
    guildId: 'g-idle-off',
    voiceChannelId: 'vc-idle-off',
    textChannelId: 'tc-idle-off',
    repeatMode: 'off',
    panelChannelId: 'tc-idle-off',
    panelMessageId: 'panel-idle-off',
  });

  // Also ensure an idle 24/7 resumed player disables stale panel but remains connected
  settingsRepo.update('g-idle-247', {
    alwaysOn247: true,
    voiceChannelId247: 'vc-idle-247',
    textChannelId247: 'tc-idle-247',
  });
  let disabledIdle247Panel = false;
  messenger.messageStore.set('panel-idle-247', {
    components: [buildControlButtons({ paused: false, repeatMode: 'off' })],
    edit: async () => {
      disabledIdle247Panel = true;
    },
  });
  sessionStore.saveActivePlayer({
    guildId: 'g-idle-247',
    voiceChannelId: 'vc-idle-247',
    textChannelId: 'tc-idle-247',
    repeatMode: 'off',
    panelChannelId: 'tc-idle-247',
    panelMessageId: 'panel-idle-247',
  });

  await service.handleNodeResumed('main', 'sess-resumed-idle', [
    { guildId: 'g-idle-off', voiceChannelId: 'vc-idle-off', volume: 80, paused: false, currentTrack: null },
    { guildId: 'g-idle-247', voiceChannelId: 'vc-idle-247', volume: 80, paused: false, currentTrack: null },
  ]);

  assert.equal(disabledIdleOffPanel, true);
  assert.equal(disabledIdle247Panel, true);
  assert.equal(sessionStore.getActivePlayer('g-idle-off')?.panelMessageId, null);
  assert.equal(sessionStore.getActivePlayer('g-idle-247')?.panelMessageId, null);

  await delay(60);
  assert.equal(gateway.getPlayer('g-idle-off'), null);
  assert.ok(gateway.destroyCalls.some((c) => c.guildId === 'g-idle-off' && c.reason === 'autoLeave'));
  assert.notEqual(gateway.getPlayer('g-idle-247'), null);

  await service.shutdownGracefully();
  db.close();
});

test('live panel updater ticks while playing, skips paused/stream tracks, and stops cleanly on pause/queueEnd/shutdown', async () => {
  const { db, gateway, messenger, service } = createHarness({ panelUpdateIntervalMs: 25 });
  const player = await gateway.createPlayer({
    guildId: 'g-live',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    volume: 80,
  });
  await player.connect();
  const track = makeTrack('live-1', 'Música Ao Vivo no Timer', 240_000);
  player.current = track;
  player.playing = true;
  player.position = 30_000;

  await service.handleTrackStart('g-live', track);
  assert.equal(messenger.sentPanels.length, 1);

  await delay(65);
  const countWhilePlaying = messenger.updatedPanels.length;
  assert.ok(countWhilePlaying >= 1, `Expected live panel updates, got ${countWhilePlaying}`);
  const lastUpdatedEmbed = (
    messenger.updatedPanels[messenger.updatedPanels.length - 1].payload.embeds as Array<{
      toJSON: () => { description?: string };
    }>
  )[0].toJSON();
  assert.match(lastUpdatedEmbed.description ?? '', /00:30/);

  // Pausing refreshes immediately once, then stops ticking while paused
  await service.pause('g-live');
  await delay(10);
  const countAfterPause = messenger.updatedPanels.length;
  await delay(65);
  assert.equal(messenger.updatedPanels.length, countAfterPause);

  // Stream tracks do not trigger background ticks
  await service.resume('g-live');
  player.current = {
    ...track,
    info: { ...track.info, isStream: true, duration: 0 },
  };
  await delay(10);
  const countAtStreamStart = messenger.updatedPanels.length;
  await delay(65);
  assert.equal(messenger.updatedPanels.length, countAtStreamStart);

  // queueEnd stops updater and disables panel
  await service.handleQueueEnd('g-live');
  assert.equal(messenger.disabledMessages.length, 1);
  const countAfterEnd = messenger.updatedPanels.length;
  await delay(50);
  assert.equal(messenger.updatedPanels.length, countAfterEnd);

  await service.shutdownGracefully();
  db.close();
});

test('adjustVolume clamps 0..150 and toggleMute saves/restores previous volume with defaultVolume fallback', async () => {
  const { db, settingsRepo, gateway, service } = createHarness();
  settingsRepo.update('g-vol', { defaultVolume: 65 });

  const player = await gateway.createPlayer({
    guildId: 'g-vol',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    volume: 65,
  });
  player.current = makeTrack('v1');
  player.playing = true;

  // Adjust up/down clamping
  const up = await service.adjustVolume('g-vol', 100);
  assert.equal(up.ok, true);
  if (up.ok) assert.equal(up.volume, 150);

  const down = await service.adjustVolume('g-vol', -20);
  assert.equal(down.ok, true);
  if (down.ok) assert.equal(down.volume, 130);

  // Toggle mute saves 130 -> 0 -> restores 130
  const muteRes = await service.toggleMute('g-vol');
  assert.equal(muteRes.ok, true);
  if (muteRes.ok) {
    assert.equal(muteRes.volume, 0);
    assert.equal(muteRes.muted, true);
  }
  assert.equal(player.volume, 0);

  const unmuteRes = await service.toggleMute('g-vol');
  assert.equal(unmuteRes.ok, true);
  if (unmuteRes.ok) {
    assert.equal(unmuteRes.volume, 130);
    assert.equal(unmuteRes.muted, false);
  }
  assert.equal(player.volume, 130);

  // Clamp to 0 via adjustVolume also saves prior volume for unmute
  await service.setVolume('g-vol', 15);
  const clampedZero = await service.adjustVolume('g-vol', -20);
  assert.equal(clampedZero.ok, true);
  if (clampedZero.ok) assert.equal(clampedZero.volume, 0);
  const restoredFromClamp = await service.toggleMute('g-vol');
  assert.equal(restoredFromClamp.ok, true);
  if (restoredFromClamp.ok) assert.equal(restoredFromClamp.volume, 15);

  // If player stopped cleanly, previous mute memory clears; fallback uses settings.defaultVolume
  await service.stop('g-vol');
  const freshMutedPlayer = await gateway.createPlayer({
    guildId: 'g-vol',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    volume: 0,
  });
  const fallbackUnmute = await service.toggleMute('g-vol');
  assert.equal(fallbackUnmute.ok, true);
  if (fallbackUnmute.ok) assert.equal(fallbackUnmute.volume, 65);
  assert.equal(freshMutedPlayer.volume, 65);

  await service.shutdownGracefully();
  db.close();
});

test('smart queue supports playNext, duplicate detection, moveTrack, removeDuplicates, and currentPositionMs snapshot', async () => {
  const { db, gateway, service } = createHarness();

  const tracksByQuery: Record<string, GatewayTrack> = {
    a: makeTrack('id-a', 'Track A'),
    b: makeTrack('id-b', 'Track B'),
    c: makeTrack('id-c', 'Track C'),
  };
  gateway.searchHandler = (q) => ({
    loadType: 'track',
    tracks: [tracksByQuery[q.query] ?? makeTrack('id-x', q.query)],
    playlist: null,
    exception: null,
  });

  // 1. Start A, queue B, queue duplicate B (detects duplicate), then playNext C (inserts at index 0)
  const playA = await service.play({
    guildId: 'g-q',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    query: 'a',
    requester: { id: 'u1' },
  });
  assert.equal(playA.ok, true);
  if (playA.ok) assert.equal(playA.duplicateInQueue, false);

  const playB = await service.play({
    guildId: 'g-q',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    query: 'b',
    requester: { id: 'u1' },
  });
  assert.equal(playB.ok, true);
  if (playB.ok) assert.equal(playB.duplicateInQueue, false);

  const playBDup = await service.play({
    guildId: 'g-q',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    query: 'b',
    requester: { id: 'u2' },
  });
  assert.equal(playBDup.ok, true);
  if (playBDup.ok) {
    assert.equal(playBDup.duplicateInQueue, true);
    assert.match(playBDup.message, /já estava na fila/i);
  }

  const playADup = await service.play({
    guildId: 'g-q',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    query: 'a',
    requester: { id: 'u3' },
  });
  assert.equal(playADup.ok, true);
  if (playADup.ok) assert.equal(playADup.duplicateInQueue, true);

  const playCNext = await service.play({
    guildId: 'g-q',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    query: 'c',
    requester: { id: 'u1' },
    playNext: true,
  });
  assert.equal(playCNext.ok, true);
  if (playCNext.ok) {
    assert.match(playCNext.message, /próxima da fila/i);
  }

  const player = gateway.getPlayer('g-q')!;
  player.position = 42_000;
  // Current is A; queue should now be [C, B, B, A]
  assert.deepEqual(
    player.tracks.map((t) => t.info.identifier),
    ['id-c', 'id-b', 'id-b', 'id-a'],
  );

  // getQueue returns currentPositionMs
  const snapshot = service.getQueue('g-q')!;
  assert.equal(snapshot.currentPositionMs, 42_000);

  // 2. moveTrack validation & movement (move pos 4 'id-a' -> pos 2)
  const samePos = await service.moveTrack('g-q', 2, 2);
  assert.equal(samePos.ok, false);
  const outRange = await service.moveTrack('g-q', 1, 9);
  assert.equal(outRange.ok, false);

  const movedBack = await service.moveTrack('g-q', 4, 2);
  assert.equal(movedBack.ok, true);
  assert.deepEqual(
    player.tracks.map((t) => t.info.identifier),
    ['id-c', 'id-a', 'id-b', 'id-b'],
  );

  const movedToEnd = await service.moveTrack('g-q', 1, 4);
  assert.equal(movedToEnd.ok, true);
  assert.deepEqual(
    player.tracks.map((t) => t.info.identifier),
    ['id-a', 'id-b', 'id-b', 'id-c'],
  );

  // 3. removeDuplicates removes 'id-a' (matches currentTrack) and second 'id-b'
  const deduped = await service.removeDuplicates('g-q');
  assert.equal(deduped.ok, true);
  if (deduped.ok) {
    assert.equal(deduped.removedCount, 2);
  }
  assert.deepEqual(
    player.tracks.map((t) => t.info.identifier),
    ['id-b', 'id-c'],
  );

  const noDups = await service.removeDuplicates('g-q');
  assert.equal(noDups.ok, true);
  if (noDups.ok) {
    assert.equal(noDups.removedCount, 0);
  }

  await service.shutdownGracefully();
  db.close();
});
