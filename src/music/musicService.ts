import type { RepeatMode } from 'lavalink-client';
import type { GuildSettingsRepository } from '../db/guildSettingsRepository.js';
import type { ActivePlayerSession, SessionStoreRepository } from '../db/sessionStoreRepository.js';
import type { SqliteQueueStore } from '../db/sqliteQueueStore.js';
import type { AppLogger } from '../utils/logger.js';
import { TrackCircuitBreaker } from './circuitBreaker.js';
import {
  PanelTracker,
  type EditablePanelMessage,
  type PanelMessageRef,
  type PanelTrackView,
  type QueueTrackView,
} from './playerPanel.js';
import { classifyQuery } from './queryValidator.js';
import { TimerManager } from './timerManager.js';

export type { RepeatMode } from 'lavalink-client';

/**
 * Lavalink v4 `PATCH /v4/sessions/{sessionId}` expects `timeout` in seconds
 * (verified in `lavalink-client` `updateSession(resuming, timeout)` JSDoc and body serialization).
 */
export const LAVALINK_RESUME_TIMEOUT_SECONDS = 60;
export const DEFAULT_REJOIN_STAGGER_MS = 250;

const REPEAT_CYCLE_ORDER: readonly RepeatMode[] = ['off', 'track', 'queue'];

export type SearchLoadType = 'track' | 'playlist' | 'search' | 'empty' | 'error';

export interface GatewayTrack {
  encoded?: string;
  info: {
    identifier?: string;
    title: string;
    author?: string;
    duration?: number;
    uri?: string | null;
    artworkUrl?: string | null;
    isStream?: boolean;
  };
  requester?: unknown;
}

export interface GatewaySearchResult {
  loadType: SearchLoadType;
  tracks: GatewayTrack[];
  playlist?: {
    name?: string;
    title?: string;
    uri?: string | null;
  } | null;
  exception?: {
    message?: string;
    severity?: string;
    cause?: string;
  } | null;
}

export interface GatewayQueue {
  current: GatewayTrack | null;
  tracks: readonly GatewayTrack[];
  add(tracks: GatewayTrack | GatewayTrack[]): Promise<unknown>;
  shuffle(): Promise<unknown>;
  splice(index: number, amount: number): Promise<unknown>;
}

export interface GatewayPlayer {
  guildId: string;
  voiceChannelId: string | null;
  textChannelId: string | null;
  playing: boolean;
  paused: boolean;
  volume: number;
  position: number;
  repeatMode: RepeatMode;
  connected?: boolean;
  queue: GatewayQueue;
  connect(): Promise<unknown>;
  play(): Promise<unknown>;
  pause(): Promise<unknown>;
  resume(): Promise<unknown>;
  skip(skipTo?: number, throwError?: boolean): Promise<unknown>;
  stopPlaying(clearQueue?: boolean, executeAutoplay?: boolean): Promise<unknown>;
  setVolume(volume: number): Promise<unknown>;
  setRepeatMode(mode: RepeatMode): Promise<unknown>;
  changeVoiceState?(data: {
    voiceChannelId?: string;
    selfDeaf?: boolean;
    selfMute?: boolean;
  }): Promise<unknown>;
}

export interface CreatePlayerOptions {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  volume: number;
  selfDeaf?: boolean;
}

export interface ResumedPlayerInfo {
  guildId: string;
  voiceChannelId: string | null;
  volume: number;
  paused: boolean;
  currentTrack?: GatewayTrack | null;
}

export interface RehydratePlayerOptions {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string | null;
  volume: number;
  paused: boolean;
  repeatMode: RepeatMode;
  currentTrack?: GatewayTrack | null;
}

export type VoiceChannelCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'GUILD_NOT_FOUND' | 'CHANNEL_NOT_FOUND' | 'MISSING_PERMISSIONS' | 'TRANSIENT_ERROR';
      message?: string;
    };

export interface GatewaySearchQuery {
  query: string;
  source?: 'ytmsearch';
}

/**
 * Decoupled audio engine adapter isolating `MusicService` from `lavalink-client` internals.
 */
export interface LavalinkGateway {
  hasConnectedNode(): boolean;
  getPlayer(guildId: string): GatewayPlayer | null;
  createPlayer(options: CreatePlayerOptions): Promise<GatewayPlayer> | GatewayPlayer;
  destroyPlayer(guildId: string, reason?: string): Promise<void>;
  search(
    guildId: string,
    searchQuery: GatewaySearchQuery,
    requester: unknown,
  ): Promise<GatewaySearchResult>;
  updateSession(nodeId: string, resuming: boolean, timeoutSeconds: number): Promise<void>;
  rehydratePlayer(options: RehydratePlayerOptions): Promise<GatewayPlayer | null>;
  validateVoiceChannel(guildId: string, voiceChannelId: string): Promise<VoiceChannelCheckResult>;
  isDiscordReady?(): boolean;
  isVoiceChannelEmpty?(guildId: string): boolean;
}

export interface NowPlayingPanelPayload {
  track: PanelTrackView;
  paused: boolean;
  volume: number;
  repeatMode: RepeatMode;
  queueLength: number;
}

/**
 * Decoupled text-channel messaging adapter isolating `MusicService` from `discord.js`.
 */
export interface GuildMessenger {
  sendMessage(channelId: string, content: string): Promise<void>;
  sendNowPlayingPanel(
    channelId: string,
    payload: NowPlayingPanelPayload,
  ): Promise<PanelMessageRef | null>;
  fetchPanelMessage(ref: PanelMessageRef): Promise<EditablePanelMessage | null | undefined>;
}

export interface PlayInput {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  query: string;
  requester: unknown;
}

export type PlayResult =
  | {
      ok: true;
      isPlaylist: boolean;
      playlistName: string | null;
      tracks: GatewayTrack[];
      firstTrack: GatewayTrack;
      addedCount: number;
      truncatedCount: number;
      startedImmediately: boolean;
      message: string;
    }
  | {
      ok: false;
      reason:
        | 'EMPTY'
        | 'UNSUPPORTED_URL'
        | 'SPOTIFY_DISABLED'
        | 'NO_NODE'
        | 'QUEUE_FULL'
        | 'LOAD_FAILED'
        | 'NOT_FOUND';
      message: string;
    };

export type ActionFailureReason =
  | 'NO_PLAYER'
  | 'NO_ACTIVE_TRACK'
  | 'ALREADY_PAUSED'
  | 'NOT_PAUSED'
  | 'EMPTY_QUEUE'
  | 'INVALID_AMOUNT'
  | 'INVALID_POSITION'
  | 'INVALID_VOLUME'
  | 'OUT_OF_RANGE'
  | 'NO_NODE';

export type ActionFailure = {
  ok: false;
  reason: ActionFailureReason;
  message: string;
};

export type PauseResumeResult =
  | { ok: true; paused: boolean; message: string }
  | ActionFailure;

export type SkipResult =
  | {
      ok: true;
      skippedTitle: string | null;
      endedQueue: boolean;
      message: string;
    }
  | ActionFailure;

export type StopResult =
  | { ok: true; disconnected: boolean; message: string }
  | ActionFailure;

export type ShuffleResult =
  | { ok: true; queueLength: number; message: string }
  | ActionFailure;

export type LoopResult =
  | { ok: true; repeatMode: RepeatMode; message: string }
  | ActionFailure;

export type VolumeResult =
  | { ok: true; volume: number; message: string }
  | ActionFailure;

export type RemoveResult =
  | { ok: true; removedTrack: GatewayTrack; position: number; message: string }
  | ActionFailure;

export type ClearQueueResult =
  | { ok: true; clearedCount: number; message: string }
  | ActionFailure;

export type Ensure247Result =
  | { ok: true; alreadyConnected: boolean }
  | ActionFailure;

export interface NowPlayingSnapshot {
  track: PanelTrackView;
  paused: boolean;
  volume: number;
  repeatMode: RepeatMode;
  queueLength: number;
  voiceChannelId: string | null;
  textChannelId: string | null;
}

export interface QueueSnapshot {
  currentTrack: QueueTrackView | null;
  queue: QueueTrackView[];
  repeatMode: RepeatMode;
  paused: boolean;
  volume: number;
}

export interface MusicServiceDeps {
  gateway: LavalinkGateway;
  messenger: GuildMessenger;
  settingsRepo: GuildSettingsRepository;
  sessionStore: SessionStoreRepository;
  queueStore: SqliteQueueStore;
  logger: AppLogger;
  spotifyEnabled: boolean;
  maxQueueSize: number;
  timerManager?: TimerManager;
  circuitBreaker?: TrackCircuitBreaker;
  panelTracker?: PanelTracker;
  rejoinStaggerMs?: number;
}

function extractRequesterInfo(requester: unknown): {
  requesterId: string | null;
  requesterTag: string | null;
} {
  if (!requester || typeof requester !== 'object') {
    return { requesterId: null, requesterTag: null };
  }

  const record = requester as Record<string, unknown>;
  const requesterId = typeof record.id === 'string' && record.id.length > 0 ? record.id : null;
  const tag =
    typeof record.tag === 'string' && record.tag.length > 0
      ? record.tag
      : typeof record.username === 'string' && record.username.length > 0
        ? record.username
        : null;

  return { requesterId, requesterTag: tag };
}

function toQueueTrackView(track: GatewayTrack): QueueTrackView {
  const { requesterId, requesterTag } = extractRequesterInfo(track.requester);
  return {
    title: track.info.title,
    author: track.info.author ?? 'Desconhecido',
    uri: track.info.uri ?? null,
    durationMs: track.info.duration ?? 0,
    isStream: Boolean(track.info.isStream),
    requesterId,
    requesterTag,
  };
}

function toPanelTrackView(track: GatewayTrack, positionMs: number): PanelTrackView {
  const base = toQueueTrackView(track);
  return {
    ...base,
    artworkUrl: track.info.artworkUrl ?? null,
    positionMs: Math.max(0, positionMs),
  };
}

function formatRepeatModePtBr(mode: RepeatMode): string {
  switch (mode) {
    case 'track':
      return 'Música';
    case 'queue':
      return 'Fila';
    default:
      return 'Desativado';
  }
}

/**
 * Decoupled core orchestration service for guild music playback, queue enforcement,
 * interactive panels, 24/7 persistence, circuit-breaker recovery, and session resume.
 */
export class MusicService {
  private readonly gateway: LavalinkGateway;
  private readonly messenger: GuildMessenger;
  private readonly settingsRepo: GuildSettingsRepository;
  private readonly sessionStore: SessionStoreRepository;
  private readonly queueStore: SqliteQueueStore;
  private readonly logger: AppLogger;
  private readonly spotifyEnabled: boolean;
  private readonly maxQueueSize: number;
  private readonly rejoinStaggerMs: number;
  private readonly timers: TimerManager;
  private readonly circuitBreaker: TrackCircuitBreaker;
  private readonly panelTracker: PanelTracker;

  private readonly botInitiatedDisconnects = new Set<string>();
  private readonly disconnectingGuilds = new Set<string>();
  private readonly emptyGuildChannels = new Set<string>();
  private readonly pausedByEmptyChannel = new Set<string>();
  private readonly staggerHandles = new Set<NodeJS.Timeout>();
  private shuttingDown = false;

  constructor(deps: MusicServiceDeps) {
    this.gateway = deps.gateway;
    this.messenger = deps.messenger;
    this.settingsRepo = deps.settingsRepo;
    this.sessionStore = deps.sessionStore;
    this.queueStore = deps.queueStore;
    this.logger = deps.logger;
    this.spotifyEnabled = deps.spotifyEnabled;
    this.maxQueueSize = deps.maxQueueSize;
    this.rejoinStaggerMs = deps.rejoinStaggerMs ?? DEFAULT_REJOIN_STAGGER_MS;
    this.timers =
      deps.timerManager ??
      new TimerManager((guildId, error) => {
        this.logger.error({ guildId, err: error }, 'Erro no timer de saída automática');
      });
    this.circuitBreaker = deps.circuitBreaker ?? new TrackCircuitBreaker(3);
    this.panelTracker =
      deps.panelTracker ??
      new PanelTracker((error) => {
        this.logger.warn({ err: error }, 'Erro inesperado ao desabilitar painel');
      });
  }

  /**
   * Validates, searches, enforces `maxQueueSize`, ensures voice connection, and starts/queues playback.
   */
  async play(input: PlayInput): Promise<PlayResult> {
    const classification = classifyQuery(input.query, this.spotifyEnabled);
    if (!classification.ok) {
      return {
        ok: false,
        reason: classification.reason,
        message: classification.message,
      };
    }

    if (!this.gateway.hasConnectedNode()) {
      return {
        ok: false,
        reason: 'NO_NODE',
        message: 'O servidor de áudio está reconectando, tente novamente em alguns segundos.',
      };
    }

    const existingBeforeSearch = this.gateway.getPlayer(input.guildId);
    if (existingBeforeSearch && existingBeforeSearch.queue.tracks.length >= this.maxQueueSize) {
      return {
        ok: false,
        reason: 'QUEUE_FULL',
        message: `A fila atingiu o limite máximo de **${this.maxQueueSize}** músicas. Remova músicas ou limpe a fila antes de adicionar novas.`,
      };
    }

    const searchQuery: GatewaySearchQuery =
      classification.kind === 'search'
        ? { query: classification.query, source: classification.source }
        : { query: classification.query };

    let searchResult: GatewaySearchResult;
    try {
      searchResult = await this.gateway.search(input.guildId, searchQuery, input.requester);
    } catch (error) {
      this.logger.warn({ err: error, guildId: input.guildId }, 'Falha ao buscar música no Lavalink');
      return {
        ok: false,
        reason: 'LOAD_FAILED',
        message: 'Não foi possível carregar a música ou playlist solicitada.',
      };
    }

    if (searchResult.loadType === 'error') {
      this.logger.warn(
        { guildId: input.guildId, exception: searchResult.exception },
        'Lavalink retornou erro na busca',
      );
      return {
        ok: false,
        reason: 'LOAD_FAILED',
        message: 'Não foi possível carregar a música ou playlist solicitada.',
      };
    }

    if (searchResult.loadType === 'empty' || searchResult.tracks.length === 0) {
      return {
        ok: false,
        reason: 'NOT_FOUND',
        message: 'Nenhuma música foi encontrada para essa busca.',
      };
    }

    const isPlaylist = searchResult.loadType === 'playlist';
    const candidates = isPlaylist ? searchResult.tracks : [searchResult.tracks[0]];

    const existingAfterSearch = this.gateway.getPlayer(input.guildId);
    const currentQueueLength = existingAfterSearch ? existingAfterSearch.queue.tracks.length : 0;
    const availableSlots = Math.max(0, this.maxQueueSize - currentQueueLength);
    if (availableSlots === 0) {
      return {
        ok: false,
        reason: 'QUEUE_FULL',
        message: `A fila atingiu o limite máximo de **${this.maxQueueSize}** músicas. Remova músicas ou limpe a fila antes de adicionar novas.`,
      };
    }

    const tracksToAdd = candidates.slice(0, availableSlots);
    const addedCount = tracksToAdd.length;
    const truncatedCount = candidates.length - addedCount;

    this.timers.cancel(input.guildId);
    this.botInitiatedDisconnects.delete(input.guildId);
    this.pausedByEmptyChannel.delete(input.guildId);

    const settings = this.settingsRepo.getOrDefault(input.guildId);
    const { player } = await this.ensureVoicePlayer(
      input.guildId,
      input.voiceChannelId,
      input.textChannelId,
      settings.defaultVolume,
    );

    if (settings.alwaysOn247) {
      this.settingsRepo.update(input.guildId, {
        voiceChannelId247: input.voiceChannelId,
        textChannelId247: input.textChannelId,
      });
    }

    await player.queue.add(tracksToAdd);

    const startedImmediately = !player.playing && !player.queue.current;
    if (startedImmediately) {
      await player.play();
    }

    this.persistActiveSession(input.guildId, player, input.voiceChannelId, input.textChannelId);

    const firstTrack = tracksToAdd[0];
    const playlistName =
      isPlaylist ? (searchResult.playlist?.title ?? searchResult.playlist?.name ?? 'Playlist') : null;

    let message: string;
    if (isPlaylist) {
      message =
        truncatedCount > 0
          ? `Playlist **${playlistName}** adicionada com **${addedCount}** músicas (${truncatedCount} ignoradas pelo limite de ${this.maxQueueSize} da fila).`
          : `Playlist **${playlistName}** adicionada com **${addedCount}** músicas.`;
    } else {
      const author = firstTrack.info.author ?? 'Desconhecido';
      message = startedImmediately
        ? `Tocando agora: **${firstTrack.info.title}** — ${author}.`
        : `Adicionada à fila: **${firstTrack.info.title}** — ${author}.`;
    }

    return {
      ok: true,
      isPlaylist,
      playlistName,
      tracks: tracksToAdd,
      firstTrack,
      addedCount,
      truncatedCount,
      startedImmediately,
      message,
    };
  }

  /**
   * Pauses the currently playing track.
   */
  async pause(guildId: string): Promise<PauseResumeResult> {
    const active = this.requireActivePlaybackPlayer(guildId);
    if (!active.ok) {
      return active.failure;
    }

    const { player } = active;
    if (player.paused) {
      return {
        ok: false,
        reason: 'ALREADY_PAUSED',
        message: 'A reprodução já está pausada.',
      };
    }

    this.pausedByEmptyChannel.delete(guildId);
    await player.pause();
    return { ok: true, paused: true, message: 'Reprodução pausada.' };
  }

  /**
   * Resumes a paused track.
   */
  async resume(guildId: string): Promise<PauseResumeResult> {
    const active = this.requireActivePlaybackPlayer(guildId);
    if (!active.ok) {
      return active.failure;
    }

    const { player } = active;
    if (!player.paused) {
      return {
        ok: false,
        reason: 'NOT_PAUSED',
        message: 'A reprodução não está pausada.',
      };
    }

    this.pausedByEmptyChannel.delete(guildId);
    await player.resume();
    return { ok: true, paused: false, message: 'Reprodução retomada.' };
  }

  /**
   * Toggles between paused and playing states for the active track.
   */
  async togglePause(guildId: string): Promise<PauseResumeResult> {
    const active = this.requireActivePlaybackPlayer(guildId);
    if (!active.ok) {
      return active.failure;
    }

    const { player } = active;
    this.pausedByEmptyChannel.delete(guildId);
    if (player.paused) {
      await player.resume();
      return { ok: true, paused: false, message: 'Reprodução retomada.' };
    }

    await player.pause();
    return { ok: true, paused: true, message: 'Reprodução pausada.' };
  }

  /**
   * Skips `amount` tracks, safely stopping the queue if `amount` exceeds remaining queued tracks.
   */
  async skip(guildId: string, amount = 1): Promise<SkipResult> {
    if (!Number.isInteger(amount) || amount < 1) {
      return {
        ok: false,
        reason: 'INVALID_AMOUNT',
        message: 'Informe uma quantidade válida (mínimo 1).',
      };
    }

    const active = this.requireActivePlaybackPlayer(guildId);
    if (!active.ok) {
      return active.failure;
    }

    const { player } = active;

    const skippedTitle = player.queue.current?.info.title ?? null;
    this.pausedByEmptyChannel.delete(guildId);

    if (amount > player.queue.tracks.length) {
      await player.stopPlaying(true, false);
      await this.disableActivePanel(guildId);
      this.persistActiveSession(guildId, player, undefined, undefined, null);

      const settings = this.settingsRepo.getOrDefault(guildId);
      if (!settings.alwaysOn247) {
        this.scheduleAutoLeave(guildId, settings.autoLeaveSeconds);
      }

      return {
        ok: true,
        skippedTitle,
        endedQueue: true,
        message: 'Fila encerrada. Não há mais músicas para reproduzir.',
      };
    }

    await player.skip(amount);
    return {
      ok: true,
      skippedTitle,
      endedQueue: false,
      message:
        amount === 1
          ? `Música pulada${skippedTitle ? `: **${skippedTitle}**` : ''}.`
          : `Puladas **${amount}** músicas.`,
    };
  }

  /**
   * Stops playback and clears the queue, disconnecting only when 24/7 mode is disabled.
   */
  async stop(guildId: string): Promise<StopResult> {
    const player = this.gateway.getPlayer(guildId);
    if (!player) {
      return {
        ok: false,
        reason: 'NO_PLAYER',
        message: 'Não há nenhuma reprodução ativa no momento.',
      };
    }

    this.timers.cancel(guildId);
    this.circuitBreaker.reset(guildId);
    this.pausedByEmptyChannel.delete(guildId);
    await this.disableActivePanel(guildId);
    await player.stopPlaying(true, false);

    const settings = this.settingsRepo.getOrDefault(guildId);
    if (settings.alwaysOn247) {
      this.persistActiveSession(guildId, player, undefined, undefined, null);
      return {
        ok: true,
        disconnected: false,
        message: 'Reprodução parada e fila limpa. Permanecendo no canal de voz (modo 24/7).',
      };
    }

    await this.disconnectBotInitiated(guildId, 'stop');
    return {
      ok: true,
      disconnected: true,
      message: 'Reprodução parada, fila limpa e desconectado do canal de voz.',
    };
  }

  /**
   * Shuffles upcoming queued tracks while keeping the current track playing.
   */
  async shuffle(guildId: string): Promise<ShuffleResult> {
    const active = this.requireActivePlaybackPlayer(guildId);
    if (!active.ok) {
      return active.failure;
    }

    const { player } = active;
    if (player.queue.tracks.length === 0) {
      return {
        ok: false,
        reason: 'EMPTY_QUEUE',
        message: 'Não há músicas na fila para embaralhar.',
      };
    }

    await player.queue.shuffle();
    return {
      ok: true,
      queueLength: player.queue.tracks.length,
      message: 'Fila embaralhada com sucesso!',
    };
  }

  /**
   * Sets the guild player's repeat mode (`off` | `track` | `queue`) and persists it.
   */
  async setLoop(guildId: string, mode: RepeatMode): Promise<LoopResult> {
    const player = this.gateway.getPlayer(guildId);
    if (!player) {
      return {
        ok: false,
        reason: 'NO_PLAYER',
        message: 'Não há nenhuma reprodução ativa no momento.',
      };
    }

    await player.setRepeatMode(mode);
    this.persistActiveSession(guildId, player);

    return {
      ok: true,
      repeatMode: mode,
      message: `Modo de repetição: **${formatRepeatModePtBr(mode)}**.`,
    };
  }

  /**
   * Cycles the guild player's repeat mode across `off -> track -> queue -> off`.
   */
  async cycleLoop(guildId: string): Promise<LoopResult> {
    const active = this.requireActivePlaybackPlayer(guildId);
    if (!active.ok) {
      return active.failure;
    }

    const { player } = active;
    const currentIndex = REPEAT_CYCLE_ORDER.indexOf(player.repeatMode);
    const nextMode = REPEAT_CYCLE_ORDER[(currentIndex + 1) % REPEAT_CYCLE_ORDER.length];
    return this.setLoop(guildId, nextMode);
  }

  /**
   * Adjusts active session volume within `0..150`.
   */
  async setVolume(guildId: string, volume: number): Promise<VolumeResult> {
    if (!Number.isInteger(volume) || volume < 0 || volume > 150) {
      return {
        ok: false,
        reason: 'INVALID_VOLUME',
        message: 'O volume deve ser um número inteiro entre 0 e 150.',
      };
    }

    const player = this.gateway.getPlayer(guildId);
    if (!player) {
      return {
        ok: false,
        reason: 'NO_PLAYER',
        message: 'Não há nenhum player ativo no momento.',
      };
    }

    await player.setVolume(volume);
    return {
      ok: true,
      volume,
      message: `Volume ajustado para **${volume}%**.`,
    };
  }

  /**
   * Removes a 1-indexed track from the upcoming queue.
   */
  async remove(guildId: string, position: number): Promise<RemoveResult> {
    if (!Number.isInteger(position) || position < 1) {
      return {
        ok: false,
        reason: 'INVALID_POSITION',
        message: 'Informe uma posição válida (mínimo 1).',
      };
    }

    const player = this.gateway.getPlayer(guildId);
    if (!player) {
      return {
        ok: false,
        reason: 'NO_PLAYER',
        message: 'Não há nenhuma reprodução ativa no momento.',
      };
    }

    if (player.queue.tracks.length === 0) {
      return {
        ok: false,
        reason: 'EMPTY_QUEUE',
        message: 'A fila está vazia.',
      };
    }

    const index = position - 1;
    if (index < 0 || index >= player.queue.tracks.length) {
      const total = player.queue.tracks.length;
      return {
        ok: false,
        reason: 'OUT_OF_RANGE',
        message: `Posição inválida. A fila possui **${total}** ${total === 1 ? 'música' : 'músicas'}.`,
      };
    }

    const removedTrack = player.queue.tracks[index];
    await player.queue.splice(index, 1);

    return {
      ok: true,
      removedTrack,
      position,
      message: `Removida da fila (posição **${position}**): **${removedTrack.info.title}**.`,
    };
  }

  /**
   * Clears all upcoming tracks from the queue while keeping the current track playing.
   */
  async clearQueue(guildId: string): Promise<ClearQueueResult> {
    const player = this.gateway.getPlayer(guildId);
    if (!player) {
      return {
        ok: false,
        reason: 'NO_PLAYER',
        message: 'Não há nenhuma reprodução ativa no momento.',
      };
    }

    const clearedCount = player.queue.tracks.length;
    if (clearedCount === 0) {
      return {
        ok: false,
        reason: 'EMPTY_QUEUE',
        message: 'A fila já está vazia.',
      };
    }

    await player.queue.splice(0, clearedCount);
    return {
      ok: true,
      clearedCount,
      message: `Fila limpa (**${clearedCount}** ${clearedCount === 1 ? 'música removida' : 'músicas removidas'}).`,
    };
  }

  /**
   * Returns a view snapshot for the currently playing track, or `null` when idle.
   */
  getNowPlaying(guildId: string): NowPlayingSnapshot | null {
    const player = this.gateway.getPlayer(guildId);
    if (!player || !player.queue.current) {
      return null;
    }

    return {
      track: toPanelTrackView(player.queue.current, player.position ?? 0),
      paused: player.paused,
      volume: player.volume,
      repeatMode: player.repeatMode,
      queueLength: player.queue.tracks.length,
      voiceChannelId: player.voiceChannelId,
      textChannelId: player.textChannelId,
    };
  }

  /**
   * Returns a view snapshot for the guild's current track and queued tracks, or `null` when empty.
   */
  getQueue(guildId: string): QueueSnapshot | null {
    const player = this.gateway.getPlayer(guildId);
    if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
      return null;
    }

    return {
      currentTrack: player.queue.current ? toQueueTrackView(player.queue.current) : null,
      queue: player.queue.tracks.map(toQueueTrackView),
      repeatMode: player.repeatMode,
      paused: player.paused,
      volume: player.volume,
    };
  }

  /**
   * Registers a manually posted Now Playing panel (e.g. from `/nowplaying`) after disabling any prior one.
   */
  async registerPanel(guildId: string, ref: PanelMessageRef): Promise<void> {
    await this.disableActivePanel(guildId);
    this.panelTracker.setPanel(guildId, ref);
    const player = this.gateway.getPlayer(guildId);
    if (player) {
      this.persistActiveSession(guildId, player, undefined, ref.channelId, ref);
    }
  }

  /**
   * Immediately connects the bot to the configured 24/7 voice channel when enabled.
   */
  async ensureConnected247(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
  ): Promise<Ensure247Result> {
    this.timers.cancel(guildId);
    this.botInitiatedDisconnects.delete(guildId);

    if (!this.gateway.hasConnectedNode()) {
      this.logger.warn({ guildId }, 'Sem nó Lavalink conectado para entrada imediata em modo 24/7');
      return {
        ok: false,
        reason: 'NO_NODE',
        message: 'O servidor de áudio está reconectando, tente novamente em alguns segundos.',
      };
    }

    const settings = this.settingsRepo.getOrDefault(guildId);
    const { player, created } = await this.ensureVoicePlayer(
      guildId,
      voiceChannelId,
      textChannelId,
      settings.defaultVolume,
    );
    this.persistActiveSession(
      guildId,
      player,
      voiceChannelId,
      textChannelId,
      created ? null : undefined,
    );

    return { ok: true, alreadyConnected: !created };
  }

  /**
   * Handles disabling 24/7 mode by scheduling auto-leave if the player is currently idle or alone in voice.
   */
  async handle247Disabled(guildId: string): Promise<void> {
    const player = this.gateway.getPlayer(guildId);
    if (!player) {
      this.timers.cancel(guildId);
      return;
    }

    const isIdle = !player.playing && !player.queue.current;
    const isEmpty =
      this.emptyGuildChannels.has(guildId) || Boolean(this.gateway.isVoiceChannelEmpty?.(guildId));

    if (isIdle || isEmpty) {
      const settings = this.settingsRepo.getOrDefault(guildId);
      this.scheduleAutoLeave(guildId, settings.autoLeaveSeconds);
    }
  }

  /**
   * Handles Lavalink `trackStart`: resets circuit breaker, disables old panel, sends new panel, and persists state.
   */
  async handleTrackStart(guildId: string, track: GatewayTrack | null = null): Promise<void> {
    this.circuitBreaker.recordSuccess(guildId);
    this.timers.cancel(guildId);
    this.botInitiatedDisconnects.delete(guildId);
    this.pausedByEmptyChannel.delete(guildId);

    await this.disableActivePanel(guildId);

    const player = this.gateway.getPlayer(guildId);
    if (!player) {
      return;
    }

    const activeTrack = track ?? player.queue.current;
    if (!activeTrack) {
      return;
    }

    const textChannelId = this.resolveTextChannelId(guildId, player);
    let panelRef: PanelMessageRef | null = null;
    if (textChannelId) {
      try {
        panelRef = await this.messenger.sendNowPlayingPanel(textChannelId, {
          track: toPanelTrackView(activeTrack, 0),
          paused: player.paused,
          volume: player.volume,
          repeatMode: player.repeatMode,
          queueLength: player.queue.tracks.length,
        });
        if (panelRef) {
          this.panelTracker.setPanel(guildId, panelRef);
        }
      } catch (error) {
        this.logger.warn(
          { err: error, guildId, textChannelId },
          'Falha ao enviar painel Tocando Agora',
        );
      }
    }

    this.persistActiveSession(guildId, player, undefined, textChannelId ?? undefined, panelRef);
  }

  /**
   * Handles Lavalink `trackError` using the consecutive failure circuit breaker.
   */
  async handleTrackError(
    guildId: string,
    track: GatewayTrack | null = null,
    reason?: string,
  ): Promise<void> {
    await this.handlePlaybackFailure(guildId, 'error', track, reason);
  }

  /**
   * Handles Lavalink `trackStuck` using the consecutive failure circuit breaker.
   */
  async handleTrackStuck(
    guildId: string,
    track: GatewayTrack | null = null,
    thresholdMs?: number,
  ): Promise<void> {
    const detail = thresholdMs !== undefined ? `stuck > ${thresholdMs}ms` : 'stuck';
    await this.handlePlaybackFailure(guildId, 'stuck', track, detail);
  }

  /**
   * Handles Lavalink `queueEnd`: disables active panel and schedules auto-leave when 24/7 is disabled.
   */
  async handleQueueEnd(guildId: string): Promise<void> {
    await this.disableActivePanel(guildId);
    this.pausedByEmptyChannel.delete(guildId);

    const player = this.gateway.getPlayer(guildId);
    const settings = this.settingsRepo.getOrDefault(guildId);

    if (player) {
      this.persistActiveSession(guildId, player, undefined, undefined, null);
    }

    if (!settings.alwaysOn247 && player) {
      this.scheduleAutoLeave(guildId, settings.autoLeaveSeconds);
    }
  }

  /**
   * Handles all human listeners leaving the bot's voice channel.
   */
  async handleVoiceChannelEmpty(guildId: string): Promise<void> {
    this.emptyGuildChannels.add(guildId);
    const player = this.gateway.getPlayer(guildId);
    if (!player) {
      return;
    }

    const settings = this.settingsRepo.getOrDefault(guildId);
    if (settings.alwaysOn247) {
      if (player.playing && !player.paused) {
        await player.pause();
        this.pausedByEmptyChannel.add(guildId);
      }
      return;
    }

    this.scheduleAutoLeave(guildId, settings.autoLeaveSeconds);
  }

  /**
   * Handles a human listener joining the bot's voice channel: cancels auto-leave and resumes 24/7 idle pause.
   */
  async handleVoiceHumanJoined(guildId: string): Promise<void> {
    this.emptyGuildChannels.delete(guildId);
    this.timers.cancel(guildId);

    if (!this.pausedByEmptyChannel.delete(guildId)) {
      return;
    }

    const player = this.gateway.getPlayer(guildId);
    if (player && player.paused && player.queue.current) {
      await player.resume();
    }
  }

  /**
   * Cleans up guild player state after voice disconnection, clearing 24/7 channel binding
   * ONLY on external/moderator disconnects (preserving it on bot-initiated disconnects).
   */
  async handleVoiceDisconnect(guildId: string): Promise<void> {
    if (this.disconnectingGuilds.has(guildId)) {
      return;
    }

    this.timers.cancel(guildId);
    this.circuitBreaker.reset(guildId);
    this.emptyGuildChannels.delete(guildId);
    this.pausedByEmptyChannel.delete(guildId);
    await this.disableActivePanel(guildId);
    this.sessionStore.deleteActivePlayer(guildId);

    const wasBotInitiated = this.botInitiatedDisconnects.delete(guildId);
    const player = this.gateway.getPlayer(guildId);
    if (player) {
      this.disconnectingGuilds.add(guildId);
      try {
        await this.gateway.destroyPlayer(
          guildId,
          wasBotInitiated ? 'botDisconnect' : 'voiceDisconnect',
        );
      } finally {
        this.disconnectingGuilds.delete(guildId);
      }
    }

    if (!wasBotInitiated) {
      const settings = this.settingsRepo.getOrDefault(guildId);
      if (settings.voiceChannelId247 !== null || settings.textChannelId247 !== null) {
        this.settingsRepo.clear247Channel(guildId);
        this.logger.info(
          { guildId },
          'Desconexão externa detectada; canal 24/7 limpo para não reconectar à força',
        );
      }
    }
  }

  /**
   * Saves the Lavalink node `sessionId` and enables 60-second session resuming on Lavalink.
   */
  async handleNodeConnect(nodeId: string, sessionId: string | null | undefined): Promise<void> {
    if (!sessionId) {
      this.logger.warn({ nodeId }, 'Nó Lavalink conectado sem sessionId; ignorando updateSession');
      return;
    }

    this.sessionStore.saveNodeSessionId(nodeId, sessionId);
    try {
      await this.gateway.updateSession(nodeId, true, LAVALINK_RESUME_TIMEOUT_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, nodeId },
        'Falha ao habilitar resuming da sessão no nó Lavalink',
      );
    }
  }

  /**
   * Rehydrates players and active panel tracking from SQLite after a resumed Lavalink session,
   * purges stale orphaned sessions, and rejoins any non-resumed 24/7 guilds.
   */
  async handleNodeResumed(
    nodeId: string,
    sessionId: string,
    resumedPlayers: readonly ResumedPlayerInfo[],
  ): Promise<void> {
    if (sessionId) {
      this.sessionStore.saveNodeSessionId(nodeId, sessionId);
    }

    const savedByGuild = new Map<string, ActivePlayerSession>(
      this.sessionStore.listActivePlayers().map((s) => [s.guildId, s]),
    );
    const resumedGuildIds = new Set<string>();

    for (const resumed of resumedPlayers) {
      const saved = savedByGuild.get(resumed.guildId);
      const settings = this.settingsRepo.getOrDefault(resumed.guildId);
      const voiceChannelId =
        resumed.voiceChannelId ?? saved?.voiceChannelId ?? settings.voiceChannelId247;
      if (!voiceChannelId) {
        this.logger.warn(
          { guildId: resumed.guildId },
          'Player retomado sem voiceChannelId; ignorando reidratação',
        );
        continue;
      }

      const textChannelId = saved?.textChannelId ?? settings.textChannelId247 ?? null;
      const repeatMode: RepeatMode = saved?.repeatMode ?? 'off';

      const player = await this.gateway.rehydratePlayer({
        guildId: resumed.guildId,
        voiceChannelId,
        textChannelId,
        volume: resumed.volume,
        paused: resumed.paused,
        repeatMode,
        currentTrack: resumed.currentTrack ?? null,
      });

      if (!player) {
        continue;
      }

      resumedGuildIds.add(resumed.guildId);
      this.botInitiatedDisconnects.delete(resumed.guildId);

      if (saved?.panelChannelId && saved.panelMessageId) {
        this.panelTracker.setPanel(resumed.guildId, {
          channelId: saved.panelChannelId,
          messageId: saved.panelMessageId,
        });
      }

      if (!saved && textChannelId) {
        this.sessionStore.saveActivePlayer({
          guildId: resumed.guildId,
          voiceChannelId,
          textChannelId,
          repeatMode,
          panelChannelId: null,
          panelMessageId: null,
        });
      }
    }

    for (const [guildId, saved] of savedByGuild) {
      if (resumedGuildIds.has(guildId)) {
        continue;
      }

      if (saved.panelChannelId && saved.panelMessageId) {
        this.panelTracker.setPanel(guildId, {
          channelId: saved.panelChannelId,
          messageId: saved.panelMessageId,
        });
        await this.disableActivePanel(guildId);
      }

      this.sessionStore.deleteActivePlayer(guildId);
      await this.queueStore.delete(guildId);
    }

    await this.rejoin247Guilds(resumedGuildIds);
  }

  /**
   * Purges obsolete queue and session rows after an expired/fresh Lavalink session
   * and triggers staggered 24/7 voice channel reconnection.
   */
  async handleFreshNodeSession(nodeId?: string, sessionId?: string): Promise<void> {
    if (nodeId && sessionId) {
      this.sessionStore.saveNodeSessionId(nodeId, sessionId);
    }

    const active = this.sessionStore.listActivePlayers();
    for (const session of active) {
      this.panelTracker.clearPanel(session.guildId);
    }

    this.queueStore.clearAll();
    this.sessionStore.clearAllActivePlayers();

    await this.rejoin247Guilds();
  }

  /**
   * Reconnects configured 24/7 guilds (excluding already-resumed ones) with `250ms` staggering,
   * clearing invalid or permissionless channels cleanly without crashing boot.
   */
  async rejoin247Guilds(excludeGuildIds?: ReadonlySet<string>): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (this.gateway.isDiscordReady && !this.gateway.isDiscordReady()) {
      return;
    }

    if (!this.gateway.hasConnectedNode()) {
      return;
    }

    const targets = this.settingsRepo.getAll247Guilds().filter((guild) => {
      if (!guild.voiceChannelId247) {
        return false;
      }
      if (excludeGuildIds?.has(guild.guildId)) {
        return false;
      }
      const existing = this.gateway.getPlayer(guild.guildId);
      return !(existing && existing.connected);
    });

    for (let i = 0; i < targets.length; i += 1) {
      if (this.shuttingDown) {
        return;
      }

      if (i > 0 && this.rejoinStaggerMs > 0) {
        await this.sleepStagger(this.rejoinStaggerMs);
        if (this.shuttingDown) {
          return;
        }
      }

      const guild = targets[i];
      const voiceChannelId = guild.voiceChannelId247!;
      const textChannelId = guild.textChannelId247 ?? guild.musicChannelId ?? '';

      try {
        const check = await this.gateway.validateVoiceChannel(guild.guildId, voiceChannelId);
        if (!check.ok) {
          this.logger.warn(
            { guildId: guild.guildId, voiceChannelId, reason: check.reason },
            'Canal 24/7 inválido ou sem permissões no boot; limpando configuração 24/7',
          );
          if (check.reason !== 'TRANSIENT_ERROR') {
            this.settingsRepo.clear247Channel(guild.guildId);
          }
          continue;
        }

        await this.ensureConnected247(guild.guildId, voiceChannelId, textChannelId);
      } catch (error) {
        this.logger.warn(
          { err: error, guildId: guild.guildId, voiceChannelId },
          'Falha ao reconectar em canal 24/7 no boot',
        );
      }
    }
  }

  /**
   * Cancels all local timers cleanly without destroying active Lavalink players,
   * preserving playback across short (<60s) restarts.
   */
  async shutdownGracefully(): Promise<void> {
    this.shuttingDown = true;
    this.timers.clearAll();
    for (const handle of this.staggerHandles) {
      clearTimeout(handle);
    }
    this.staggerHandles.clear();
    this.logger.info('MusicService encerrado graciosamente preservando players ativos no Lavalink');
  }

  private async handlePlaybackFailure(
    guildId: string,
    kind: 'error' | 'stuck',
    track: GatewayTrack | null,
    detail?: string,
  ): Promise<void> {
    const player = this.gateway.getPlayer(guildId);
    const activeTrack = track ?? player?.queue.current ?? null;
    const title = activeTrack?.info.title ?? 'Faixa desconhecida';
    const uri = activeTrack?.info.uri ?? null;
    const textChannelId = this.resolveTextChannelId(guildId, player);

    this.logger.warn(
      { guildId, kind, title, uri, detail },
      kind === 'error' ? 'Erro ao reproduzir faixa' : 'Faixa travou durante a reprodução',
    );

    const { tripped, count } = this.circuitBreaker.recordFailure(guildId);

    if (!tripped) {
      const notice =
        kind === 'error'
          ? `⚠️ Erro ao reproduzir **${title}**. Pulando para a próxima música...`
          : `⚠️ A música **${title}** travou. Pulando para a próxima música...`;
      await this.sendTextSafe(guildId, textChannelId, notice);

      if (player) {
        if (player.queue.tracks.length > 0) {
          await player.skip(1);
        } else {
          await player.stopPlaying(true, false);
          await this.handleQueueEnd(guildId);
        }
      }
      return;
    }

    this.logger.error(
      { guildId, consecutiveFailures: count },
      'Circuit breaker acionado após falhas consecutivas de reprodução',
    );

    this.timers.cancel(guildId);
    this.circuitBreaker.reset(guildId);
    this.pausedByEmptyChannel.delete(guildId);
    await this.disableActivePanel(guildId);

    if (player) {
      await player.stopPlaying(true, false);
    }

    await this.sendTextSafe(
      guildId,
      textChannelId,
      '⛔ Várias músicas falharam em sequência. A fila foi limpa e a reprodução foi encerrada.',
    );

    const settings = this.settingsRepo.getOrDefault(guildId);
    if (settings.alwaysOn247) {
      if (player) {
        this.persistActiveSession(guildId, player, undefined, undefined, null);
      }
    } else {
      await this.disconnectBotInitiated(guildId, 'circuitBreaker');
    }
  }

  private scheduleAutoLeave(guildId: string, autoLeaveSeconds: number): void {
    const delayMs = Math.max(0, autoLeaveSeconds * 1000);
    this.timers.schedule(guildId, delayMs, async () => {
      const settings = this.settingsRepo.getOrDefault(guildId);
      if (settings.alwaysOn247) {
        return;
      }

      const player = this.gateway.getPlayer(guildId);
      if (!player) {
        this.sessionStore.deleteActivePlayer(guildId);
        return;
      }

      if (player.playing && !player.paused && !this.emptyGuildChannels.has(guildId)) {
        return;
      }

      await this.disconnectBotInitiated(guildId, 'autoLeave');
    });
  }

  private async disconnectBotInitiated(guildId: string, reason: string): Promise<void> {
    this.botInitiatedDisconnects.add(guildId);
    this.emptyGuildChannels.delete(guildId);
    this.pausedByEmptyChannel.delete(guildId);
    await this.disableActivePanel(guildId);
    this.sessionStore.deleteActivePlayer(guildId);

    const player = this.gateway.getPlayer(guildId);
    if (player) {
      this.disconnectingGuilds.add(guildId);
      try {
        await this.gateway.destroyPlayer(guildId, reason);
      } finally {
        this.disconnectingGuilds.delete(guildId);
      }
    }
  }

  private async disableActivePanel(guildId: string): Promise<void> {
    await this.panelTracker.disablePanelSafely(guildId, (ref) =>
      this.messenger.fetchPanelMessage(ref),
    );
  }

  private resolveTextChannelId(guildId: string, player: GatewayPlayer | null): string | null {
    if (player?.textChannelId) {
      return player.textChannelId;
    }

    const session = this.sessionStore.getActivePlayer(guildId);
    if (session?.textChannelId) {
      return session.textChannelId;
    }

    return this.settingsRepo.getOrDefault(guildId).textChannelId247;
  }

  private persistActiveSession(
    guildId: string,
    player: GatewayPlayer,
    voiceChannelIdOverride?: string,
    textChannelIdOverride?: string,
    panelOverride?: PanelMessageRef | null,
  ): void {
    const existing = this.sessionStore.getActivePlayer(guildId);
    const settings = this.settingsRepo.getOrDefault(guildId);
    const voiceChannelId =
      voiceChannelIdOverride ??
      player.voiceChannelId ??
      existing?.voiceChannelId ??
      settings.voiceChannelId247;
    const textChannelId =
      textChannelIdOverride ??
      player.textChannelId ??
      existing?.textChannelId ??
      settings.textChannelId247 ??
      '';

    if (!voiceChannelId) {
      return;
    }

    const activePanel =
      panelOverride !== undefined
        ? panelOverride
        : (this.panelTracker.getPanel(guildId) ??
          (existing?.panelChannelId && existing.panelMessageId
            ? { channelId: existing.panelChannelId, messageId: existing.panelMessageId }
            : null));

    this.sessionStore.saveActivePlayer({
      guildId,
      voiceChannelId,
      textChannelId,
      repeatMode: player.repeatMode ?? 'off',
      panelChannelId: activePanel?.channelId ?? null,
      panelMessageId: activePanel?.messageId ?? null,
    });
  }

  private async sendTextSafe(
    guildId: string,
    channelId: string | null,
    content: string,
  ): Promise<void> {
    if (!channelId) {
      return;
    }

    try {
      await this.messenger.sendMessage(channelId, content);
    } catch (error) {
      this.logger.warn(
        { err: error, guildId, channelId },
        'Falha ao enviar mensagem de notificação no canal de texto',
      );
    }
  }

  private requireActivePlaybackPlayer(
    guildId: string,
  ): { ok: true; player: GatewayPlayer } | { ok: false; failure: ActionFailure } {
    const player = this.gateway.getPlayer(guildId);
    if (!player || (!player.playing && !player.queue.current)) {
      return {
        ok: false,
        failure: {
          ok: false,
          reason: 'NO_ACTIVE_TRACK',
          message: 'Não há nenhuma música tocando no momento.',
        },
      };
    }

    return { ok: true, player };
  }

  private async ensureVoicePlayer(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string,
    defaultVolume: number,
  ): Promise<{ player: GatewayPlayer; created: boolean }> {
    const existing = this.gateway.getPlayer(guildId);
    if (!existing) {
      const player = await this.gateway.createPlayer({
        guildId,
        voiceChannelId,
        textChannelId,
        volume: defaultVolume,
        selfDeaf: true,
      });
      await player.connect();
      return { player, created: true };
    }

    existing.textChannelId = textChannelId;
    if (!existing.connected) {
      await existing.connect();
    } else if (
      existing.voiceChannelId &&
      existing.voiceChannelId !== voiceChannelId &&
      existing.changeVoiceState
    ) {
      await existing.changeVoiceState({ voiceChannelId, selfDeaf: true });
    }
    return { player: existing, created: false };
  }

  private sleepStagger(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = setTimeout(() => {
        this.staggerHandles.delete(handle);
        resolve();
      }, ms);
      this.staggerHandles.add(handle);
    });
  }
}
