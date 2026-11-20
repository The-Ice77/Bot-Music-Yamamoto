import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { loadEnv } from '../../src/config/env.ts';
import { createLogger } from '../../src/utils/logger.ts';

test('loadEnv applies spec defaults and derives spotifyEnabled=false when credentials empty', () => {
  const env = loadEnv({
    DISCORD_TOKEN: 'disc-tok',
    DISCORD_CLIENT_ID: '123456',
    LAVALINK_HOST: 'lavalink',
    LAVALINK_PASSWORD: 'secret-pass',
  });
  assert.equal(env.LAVALINK_PORT, 2333);
  assert.equal(env.LAVALINK_SECURE, false);
  assert.equal(env.DATABASE_PATH, './data/bot.sqlite');
  assert.equal(env.MAX_QUEUE_SIZE, 500);
  assert.equal(env.LOG_LEVEL, 'info');
  assert.equal(env.spotifyEnabled, false);
});

test('loadEnv parses booleans, ports, and sets spotifyEnabled=true when both creds provided', () => {
  const env = loadEnv({
    DISCORD_TOKEN: 'disc-tok',
    DISCORD_CLIENT_ID: '123456',
    LAVALINK_HOST: 'localhost',
    LAVALINK_PORT: '2444',
    LAVALINK_SECURE: 'true',
    LAVALINK_PASSWORD: 'pass',
    SPOTIFY_CLIENT_ID: 'sp-id',
    SPOTIFY_CLIENT_SECRET: 'sp-sec',
    MAX_QUEUE_SIZE: '250',
  });
  assert.equal(env.LAVALINK_PORT, 2444);
  assert.equal(env.LAVALINK_SECURE, true);
  assert.equal(env.MAX_QUEUE_SIZE, 250);
  assert.equal(env.spotifyEnabled, true);
});

test('loadEnv treats empty optional fields as undefined and parses LAVALINK_SECURE="false" accurately', () => {
  const env = loadEnv({
    DISCORD_TOKEN: 'disc-tok',
    DISCORD_CLIENT_ID: '123456',
    DEV_GUILD_ID: '',
    LAVALINK_HOST: 'localhost',
    LAVALINK_PASSWORD: 'pass',
    LAVALINK_SECURE: 'false',
    SPOTIFY_CLIENT_ID: '',
    SPOTIFY_CLIENT_SECRET: '',
    SPOTIFY_SP_DC: '',
  });
  assert.equal(env.DEV_GUILD_ID, undefined);
  assert.equal(env.SPOTIFY_CLIENT_ID, undefined);
  assert.equal(env.SPOTIFY_CLIENT_SECRET, undefined);
  assert.equal(env.SPOTIFY_SP_DC, undefined);
  assert.equal(env.LAVALINK_SECURE, false);
  assert.equal(env.spotifyEnabled, false);
});

test('loadEnv throws on missing required variables', () => {
  assert.throws(() => loadEnv({ DISCORD_TOKEN: 'only-token' }));
});

test('createLogger redacts sensitive fields from output', () => {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (c) => chunks.push(c.toString()));
  const logger = createLogger('info', stream);
  logger.info({
    token: 'super-secret-token',
    password: 'lavalink-password',
    nested: { clientSecret: 'sp-secret', authorization: 'Bearer x', spDc: 'cookie' },
  }, 'boot');
  const out = chunks.join('');
  assert.equal(out.includes('super-secret-token'), false);
  assert.equal(out.includes('lavalink-password'), false);
  assert.equal(out.includes('sp-secret'), false);
  assert.equal(out.includes('Bearer x'), false);
  assert.equal(out.includes('cookie'), false);
});
