import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgressBar,
  formatDuration,
  paginateQueue,
} from '../../src/music/formatters.ts';

test('formatDuration formats mm:ss, h:mm:ss, live streams, and edge values', () => {
  assert.equal(formatDuration(225_000), '03:45');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(formatDuration(0, true), 'AO VIVO');
  assert.equal(formatDuration(180_000, true), 'AO VIVO');
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(null), '00:00');
  assert.equal(formatDuration(undefined), '00:00');
  assert.equal(formatDuration(-5_000), '00:00');
});

test('buildProgressBar renders fixed-size bar and clamps positions safely within 0..durationMs', () => {
  const atStart = buildProgressBar(0, 100_000, 10);
  const atMid = buildProgressBar(50_000, 100_000, 10);
  const atEnd = buildProgressBar(100_000, 100_000, 10);

  assert.equal(atStart.length, 10);
  assert.equal(atMid.length, 10);
  assert.equal(atEnd.length, 10);
  assert.notEqual(atStart, atMid);
  assert.notEqual(atMid, atEnd);

  assert.equal(buildProgressBar(-25_000, 100_000, 10), atStart);
  assert.equal(buildProgressBar(250_000, 100_000, 10), atEnd);
  assert.equal(buildProgressBar(5_000, 0, 10), atStart);
});

test('paginateQueue returns exact slice and clamps out-of-range pages', () => {
  const items = Array.from({ length: 25 }, (_, i) => `track-${i + 1}`);

  const page3 = paginateQueue(items, 3, 10);
  assert.equal(page3.totalPages, 3);
  assert.equal(page3.currentPage, 3);
  assert.equal(page3.totalItems, 25);
  assert.equal(page3.startIndex, 20);
  assert.equal(page3.items.length, 5);
  assert.deepEqual(page3.items, ['track-21', 'track-22', 'track-23', 'track-24', 'track-25']);

  const clampedHigh = paginateQueue(items, 99, 10);
  assert.equal(clampedHigh.currentPage, 3);
  assert.equal(clampedHigh.startIndex, 20);
  assert.equal(clampedHigh.items.length, 5);

  const clampedLow = paginateQueue(items, 0, 10);
  assert.equal(clampedLow.currentPage, 1);
  assert.equal(clampedLow.startIndex, 0);
  assert.equal(clampedLow.items.length, 10);

  const empty = paginateQueue([], 2, 10);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.currentPage, 1);
  assert.equal(empty.totalItems, 0);
  assert.equal(empty.startIndex, 0);
  assert.deepEqual(empty.items, []);
});
