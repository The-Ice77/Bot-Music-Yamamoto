import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackCircuitBreaker } from '../../src/music/circuitBreaker.ts';

test('TrackCircuitBreaker trips on 3rd consecutive failure', () => {
  const breaker = new TrackCircuitBreaker();

  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 1 });
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 2 });
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: true, count: 3 });
});

test('TrackCircuitBreaker recordSuccess and reset restore consecutive counter to zero', () => {
  const breaker = new TrackCircuitBreaker();

  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 1 });
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 2 });

  breaker.recordSuccess('g1');
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 1 });

  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 2 });
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: true, count: 3 });

  breaker.reset('g1');
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 1 });
});

test('TrackCircuitBreaker tracks guilds independently', () => {
  const breaker = new TrackCircuitBreaker();

  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 1 });
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 2 });

  assert.deepEqual(breaker.recordFailure('g2'), { tripped: false, count: 1 });
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: true, count: 3 });
  assert.deepEqual(breaker.recordFailure('g2'), { tripped: false, count: 2 });
});

test('TrackCircuitBreaker supports custom threshold and validates positive integer threshold', () => {
  const breaker = new TrackCircuitBreaker(2);
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: false, count: 1 });
  assert.deepEqual(breaker.recordFailure('g1'), { tripped: true, count: 2 });

  assert.throws(() => new TrackCircuitBreaker(0), RangeError);
  assert.throws(() => new TrackCircuitBreaker(-1), RangeError);
});
