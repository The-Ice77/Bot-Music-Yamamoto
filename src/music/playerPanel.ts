import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type APIButtonComponent,
} from 'discord.js';
import type { RepeatMode } from 'lavalink-client';
import { buildProgressBar, formatDuration, paginateQueue } from './formatters.js';

export const PANEL_BUTTON_IDS = {
  toggle: 'music:toggle',
  skip: 'music:skip',
  loop: 'music:loop',
  shuffle: 'music:shuffle',
  stop: 'music:stop',
  volumeDown: 'music:vol_down',
  mute: 'music:mute',
  volumeUp: 'music:vol_up',
  queue: 'music:queue',
} as const;

export const QUEUE_BUTTON_PREFIX = 'queue:page:' as const;
export const QUEUE_ACTION_PREFIX = 'queue:action:' as const;

export const QUEUE_ACTION_IDS = {
  refresh: `${QUEUE_ACTION_PREFIX}refresh`,
  shuffle: `${QUEUE_ACTION_PREFIX}shuffle`,
  dedupe: `${QUEUE_ACTION_PREFIX}dedupe`,
  clear: `${QUEUE_ACTION_PREFIX}clear`,
} as const;

const EMBED_COLOR_PLAYING = 0x1db954;
const EMBED_COLOR_PAUSED = 0xf59e0b;
const EMBED_COLOR_QUEUE = 0x5865f2;

const IGNORED_DISCORD_ERROR_CODES = new Set([10008, 50001, 10003, 50013]);

export interface PanelTrackView {
  title: string;
  author: string;
  uri?: string | null;
  artworkUrl?: string | null;
  durationMs: number;
  positionMs: number;
  isStream: boolean;
  requesterId?: string | null;
  requesterTag?: string | null;
}

export interface NowPlayingEmbedOptions {
  track: PanelTrackView;
  paused: boolean;
  volume: number;
  repeatMode: RepeatMode;
  queueLength?: number;
  nowMs?: number;
}

export interface ControlButtonsOptions {
  paused: boolean;
  repeatMode: RepeatMode;
  disabled?: boolean;
}

export interface QueueTrackView {
  title: string;
  author: string;
  uri?: string | null;
  durationMs: number;
  isStream: boolean;
  requesterId?: string | null;
  requesterTag?: string | null;
}

export interface QueueEmbedOptions {
  currentTrack: QueueTrackView | null;
  queue: readonly QueueTrackView[];
  page: number;
  pageSize?: number;
  repeatMode: RepeatMode;
  paused?: boolean;
  currentPositionMs?: number;
}

export interface QueuePaginationOptions {
  currentPage: number;
  totalPages: number;
  disabled?: boolean;
}

export interface PanelMessageRef {
  channelId: string;
  messageId: string;
}

interface ComponentLike {
  toJSON?: () => unknown;
  type?: number;
}

interface ActionRowLike {
  components?: readonly ComponentLike[];
}

export interface EditablePanelMessage {
  components?: readonly ActionRowLike[];
  edit(payload: {
    embeds?: EmbedBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
  }): Promise<unknown>;
}

export type PanelMessageFetcher = (
  ref: PanelMessageRef,
) => Promise<EditablePanelMessage | null | undefined>;

function formatRepeatButtonLabel(repeatMode: RepeatMode): string {
  switch (repeatMode) {
    case 'track':
      return 'Loop: Música';
    case 'queue':
      return 'Loop: Fila';
    default:
      return 'Loop: Off';
  }
}

function formatRepeatFieldValue(repeatMode: RepeatMode): string {
  switch (repeatMode) {
    case 'track':
      return 'Música';
    case 'queue':
      return 'Fila';
    default:
      return 'Desativado';
  }
}

function formatVolumeFieldValue(volume: number): string {
  if (volume <= 0) {
    return '🔇 0% (Mudo)';
  }
  if (volume < 50) {
    return `🔉 ${volume}%`;
  }
  if (volume > 100) {
    return `🔊 ${volume}% (Boost)`;
  }
  return `🔊 ${volume}%`;
}

function formatTrackLink(title: string, uri?: string | null): string {
  return uri ? `[${title}](${uri})` : title;
}

function formatRequester(requesterId?: string | null, requesterTag?: string | null): string {
  if (requesterId) {
    return `<@${requesterId}>`;
  }
  if (requesterTag) {
    return requesterTag;
  }
  return 'Desconhecido';
}

function isIgnorableDiscordPanelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && IGNORED_DISCORD_ERROR_CODES.has(code);
}

function buildDisabledRowsFromMessage(message: EditablePanelMessage): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (const row of message.components ?? []) {
    const buttons: ButtonBuilder[] = [];
    for (const component of row.components ?? []) {
      const json = typeof component.toJSON === 'function' ? component.toJSON() : component;
      if (
        json &&
        typeof json === 'object' &&
        (json as { type?: unknown }).type === ComponentType.Button
      ) {
        buttons.push(ButtonBuilder.from(json as APIButtonComponent).setDisabled(true));
      }
    }
    if (buttons.length > 0) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
    }
  }

  if (rows.length > 0) {
    return rows;
  }

  return [buildControlButtons({ paused: false, repeatMode: 'off', disabled: true })];
}

/**
 * Builds the `pt-BR` Now Playing embed for the active track and player state.
 */
export function buildNowPlayingEmbed(options: NowPlayingEmbedOptions): EmbedBuilder {
  const { track, paused, volume, repeatMode, queueLength, nowMs } = options;

  const baseProgressLine = track.isStream
    ? '`AO VIVO`'
    : `\`${formatDuration(track.positionMs)}\` ${buildProgressBar(track.positionMs, track.durationMs)} \`${formatDuration(track.durationMs)}\``;

  let progressSuffix = '';
  if (!track.isStream) {
    if (paused) {
      progressSuffix = ' • `Pausada`';
    } else if (track.durationMs > 0) {
      const remainingMs = Math.max(0, track.durationMs - Math.max(0, track.positionMs));
      if (remainingMs > 0) {
        const endsAtSeconds = Math.floor(((nowMs ?? Date.now()) + remainingMs) / 1000);
        progressSuffix = ` • termina <t:${endsAtSeconds}:R>`;
      }
    }
  }

  const progressLine = `${baseProgressLine}${progressSuffix}`;

  const embed = new EmbedBuilder()
    .setColor(paused ? EMBED_COLOR_PAUSED : EMBED_COLOR_PLAYING)
    .setTitle(paused ? '⏸️ Reprodução Pausada' : '🎵 Tocando Agora')
    .setDescription(
      `**${formatTrackLink(track.title, track.uri)}**\npor ${track.author}\n\n${progressLine}`,
    )
    .addFields(
      {
        name: 'Pedido por',
        value: formatRequester(track.requesterId, track.requesterTag),
        inline: true,
      },
      {
        name: 'Volume',
        value: formatVolumeFieldValue(volume),
        inline: true,
      },
      {
        name: 'Loop',
        value: formatRepeatFieldValue(repeatMode),
        inline: true,
      },
    );

  if (track.artworkUrl) {
    embed.setThumbnail(track.artworkUrl);
  }

  if (typeof queueLength === 'number') {
    const plural = queueLength === 1 ? 'música na fila' : 'músicas na fila';
    embed.setFooter({ text: `${queueLength} ${plural}` });
  }

  return embed;
}

/**
 * Builds the 5-button interactive player control row in `pt-BR`.
 */
export function buildControlButtons(options: ControlButtonsOptions): ActionRowBuilder<ButtonBuilder> {
  const disabled = Boolean(options.disabled);

  const toggleButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.toggle)
    .setLabel(options.paused ? 'Retomar' : 'Pausar')
    .setStyle(options.paused ? ButtonStyle.Success : ButtonStyle.Primary)
    .setDisabled(disabled);

  const skipButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.skip)
    .setLabel('Pular')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const loopButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.loop)
    .setLabel(formatRepeatButtonLabel(options.repeatMode))
    .setStyle(options.repeatMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(disabled);

  const shuffleButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.shuffle)
    .setLabel('Embaralhar')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const stopButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.stop)
    .setLabel('Parar')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    toggleButton,
    skipButton,
    loopButton,
    shuffleButton,
    stopButton,
  );
}

/**
 * Builds the 4-button volume and quick-queue secondary row in `pt-BR`.
 */
export function buildVolumeControlButtons(options: {
  volume: number;
  disabled?: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const disabled = Boolean(options.disabled);
  const isMuted = options.volume <= 0;

  const volDownButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.volumeDown)
    .setLabel('🔉 -10%')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || options.volume <= 0);

  const muteButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.mute)
    .setLabel(isMuted ? '🔊 Desmutar' : '🔇 Mudo')
    .setStyle(isMuted ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(disabled);

  const volUpButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.volumeUp)
    .setLabel('🔊 +10%')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || options.volume >= 150);

  const queueButton = new ButtonBuilder()
    .setCustomId(PANEL_BUTTON_IDS.queue)
    .setLabel('📜 Fila')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    volDownButton,
    muteButton,
    volUpButton,
    queueButton,
  );
}

/**
 * Builds both interactive action rows (playback + volume/queue) for the Now Playing panel.
 */
export function buildPanelComponents(options: {
  paused: boolean;
  repeatMode: RepeatMode;
  volume: number;
  disabled?: boolean;
}): ActionRowBuilder<ButtonBuilder>[] {
  return [
    buildControlButtons({
      paused: options.paused,
      repeatMode: options.repeatMode,
      disabled: options.disabled,
    }),
    buildVolumeControlButtons({
      volume: options.volume,
      disabled: options.disabled,
    }),
  ];
}

/**
 * Builds the paginated `pt-BR` queue embed showing the current track and upcoming tracks.
 */
export function buildQueueEmbed(options: QueueEmbedOptions): EmbedBuilder {
  const {
    currentTrack,
    queue,
    page,
    pageSize = 10,
    repeatMode,
    paused = false,
    currentPositionMs,
  } = options;
  const paginated = paginateQueue(queue, page, pageSize);

  const currentDurationLabel = currentTrack
    ? !currentTrack.isStream && typeof currentPositionMs === 'number'
      ? `${formatDuration(currentPositionMs)} / ${formatDuration(currentTrack.durationMs)}`
      : formatDuration(currentTrack.durationMs, currentTrack.isStream)
    : '';

  const currentLine = currentTrack
    ? `**Tocando agora${paused ? ' (Pausada)' : ''}:** ${formatTrackLink(currentTrack.title, currentTrack.uri)} — \`${currentDurationLabel}\``
    : '**Tocando agora:** Nenhuma música tocando no momento.';

  const upcomingLines =
    paginated.items.length > 0
      ? paginated.items
          .map((track, idx) => {
            const position = paginated.startIndex + idx + 1;
            const duration = formatDuration(track.durationMs, track.isStream);
            const requesterSuffix =
              track.requesterId || track.requesterTag
                ? ` — ${formatRequester(track.requesterId, track.requesterTag)}`
                : '';
            return `**${position}.** ${formatTrackLink(track.title, track.uri)} — \`${duration}\`${requesterSuffix}`;
          })
          .join('\n')
      : 'A fila está vazia.';

  const knownDurationMs = queue.reduce(
    (total, item) => (item.isStream ? total : total + Math.max(0, item.durationMs)),
    0,
  );
  const hasStreams = queue.some((item) => item.isStream);
  const durationSummary = hasStreams
    ? `${formatDuration(knownDurationMs)} + ao vivo`
    : formatDuration(knownDurationMs);

  return new EmbedBuilder()
    .setColor(EMBED_COLOR_QUEUE)
    .setTitle('📜 Fila de Reprodução')
    .setDescription(`${currentLine}\n\n**Próximas músicas:**\n${upcomingLines}`)
    .addFields(
      {
        name: 'Total na fila',
        value: `${paginated.totalItems} ${paginated.totalItems === 1 ? 'música' : 'músicas'}`,
        inline: true,
      },
      {
        name: 'Duração estimada',
        value: durationSummary,
        inline: true,
      },
      {
        name: 'Loop',
        value: formatRepeatFieldValue(repeatMode),
        inline: true,
      },
    )
    .setFooter({ text: `Página ${paginated.currentPage} de ${paginated.totalPages}` });
}

/**
 * Builds `Anterior` / `Próxima` pagination buttons for the `/queue` embed.
 */
export function buildQueuePaginationButtons(
  options: QueuePaginationOptions,
): ActionRowBuilder<ButtonBuilder> {
  const disabled = Boolean(options.disabled);

  const prevButton = new ButtonBuilder()
    .setCustomId(`${QUEUE_BUTTON_PREFIX}${options.currentPage - 1}`)
    .setLabel('Anterior')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || options.currentPage <= 1);

  const nextButton = new ButtonBuilder()
    .setCustomId(`${QUEUE_BUTTON_PREFIX}${options.currentPage + 1}`)
    .setLabel('Próxima')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || options.currentPage >= options.totalPages);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(prevButton, nextButton);
}

/**
 * Builds the 4-button smart queue management row (`Atualizar`, `Embaralhar`, `Sem Duplicadas`, `Limpar`).
 */
export function buildQueueActionButtons(options: {
  hasTracks: boolean;
  disabled?: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const disabled = Boolean(options.disabled);
  const trackActionsDisabled = disabled || !options.hasTracks;

  const refreshButton = new ButtonBuilder()
    .setCustomId(QUEUE_ACTION_IDS.refresh)
    .setLabel('🔄 Atualizar')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const shuffleButton = new ButtonBuilder()
    .setCustomId(QUEUE_ACTION_IDS.shuffle)
    .setLabel('🔀 Embaralhar')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(trackActionsDisabled);

  const dedupeButton = new ButtonBuilder()
    .setCustomId(QUEUE_ACTION_IDS.dedupe)
    .setLabel('🧹 Sem Duplicadas')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(trackActionsDisabled);

  const clearButton = new ButtonBuilder()
    .setCustomId(QUEUE_ACTION_IDS.clear)
    .setLabel('🗑️ Limpar')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(trackActionsDisabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    refreshButton,
    shuffleButton,
    dedupeButton,
    clearButton,
  );
}

/**
 * Disables all button components on an arbitrary Discord message, swallowing expected
 * `Unknown Message` (`10008`) / `Missing Access` (`50001`) errors silently.
 */
export async function disableMessageButtonsSafely(
  message: EditablePanelMessage,
  onUnexpectedError?: (error: unknown) => void,
): Promise<void> {
  try {
    const components = buildDisabledRowsFromMessage(message);
    await message.edit({ components });
  } catch (error) {
    if (isIgnorableDiscordPanelError(error)) {
      return;
    }
    onUnexpectedError?.(error);
  }
}

/**
 * Tracks the active Now Playing panel message reference per guild and safely disables stale panels.
 */
export class PanelTracker {
  private readonly panels = new Map<string, PanelMessageRef>();
  private readonly onUnexpectedError?: (error: unknown) => void;

  constructor(onUnexpectedError?: (error: unknown) => void) {
    this.onUnexpectedError = onUnexpectedError;
  }

  /**
   * Stores the active panel message reference for `guildId`.
   */
  setPanel(guildId: string, ref: PanelMessageRef): void {
    this.panels.set(guildId, ref);
  }

  /**
   * Returns the active panel message reference for `guildId`, or `null` if none is tracked.
   */
  getPanel(guildId: string): PanelMessageRef | null {
    return this.panels.get(guildId) ?? null;
  }

  /**
   * Clears any tracked panel reference for `guildId`.
   */
  clearPanel(guildId: string): void {
    this.panels.delete(guildId);
  }

  /**
   * Fetches and updates the tracked panel message for `guildId`, removing stale refs on ignorable Discord errors.
   * Returns `true` when the panel remains active (updated or hit a transient error) and `false` when gone/inaccessible.
   */
  async updatePanelSafely(
    guildId: string,
    fetcher: PanelMessageFetcher,
    payload: {
      embeds?: EmbedBuilder[];
      components?: ActionRowBuilder<ButtonBuilder>[];
    },
  ): Promise<boolean> {
    const ref = this.panels.get(guildId);
    if (!ref) {
      return false;
    }

    try {
      const message = await fetcher(ref);
      if (!message) {
        if (this.panels.get(guildId) === ref) {
          this.panels.delete(guildId);
        }
        return false;
      }
      await message.edit(payload);
      return true;
    } catch (error) {
      if (isIgnorableDiscordPanelError(error)) {
        if (this.panels.get(guildId) === ref) {
          this.panels.delete(guildId);
        }
        return false;
      }
      this.onUnexpectedError?.(error);
      return true;
    }
  }

  /**
   * Fetches and disables buttons on the tracked panel for `guildId`, ignoring missing/inaccessible messages.
   */
  async disablePanelSafely(guildId: string, fetcher: PanelMessageFetcher): Promise<void> {
    const ref = this.panels.get(guildId);
    if (!ref) {
      return;
    }

    this.panels.delete(guildId);

    try {
      const message = await fetcher(ref);
      if (!message) {
        return;
      }
      await disableMessageButtonsSafely(message, this.onUnexpectedError);
    } catch (error) {
      if (isIgnorableDiscordPanelError(error)) {
        return;
      }
      this.onUnexpectedError?.(error);
    }
  }
}
