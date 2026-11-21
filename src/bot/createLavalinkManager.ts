import type { Client, Guild } from 'discord.js';
import {
  LavalinkManager,
  type LavalinkPlayer,
  type LavalinkPlayerVoice,
  type LavalinkTrack,
  type Player,
  type Track,
} from 'lavalink-client';
import { checkBotVoicePermissions } from '../commands/guards.js';
import type { EnvConfig } from '../config/env.js';
import type { SessionStoreRepository } from '../db/sessionStoreRepository.js';
import type { SqliteQueueStore } from '../db/sqliteQueueStore.js';
import type {
  GatewayPlayer,
  GatewaySearchQuery,
  GatewaySearchResult,
  GatewayTrack,
  LavalinkGateway,
  MusicService,
  ResumedPlayerInfo,
  SearchLoadType,
  VoiceChannelCheckResult,
} from '../music/musicService.js';
import type { AppLogger } from '../utils/logger.js';
import { countHumansInVoiceChannel } from './voiceStateHandler.js';

export const MAIN_NODE_ID = 'main';

const SPOTIFY_URI_PATTERN = /^spotify:(track|album|playlist|artist):([A-Za-z0-9_-]+)$/i;
const DISCORD_NOT_FOUND_OR_FORBIDDEN = new Set([10003, 10004]);
const DISCORD_MISSING_PERMS = new Set([50001, 50013]);

export interface CreateLavalinkManagerDeps {
  client: Client;
  env: EnvConfig;
  queueStore: SqliteQueueStore;
  sessionStore: SessionStoreRepository;
  logger: AppLogger;
}

export interface LavalinkBridge {
  lavalink: LavalinkManager;
  gateway: LavalinkGateway;
  bindEvents(musicService: MusicService): void;
}

function transformRequester(requester: unknown): unknown {
  if (!requester || typeof requester !== 'object') {
    return requester;
  }

  const record = requester as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : undefined;
  const tag = typeof record.tag === 'string' && record.tag.length > 0 ? record.tag : undefined;
  const username =
    typeof record.username === 'string' && record.username.length > 0 ? record.username : undefined;

  if (!id && !tag && !username) {
    return requester;
  }

  return {
    ...(id ? { id } : {}),
    ...(tag ? { tag } : {}),
    ...(username ? { username } : {}),
  };
}

function normalizeSearchQuery(searchQuery: GatewaySearchQuery): GatewaySearchQuery {
  if (searchQuery.source) {
    return searchQuery;
  }
  const match = SPOTIFY_URI_PATTERN.exec(searchQuery.query.trim());
  if (!match) {
    return searchQuery;
  }
  return {
    query: `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`,
  };
}

function extractDiscordErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function toGatewayTrack(track: Track | null | undefined): GatewayTrack | null {
  if (!track) {
    return null;
  }
  return track as unknown as GatewayTrack;
}

function safeBuildTrack(
  lavalink: LavalinkManager,
  rawTrack: LavalinkTrack | undefined,
): GatewayTrack | null {
  if (!rawTrack) {
    return null;
  }
  try {
    const built = lavalink.utils.buildTrack(rawTrack, rawTrack.userData?.requester);
    return toGatewayTrack(built);
  } catch {
    return null;
  }
}

/**
 * Creates a `LavalinkManager` configured for SQLite queue/session persistence,
 * `ytmsearch` fallback, and `MusicService`-owned disconnect/circuit-breaker lifecycles.
 */
export function createLavalinkManager(deps: CreateLavalinkManagerDeps): LavalinkBridge {
  const savedSessionId = deps.sessionStore.getNodeSessionId(MAIN_NODE_ID);
  const pendingAutoAdvance = new Map<string, GatewayTrack[]>();
  const resumedVoices = new Map<string, LavalinkPlayerVoice>();

  const lavalink = new LavalinkManager({
    nodes: [
      {
        id: MAIN_NODE_ID,
        host: deps.env.LAVALINK_HOST,
        port: deps.env.LAVALINK_PORT,
        authorization: deps.env.LAVALINK_PASSWORD,
        secure: deps.env.LAVALINK_SECURE,
        sessionId: savedSessionId ?? undefined,
        retryAmount: 100,
        retryDelay: 5_000,
      },
    ],
    sendToShard: (guildId, payload) => {
      deps.client.guilds.cache.get(guildId)?.shard?.send(payload);
    },
    client: {
      id: deps.env.DISCORD_CLIENT_ID,
      username: deps.client.user?.username ?? 'DiscordMusicBot',
    },
    autoSkip: true,
    autoSkipOnResolveError: true,
    queueOptions: {
      maxPreviousTracks: 25,
      queueStore: deps.queueStore,
    },
    playerOptions: {
      defaultSearchPlatform: 'ytmsearch',
      onDisconnect: {
        autoReconnect: false,
        destroyPlayer: false,
      },
      onEmptyQueue: {
        autoPlayFunction: undefined,
      },
      maxErrorsPerTime: {
        threshold: 0,
        maxAmount: 0,
      },
      requesterTransformer: transformRequester,
    },
  });

  function wrapPlayer(player: Player): GatewayPlayer {
    const queue = {
      get current(): GatewayTrack | null {
        return toGatewayTrack(player.queue.current as Track | null);
      },
      set current(value: GatewayTrack | null) {
        player.queue.current = value as Track | null;
      },
      get tracks(): readonly GatewayTrack[] {
        const snapshot = pendingAutoAdvance.get(player.guildId);
        if (snapshot && snapshot.length > 0) {
          return snapshot;
        }
        return player.queue.tracks as unknown as readonly GatewayTrack[];
      },
      add: (tracks: GatewayTrack | GatewayTrack[]) =>
        player.queue.add(tracks as unknown as Track | Track[]),
      shuffle: () => player.queue.shuffle(),
      splice: (index: number, amount: number) => player.queue.splice(index, amount),
    };

    return {
      get guildId() {
        return player.guildId;
      },
      get voiceChannelId() {
        return player.voiceChannelId;
      },
      get textChannelId() {
        return player.textChannelId;
      },
      set textChannelId(value: string | null) {
        player.textChannelId = value;
      },
      get playing() {
        return player.playing;
      },
      get paused() {
        return player.paused;
      },
      get volume() {
        return player.volume;
      },
      get position() {
        return player.position;
      },
      get repeatMode() {
        return player.repeatMode;
      },
      get connected() {
        return player.connected;
      },
      queue,
      connect: () => player.connect(),
      play: () => player.play(),
      pause: () => player.pause(),
      resume: () => player.resume(),
      skip: async (skipTo = 1, throwError = true) => {
        if (skipTo === 1 && pendingAutoAdvance.delete(player.guildId)) {
          return player;
        }
        return player.skip(skipTo, throwError);
      },
      stopPlaying: (clearQueue = true, executeAutoplay = false) => {
        pendingAutoAdvance.delete(player.guildId);
        return player.stopPlaying(clearQueue, executeAutoplay);
      },
      setVolume: (volume: number) => player.setVolume(volume),
      setRepeatMode: (mode) => player.setRepeatMode(mode),
      changeVoiceState: (data) => player.changeVoiceState(data),
    };
  }

  function findConnectedNode() {
    for (const node of lavalink.nodeManager.nodes.values()) {
      if (node.connected && node.sessionId) {
        return node;
      }
    }
    return null;
  }

  const gateway: LavalinkGateway = {
    hasConnectedNode(): boolean {
      return findConnectedNode() !== null;
    },

    isDiscordReady(): boolean {
      return deps.client.isReady();
    },

    isVoiceChannelEmpty(guildId: string): boolean {
      const guild = deps.client.guilds.cache.get(guildId);
      const botChannelId = guild?.members?.me?.voice?.channelId ?? null;
      if (!guild || !botChannelId) {
        return false;
      }
      const channel = guild.channels.cache.get(botChannelId);
      return countHumansInVoiceChannel(channel) === 0;
    },

    getPlayer(guildId: string): GatewayPlayer | null {
      const player = lavalink.getPlayer(guildId);
      return player ? wrapPlayer(player) : null;
    },

    createPlayer(options): GatewayPlayer {
      const player = lavalink.createPlayer({
        guildId: options.guildId,
        voiceChannelId: options.voiceChannelId,
        textChannelId: options.textChannelId,
        volume: options.volume,
        selfDeaf: options.selfDeaf ?? true,
      });
      return wrapPlayer(player);
    },

    async destroyPlayer(guildId: string, reason?: string): Promise<void> {
      pendingAutoAdvance.delete(guildId);
      if (lavalink.getPlayer(guildId)) {
        await lavalink.destroyPlayer(guildId, reason);
      }
    },

    async search(
      guildId: string,
      searchQuery: GatewaySearchQuery,
      requester: unknown,
    ): Promise<GatewaySearchResult> {
      const normalized = normalizeSearchQuery(searchQuery);
      const existingPlayer = lavalink.getPlayer(guildId);
      const node =
        existingPlayer?.node?.connected && existingPlayer.node.sessionId
          ? existingPlayer.node
          : findConnectedNode();

      if (!node) {
        throw new Error('Nenhum nó Lavalink conectado disponível para busca.');
      }

      const rawResult = await node.search(
        normalized.source
          ? { query: normalized.query, source: normalized.source }
          : { query: normalized.query },
        requester,
      );

      return {
        loadType: rawResult.loadType as SearchLoadType,
        tracks: rawResult.tracks as unknown as GatewayTrack[],
        playlist: rawResult.playlist
          ? {
              name: rawResult.playlist.name,
              title: rawResult.playlist.title,
              uri: rawResult.playlist.uri ?? null,
            }
          : null,
        exception: rawResult.exception
          ? {
              message: rawResult.exception.message,
              severity: rawResult.exception.severity,
              cause: rawResult.exception.cause,
            }
          : null,
      };
    },

    async updateSession(
      nodeId: string,
      resuming: boolean,
      timeoutSeconds: number,
    ): Promise<void> {
      const node = lavalink.nodeManager.getNode(nodeId);
      if (!node) {
        return;
      }
      await node.updateSession(resuming, timeoutSeconds);
    },

    async rehydratePlayer(options): Promise<GatewayPlayer | null> {
      const player = lavalink.createPlayer({
        guildId: options.guildId,
        voiceChannelId: options.voiceChannelId,
        textChannelId: options.textChannelId ?? undefined,
        volume: options.volume,
        selfDeaf: true,
      });

      const storedQueueRaw = await deps.queueStore.get(options.guildId);
      if (storedQueueRaw !== undefined) {
        try {
          await player.queue.utils.sync(true, true);
        } catch (error) {
          deps.logger.warn(
            { err: error, guildId: options.guildId },
            'Falha ao sincronizar fila persistida durante reidratação',
          );
        }
      }

      player.connected = true;
      player.paused = options.paused;
      player.repeatMode = options.repeatMode;
      player.voiceChannelId = options.voiceChannelId;
      player.textChannelId = options.textChannelId;
      player.queue.current = (options.currentTrack as Track | null) ?? null;
      player.playing = Boolean(player.queue.current);

      const voice = resumedVoices.get(options.guildId);
      if (voice) {
        resumedVoices.delete(options.guildId);
        player.voice = {
          token: voice.token,
          endpoint: voice.endpoint,
          sessionId: voice.sessionId,
          channelId: voice.channelId ?? options.voiceChannelId,
        };
      }

      return wrapPlayer(player);
    },

    async validateVoiceChannel(
      guildId: string,
      voiceChannelId: string,
    ): Promise<VoiceChannelCheckResult> {
      let guild: Guild | null = deps.client.guilds.cache.get(guildId) ?? null;
      if (!guild) {
        try {
          guild = await deps.client.guilds.fetch(guildId);
        } catch (error) {
          const code = extractDiscordErrorCode(error);
          if (code !== null && (DISCORD_NOT_FOUND_OR_FORBIDDEN.has(code) || DISCORD_MISSING_PERMS.has(code))) {
            return { ok: false, reason: 'GUILD_NOT_FOUND' };
          }
          return { ok: false, reason: 'TRANSIENT_ERROR', message: String(error) };
        }
      }

      let channel = guild.channels.cache.get(voiceChannelId) ?? null;
      if (!channel) {
        try {
          channel = await guild.channels.fetch(voiceChannelId);
        } catch (error) {
          const code = extractDiscordErrorCode(error);
          if (code === 10003) {
            return { ok: false, reason: 'CHANNEL_NOT_FOUND' };
          }
          if (code !== null && DISCORD_MISSING_PERMS.has(code)) {
            return { ok: false, reason: 'MISSING_PERMISSIONS' };
          }
          return { ok: false, reason: 'TRANSIENT_ERROR', message: String(error) };
        }
      }

      if (!channel || !channel.isVoiceBased()) {
        return { ok: false, reason: 'CHANNEL_NOT_FOUND' };
      }

      let botMember = guild.members.me ?? null;
      if (!botMember) {
        try {
          botMember = await guild.members.fetchMe();
        } catch (error) {
          const code = extractDiscordErrorCode(error);
          if (code !== null && DISCORD_MISSING_PERMS.has(code)) {
            return { ok: false, reason: 'MISSING_PERMISSIONS' };
          }
          return { ok: false, reason: 'TRANSIENT_ERROR', message: String(error) };
        }
      }

      const permsCheck = checkBotVoicePermissions(channel, botMember);
      if (!permsCheck.ok) {
        return {
          ok: false,
          reason: 'MISSING_PERMISSIONS',
          message: permsCheck.missing.join(', '),
        };
      }

      return { ok: true };
    },
  };

  function safeAsync(label: string, fn: () => Promise<void>): void {
    void fn().catch((error) => {
      deps.logger.error({ err: error, event: label }, 'Erro não tratado em evento do Lavalink');
    });
  }

  function bindEvents(musicService: MusicService): void {
    lavalink.nodeManager.on('connect', (node) => {
      deps.logger.info({ nodeId: node.id }, 'WebSocket do nó Lavalink conectado');
    });

    lavalink.nodeManager.on('disconnect', (node, reason) => {
      deps.logger.warn({ nodeId: node.id, reason }, 'Nó Lavalink desconectado');
    });

    lavalink.nodeManager.on('reconnecting', (node) => {
      deps.logger.info({ nodeId: node.id }, 'Reconectando ao nó Lavalink...');
    });

    lavalink.nodeManager.on('error', (node, error) => {
      deps.logger.error({ nodeId: node.id, err: error }, 'Erro no nó Lavalink');
    });

    lavalink.nodeManager.on('raw', (node, payload) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const record = payload as { op?: unknown; resumed?: unknown; sessionId?: unknown };
      if (
        record.op === 'ready' &&
        record.resumed === false &&
        typeof record.sessionId === 'string'
      ) {
        const sessionId = record.sessionId;
        node.options.sessionId = sessionId;
        // Wait a microtask so lavalink-client sets node.sessionId immediately after emitting 'raw'.
        queueMicrotask(() => {
          safeAsync('nodeReadyFresh', async () => {
            for (const player of Array.from(lavalink.players.values())) {
              if (player.node?.id === node.id) {
                player.setData('internal_destroywithoutdisconnect', true);
                player.connected = false;
                lavalink.deletePlayer(player.guildId);
              }
            }
            await musicService.handleNodeConnect(node.id, sessionId);
            await musicService.handleFreshNodeSession(node.id, sessionId);
          });
        });
      }
    });

    lavalink.nodeManager.on('resumed', (node, payload, rawPlayers) => {
      node.options.sessionId = payload.sessionId;
      safeAsync('nodeResumed', async () => {
        const playersArray: LavalinkPlayer[] = Array.isArray(rawPlayers) ? rawPlayers : [];
        resumedVoices.clear();
        for (const lp of playersArray) {
          if (lp.voice) {
            resumedVoices.set(lp.guildId, lp.voice);
          }
        }

        const resumedPlayers: ResumedPlayerInfo[] = playersArray.map((lp) => ({
          guildId: lp.guildId,
          voiceChannelId: lp.voice?.channelId ?? null,
          volume: lp.volume,
          paused: lp.paused,
          currentTrack: safeBuildTrack(lavalink, lp.track),
        }));

        try {
          await musicService.handleNodeConnect(node.id, payload.sessionId);
          await musicService.handleNodeResumed(node.id, payload.sessionId, resumedPlayers);
        } finally {
          resumedVoices.clear();
        }
      });
    });

    lavalink.on('trackStart', (player, track) => {
      safeAsync('trackStart', () =>
        musicService.handleTrackStart(player.guildId, toGatewayTrack(track)),
      );
    });

    lavalink.on('trackError', (player, track, payload) => {
      safeAsync('trackError', async () => {
        if (player.queue.tracks.length > 0) {
          pendingAutoAdvance.set(
            player.guildId,
            [...(player.queue.tracks as unknown as GatewayTrack[])],
          );
        }
        try {
          const reason =
            payload && typeof payload === 'object' && 'exception' in payload
              ? (payload as { exception?: { message?: string } }).exception?.message
              : payload instanceof Error
                ? payload.message
                : undefined;
          await musicService.handleTrackError(
            player.guildId,
            toGatewayTrack(track as Track | null),
            reason,
          );
        } finally {
          pendingAutoAdvance.delete(player.guildId);
        }
      });
    });

    lavalink.on('trackStuck', (player, track, payload) => {
      safeAsync('trackStuck', async () => {
        if (player.queue.tracks.length > 0) {
          pendingAutoAdvance.set(
            player.guildId,
            [...(player.queue.tracks as unknown as GatewayTrack[])],
          );
        }
        try {
          await musicService.handleTrackStuck(
            player.guildId,
            toGatewayTrack(track),
            payload?.thresholdMs,
          );
        } finally {
          pendingAutoAdvance.delete(player.guildId);
        }
      });
    });

    lavalink.on('queueEnd', (player) => {
      safeAsync('queueEnd', () => musicService.handleQueueEnd(player.guildId));
    });

    lavalink.on('playerSocketClosed', (player, payload) => {
      deps.logger.warn(
        {
          guildId: player.guildId,
          code: payload.code,
          reason: payload.reason,
          byRemote: payload.byRemote,
        },
        'WebSocket de voz fechado pelo Discord/Lavalink',
      );
    });
  }

  return { lavalink, gateway, bindEvents };
}
