export interface PaginatedQueue<T> {
  items: T[];
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startIndex: number;
}

const DEFAULT_PROGRESS_BAR_SIZE = 12;
const DEFAULT_PAGE_SIZE = 10;

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Formats a track duration in milliseconds as `mm:ss`, `h:mm:ss`, or `AO VIVO` for live streams.
 */
export function formatDuration(ms: number | null | undefined, isStream = false): string {
  if (isStream) {
    return 'AO VIVO';
  }

  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return '00:00';
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${padTwo(minutes)}:${padTwo(seconds)}`;
  }

  return `${padTwo(minutes)}:${padTwo(seconds)}`;
}

/**
 * Builds a fixed-width playback progress bar clamping `positionMs` safely within `0..durationMs`.
 */
export function buildProgressBar(
  positionMs: number,
  durationMs: number,
  size = DEFAULT_PROGRESS_BAR_SIZE,
): string {
  const barSize = Number.isFinite(size) && size >= 1 ? Math.floor(size) : DEFAULT_PROGRESS_BAR_SIZE;
  const safeDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const safePosition = Number.isFinite(positionMs)
    ? Math.min(Math.max(positionMs, 0), safeDuration)
    : 0;

  const ratio = safeDuration > 0 ? safePosition / safeDuration : 0;
  const knobIndex = barSize === 1 ? 0 : Math.min(barSize - 1, Math.round(ratio * (barSize - 1)));

  let bar = '';
  for (let i = 0; i < barSize; i += 1) {
    bar += i === knobIndex ? '●' : '▬';
  }
  return bar;
}

/**
 * Returns a slice of `items` for `page`, clamping out-of-range page numbers to `1..totalPages`.
 */
export function paginateQueue<T>(
  items: readonly T[],
  page: number,
  pageSize = DEFAULT_PAGE_SIZE,
): PaginatedQueue<T> {
  const safePageSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const requestedPage = Number.isFinite(page) ? Math.floor(page) : 1;
  const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
  const startIndex = (currentPage - 1) * safePageSize;

  return {
    items: items.slice(startIndex, startIndex + safePageSize),
    currentPage,
    totalPages,
    totalItems,
    startIndex,
  };
}
