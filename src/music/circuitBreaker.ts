/**
 * Per-guild circuit breaker that trips after consecutive track playback failures
 * without an intervening successful track start.
 */
export class TrackCircuitBreaker {
  private readonly threshold: number;
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(threshold = 3) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new RangeError('TrackCircuitBreaker threshold must be a positive integer');
    }
    this.threshold = threshold;
  }

  /**
   * Increments the consecutive failure count for `guildId` and reports whether the breaker tripped.
   */
  recordFailure(guildId: string): { tripped: boolean; count: number } {
    const count = (this.consecutiveFailures.get(guildId) ?? 0) + 1;
    this.consecutiveFailures.set(guildId, count);

    return {
      tripped: count >= this.threshold,
      count,
    };
  }

  /**
   * Clears the consecutive failure count for `guildId` after a track starts successfully.
   */
  recordSuccess(guildId: string): void {
    this.consecutiveFailures.delete(guildId);
  }

  /**
   * Resets the consecutive failure count for `guildId`.
   */
  reset(guildId: string): void {
    this.consecutiveFailures.delete(guildId);
  }
}
