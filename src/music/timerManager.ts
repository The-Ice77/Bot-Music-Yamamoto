export type TimerCallback = () => void | Promise<void>;
export type TimerErrorHandler = (guildId: string, error: unknown) => void;

/**
 * Manages one active timeout per guild, replacing any prior timer on reschedule
 * and cancelling all pending timers cleanly on shutdown.
 */
export class TimerManager {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly onError?: TimerErrorHandler;

  constructor(onError?: TimerErrorHandler) {
    this.onError = onError;
  }

  /**
   * Schedules `callback` after `delayMs` for `guildId`, cancelling any existing timer first.
   */
  schedule(guildId: string, delayMs: number, callback: TimerCallback): void {
    this.cancel(guildId);

    const safeDelay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    const handle = setTimeout(() => {
      if (this.timers.get(guildId) !== handle) {
        return;
      }

      this.timers.delete(guildId);
      Promise.resolve()
        .then(() => callback())
        .catch((error) => {
          this.onError?.(guildId, error);
        });
    }, safeDelay);

    this.timers.set(guildId, handle);
  }

  /**
   * Cancels any pending timer for `guildId`, returning whether a timer was active.
   */
  cancel(guildId: string): boolean {
    const handle = this.timers.get(guildId);
    if (!handle) {
      return false;
    }

    clearTimeout(handle);
    this.timers.delete(guildId);
    return true;
  }

  /**
   * Returns `true` when `guildId` currently has a pending timer.
   */
  has(guildId: string): boolean {
    return this.timers.has(guildId);
  }

  /**
   * Cancels and removes all pending guild timers.
   */
  clearAll(): void {
    for (const handle of this.timers.values()) {
      clearTimeout(handle);
    }
    this.timers.clear();
  }
}
