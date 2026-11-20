import test from 'node:test';
import assert from 'node:assert/strict';
import { TimerManager } from '../../src/music/timerManager.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('TimerManager schedule fires callback after specified delay', async () => {
  const manager = new TimerManager();
  let fired = 0;

  manager.schedule('g1', 25, () => {
    fired += 1;
  });

  assert.equal(manager.has('g1'), true);
  await delay(10);
  assert.equal(fired, 0);

  await delay(35);
  assert.equal(fired, 1);
  assert.equal(manager.has('g1'), false);
});

test('TimerManager schedule replaces an existing timer and cancels the prior one', async () => {
  const manager = new TimerManager();
  const events: string[] = [];

  manager.schedule('g1', 25, () => {
    events.push('first');
  });
  manager.schedule('g1', 45, () => {
    events.push('second');
  });

  await delay(30);
  assert.deepEqual(events, []);

  await delay(35);
  assert.deepEqual(events, ['second']);
  assert.equal(manager.has('g1'), false);
});

test('TimerManager cancel prevents scheduled callback from firing', async () => {
  const manager = new TimerManager();
  let fired = false;

  manager.schedule('g1', 25, () => {
    fired = true;
  });

  assert.equal(manager.cancel('g1'), true);
  assert.equal(manager.cancel('g1'), false);
  assert.equal(manager.has('g1'), false);

  await delay(45);
  assert.equal(fired, false);
});

test('TimerManager clearAll cancels all pending timers across guilds', async () => {
  const manager = new TimerManager();
  const fired: string[] = [];

  manager.schedule('g1', 25, () => {
    fired.push('g1');
  });
  manager.schedule('g2', 30, () => {
    fired.push('g2');
  });

  assert.equal(manager.has('g1'), true);
  assert.equal(manager.has('g2'), true);

  manager.clearAll();

  assert.equal(manager.has('g1'), false);
  assert.equal(manager.has('g2'), false);

  await delay(50);
  assert.deepEqual(fired, []);
});

test('TimerManager forwards async callback rejections to onError handler', async () => {
  const errors: Array<{ guildId: string; error: unknown }> = [];
  const manager = new TimerManager((guildId, error) => {
    errors.push({ guildId, error });
  });

  manager.schedule('g-err', 15, async () => {
    throw new Error('boom');
  });

  await delay(40);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].guildId, 'g-err');
  assert.match((errors[0].error as Error).message, /boom/);
});
