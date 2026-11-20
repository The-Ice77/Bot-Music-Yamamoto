import test from 'node:test';
import assert from 'node:assert/strict';
import type { GuildSettings } from '../../src/db/guildSettingsRepository.ts';
import {
  canControlPlayer,
  validateMusicChannel,
  validateVoiceAccess,
} from '../../src/music/permissions.ts';

function makeSettings(overrides: Partial<GuildSettings> = {}): GuildSettings {
  return {
    guildId: 'g1',
    defaultVolume: 80,
    djRoleId: null,
    musicChannelId: null,
    autoLeaveSeconds: 180,
    alwaysOn247: false,
    voiceChannelId247: null,
    textChannelId247: null,
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

test('canControlPlayer allows anyone when djRoleId is null', () => {
  assert.equal(
    canControlPlayer({
      djRoleId: null,
      memberRoleIds: [],
      isAdminOrManager: false,
      humanCountInBotChannel: 5,
    }),
    true,
  );
});

test('canControlPlayer rejects non-DJ non-admin when djRoleId is set and multiple humans are in channel', () => {
  assert.equal(
    canControlPlayer({
      djRoleId: 'dj-role',
      memberRoleIds: ['other-role'],
      isAdminOrManager: false,
      humanCountInBotChannel: 2,
    }),
    false,
  );
});

test('canControlPlayer allows member who has djRoleId (array or Set)', () => {
  assert.equal(
    canControlPlayer({
      djRoleId: 'dj-role',
      memberRoleIds: ['other-role', 'dj-role'],
      isAdminOrManager: false,
      humanCountInBotChannel: 4,
    }),
    true,
  );
  assert.equal(
    canControlPlayer({
      djRoleId: 'dj-role',
      memberRoleIds: new Set(['dj-role']),
      isAdminOrManager: false,
      humanCountInBotChannel: 4,
    }),
    true,
  );
});

test('canControlPlayer allows admin or manager regardless of djRoleId', () => {
  assert.equal(
    canControlPlayer({
      djRoleId: 'dj-role',
      memberRoleIds: [],
      isAdminOrManager: true,
      humanCountInBotChannel: 4,
    }),
    true,
  );
});

test('canControlPlayer allows lone human in bot voice channel (humanCountInBotChannel <= 1)', () => {
  assert.equal(
    canControlPlayer({
      djRoleId: 'dj-role',
      memberRoleIds: [],
      isAdminOrManager: false,
      humanCountInBotChannel: 1,
    }),
    true,
  );
  assert.equal(
    canControlPlayer({
      djRoleId: 'dj-role',
      memberRoleIds: [],
      isAdminOrManager: false,
      humanCountInBotChannel: 0,
    }),
    true,
  );
});

test('validateMusicChannel allows any channel when musicChannelId is null', () => {
  const settings = makeSettings({ musicChannelId: null });
  assert.deepEqual(validateMusicChannel('tc-any', settings), { ok: true });
});

test('validateMusicChannel allows matching channel and rejects mismatched channel', () => {
  const settings = makeSettings({ musicChannelId: 'tc-music' });
  assert.deepEqual(validateMusicChannel('tc-music', settings), { ok: true });
  assert.deepEqual(validateMusicChannel('tc-general', settings), {
    ok: false,
    allowedChannelId: 'tc-music',
  });
});

test('validateVoiceAccess rejects NOT_IN_VOICE when memberVoiceChannelId is null', () => {
  assert.deepEqual(
    validateVoiceAccess({
      memberVoiceChannelId: null,
      botVoiceChannelId: null,
      botHasVoicePerms: true,
    }),
    { ok: false, reason: 'NOT_IN_VOICE' },
  );
});

test('validateVoiceAccess rejects DIFFERENT_CHANNEL when bot is active in another channel', () => {
  assert.deepEqual(
    validateVoiceAccess({
      memberVoiceChannelId: 'vc-1',
      botVoiceChannelId: 'vc-2',
      botHasVoicePerms: true,
    }),
    { ok: false, reason: 'DIFFERENT_CHANNEL', botChannelId: 'vc-2' },
  );
  assert.deepEqual(
    validateVoiceAccess({
      memberVoiceChannelId: 'vc-1',
      botVoiceChannelId: 'vc-2',
      botHasVoicePerms: false,
    }),
    { ok: false, reason: 'DIFFERENT_CHANNEL', botChannelId: 'vc-2' },
  );
});

test('validateVoiceAccess rejects MISSING_PERMISSIONS when bot lacks ViewChannel + Connect + Speak', () => {
  assert.deepEqual(
    validateVoiceAccess({
      memberVoiceChannelId: 'vc-1',
      botVoiceChannelId: null,
      botHasVoicePerms: false,
    }),
    { ok: false, reason: 'MISSING_PERMISSIONS' },
  );
});

test('validateVoiceAccess allows valid voice access when joining or in same channel with perms', () => {
  assert.deepEqual(
    validateVoiceAccess({
      memberVoiceChannelId: 'vc-1',
      botVoiceChannelId: null,
      botHasVoicePerms: true,
    }),
    { ok: true },
  );
  assert.deepEqual(
    validateVoiceAccess({
      memberVoiceChannelId: 'vc-1',
      botVoiceChannelId: 'vc-1',
      botHasVoicePerms: true,
    }),
    { ok: true },
  );
});
