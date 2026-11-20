# Discord Music Bot (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 24/7 multi-server Discord music bot supporting YouTube and Spotify (tracks, albums, playlists, mixes, and search) with interactive player controls, per-guild persistent settings, short-restart survival, full 24/7 voice mode, and free ARM64/AMD64 Docker deployment.

**Architecture:** A TypeScript Node.js 24 control-plane bot (`discord.js` v14 + `lavalink-client` v2) backed by native SQLite (`node:sqlite` in WAL mode) communicates over an internal Docker network with a standalone Lavalink v4.2+ audio server (`youtube-plugin` + `LavaSrc`). Domain services (`MusicService`, `GuildSettingsRepository`) are strictly decoupled from Discord interaction handlers so Phase 2 (web dashboard) can integrate later without rewriting bot logic.

**Tech Stack:** TypeScript (`^7.0.2`), Node.js 24 LTS (`node:sqlite`, `node:test`), `discord.js` (`^14.28.1`), `lavalink-client` (`^2.11.2`), `zod` (`^4.6.7`), `pino` (`^10.4.0`), `pino-pretty` (`^13.2.0`), `dotenv` (`^18.0.10`), `tsx` (`^4.23.15`), `@types/node` (`^24.19.2`), Docker Compose, Lavalink `ghcr.io/lavalink-devs/lavalink:4.2-alpine`, `youtube-plugin:1.18.2`, `lavasrc-plugin:4.8.3`.

**Spec:** `docs/superpowers/specs/2026-11-20-discord-music-bot-design.md`

---

## Global Constraints

- Runtime: Node.js 24 LTS (`v24.19+`), TypeScript `strict: true`, ESM (`"type": "module"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`).
- Run Node processes with `--disable-warning=ExperimentalWarning` for clean `node:sqlite` logs; run tests via `node --disable-warning=ExperimentalWarning --import tsx --test tests` (directory argument so PowerShell and POSIX behave identically).
- Discord intents strictly limited to `GatewayIntentBits.Guilds` and `GatewayIntentBits.GuildVoiceStates` (no privileged `MessageContent` intent, no text-prefix `!play` commands, no `/play` autocomplete).
- All user-facing Discord strings, command names/descriptions, embeds, and `README.md` in Portuguese (`pt-BR`); validation and permission errors sent as ephemeral replies.
- Phase 1 exposes NO HTTP or IPC server (neither public nor internal).
- SQLite (`node:sqlite` `DatabaseSync`) initialized with `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;`.
- Spec numeric bounds & defaults: `default_volume = 80` (`1–150` in `/config`, `0–150` in `/volume`), `MAX_QUEUE_SIZE = 500`, `auto_leave_seconds = 180` (`30–1800`), circuit breaker threshold = `3` consecutive track failures, Lavalink session resume timeout = `60s`, 24/7 boot reconnect stagger = `250ms`, queue pagination = `10` tracks/page.
- Lavalink pinned to `ghcr.io/lavalink-devs/lavalink:4.2-alpine` (ARM64 `musl` + native DAVE E2EE, UID/GID `322`), `lavalink.server.sources.youtube: false`, `dev.lavalink.youtube:youtube-plugin:1.18.2`, `com.github.topi314.lavasrc:lavasrc-plugin:4.8.3` (`countryCode: "BR"`, `playlistLoadLimit: 6`, `albumLoadLimit: 6`), port `2333` NOT published externally in `docker-compose.yml`.
- Secrets (`DISCORD_TOKEN`, `SPOTIFY_CLIENT_SECRET`, `LAVALINK_PASSWORD`, `SPOTIFY_SP_DC`) never committed to Git and automatically redacted by Pino.

## Review Focus

1. **Unsupported URLs and unconfigured Spotify credentials in `/play`:** Non-YouTube/non-Spotify URLs (e.g. `https://example.com/audio.mp3`, `https://soundcloud.com/...`) must be rejected cleanly in `pt-BR` rather than sent to `ytmsearch`, and Spotify URLs when `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` are unset must return a clear `pt-BR` unavailable notice (pinned in Task 5 `tests/music/queryValidator.test.ts`).
2. **Playlists/YouTube Mixes exceeding `MAX_QUEUE_SIZE` (500):** Enqueuing a playlist larger than remaining capacity (`maxQueueSize - currentQueueSize`) must slice to available slots, report added + truncated counts, and reject cleanly when queue is already full (pinned in Task 6 `tests/music/musicService.test.ts`).
3. **Corrupt `queue_json` or expired (`>60s`) Lavalink session on boot:** Invalid JSON in `lavalink_queues` must degrade safely without throwing, and a fresh non-resumed Lavalink session must purge stale `lavalink_queues` and `active_player_sessions` rows before running staggered 24/7 auto-rejoin (pinned in Task 3 `tests/db/sessionAndQueueStore.test.ts` and Task 6 `tests/music/musicService.test.ts`).
4. **Distinguishing bot-initiated disconnect from manual moderator kick in 24/7 mode:** Only an external/moderator disconnect (not bot-initiated disconnect or `/play` move) may clear `voice_channel_id_247`, preventing both accidental 24/7 erasure and fighting moderators (pinned in Task 6 `tests/music/musicService.test.ts`).
5. **Stale panel button clicks and deleted panel messages (`Unknown Message 10008`):** Disabling a deleted panel message must swallow Discord API 10008/Missing Access errors silently, and clicking panel buttons after playback ended must reply with an ephemeral `pt-BR` notice without unhandled rejections (pinned in Task 5 `tests/music/playerPanel.test.ts` and Task 8 `tests/bot/interactionHandler.test.ts`).

---

## File Structure Map

```text
.
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── lavalink/
│   └── application.yml               # Lavalink v4.2+ config (youtube-plugin + LavaSrc)
├── src/
│   ├── index.ts                      # Boot entrypoint, signal & global error handlers
│   ├── deployCommands.ts             # Slash command registration CLI (--guild / --global)
│   ├── config/
│   │   └── env.ts                    # Zod env schema and loader
│   ├── utils/
│   │   └── logger.ts                 # Pino logger with secret redaction
│   ├── db/
│   │   ├── database.ts               # node:sqlite connection, WAL pragmas, schema DDL
│   │   ├── guildSettingsRepository.ts# Per-guild settings & 24/7 channel persistence
│   │   ├── sessionStoreRepository.ts # Lavalink node sessionId & active player bindings
│   │   └── sqliteQueueStore.ts       # lavalink-client QueueStoreManager backed by SQLite
│   ├── music/
│   │   ├── permissions.ts            # canControlPlayer, music channel & voice checks
│   │   ├── circuitBreaker.ts         # 3-strike consecutive track failure guard
│   │   ├── queryValidator.ts         # YouTube/Spotify URL & search classification
│   │   ├── formatters.ts             # Duration, progress bar, queue pagination helpers
│   │   ├── playerPanel.ts            # Now Playing / Queue embeds, buttons, safe tracker
│   │   ├── timerManager.ts           # Auto-leave idle/empty timers per guild
│   │   └── musicService.ts           # Decoupled playback, lifecycle & 24/7 orchestration
│   ├── commands/
│   │   ├── types.ts                  # SlashCommand & CommandContext contracts
│   │   ├── guards.ts                 # Shared command channel/voice/DJ enforcement
│   │   ├── index.ts                  # Command registry & map
│   │   └── [play,pause,resume,skip,stop,queue,nowplaying,shuffle,loop,volume,remove,clear,config].ts
│   └── bot/
│       ├── createLavalinkManager.ts  # LavalinkManager wiring & event bridge to MusicService
│       ├── interactionHandler.ts     # Slash command & panel button router
│       ├── voiceStateHandler.ts      # Empty channel, human rejoin & manual kick detection
│       └── createBot.ts              # Discord Client assembly & graceful shutdown
└── tests/                            # Mirror tree using node:test + assert/strict
```

---

### Task 1: Project Scaffolding, Env Schema & Redacted Pino Logger

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/config/env.ts`, `src/utils/logger.ts`
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Produces `EnvConfig` interface and `loadEnv(rawEnv?: NodeJS.ProcessEnv): EnvConfig` in `src/config/env.ts`.
- Produces `AppLogger` type and `createLogger(level: EnvConfig['LOG_LEVEL'], destination?: DestinationStream): AppLogger` in `src/utils/logger.ts`.

- [ ] **Step 1: Scaffold config files (`package.json`, `tsconfig.json`, `.gitignore`, `.env.example`)**

`package.json` (`"type": "module"`, dependencies: `discord.js@^14.28.1`, `lavalink-client@^2.11.2`, `pino@^10.4.0`, `dotenv@^18.0.10`, `zod@^4.6.7`; devDependencies: `typescript@^7.0.2`, `@types/node@^24.19.2`, `tsx@^4.23.15`, `pino-pretty@^13.2.0`; scripts: `dev`, `build`, `start`, `deploy-commands`, `typecheck`, `test` — all Node scripts passing `--disable-warning=ExperimentalWarning`, and `test` running `node --disable-warning=ExperimentalWarning --import tsx --test tests`).  
`tsconfig.json`: `target: "ES2023"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `strict: true`, `outDir: "dist"`, `rootDir: "src"`, `skipLibCheck: true`, `esModuleInterop: true`, `types: ["node"]`.  
`.gitignore`: `node_modules/`, `dist/`, `.env`, `data/`, `*.sqlite*`, `*.log`.  
`.env.example`: all spec variables (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEV_GUILD_ID`, `LAVALINK_HOST`, `LAVALINK_PORT`, `LAVALINK_PASSWORD`, `LAVALINK_SECURE`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_SP_DC`, `DATABASE_PATH`, `MAX_QUEUE_SIZE`, `LOG_LEVEL`).

- [ ] **Step 2: Write the failing test in `tests/config/env.test.ts`**

```ts
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
```

- [ ] **Step 3: Install dependencies and verify test fails**

Run: `npm install && npm test`  
Expected: FAIL (`Cannot find module '../../src/config/env.ts'`).

- [ ] **Step 4: Implement `src/config/env.ts` and `src/utils/logger.ts`**

- `loadEnv(rawEnv = process.env): EnvConfig`: parse via Zod v4 (`z.object`), treating `""` in optional fields (`DEV_GUILD_ID`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_SP_DC`) as `undefined`, parsing `LAVALINK_SECURE` string `'true'`/`'false'` accurately (do NOT use `Boolean("false")`), coercing positive ints for `LAVALINK_PORT` and `MAX_QUEUE_SIZE`, and computing `spotifyEnabled = Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET)`.
- `createLogger(level, destination?)`: create a Pino instance configured with `redact: ['token', 'password', 'authorization', 'clientSecret', 'spDc', '*.token', '*.password', '*.authorization', '*.clientSecret', '*.spDc']` (use `pino-pretty` transport only when `destination` is omitted and `NODE_ENV !== 'production'`).

- [ ] **Step 5: Run tests and typecheck to verify pass**

Run: `npm run typecheck && npm test`  
Expected: PASS (4 tests passing, 0 type errors).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example src/config/env.ts src/utils/logger.ts tests/config/env.test.ts
git commit -m "chore: scaffold TypeScript project, env validation, and redacted logger"
```

---

### Task 2: SQLite Database Bootstrap & `GuildSettingsRepository`

**Files:**
- Create: `src/db/database.ts`, `src/db/guildSettingsRepository.ts`
- Test: `tests/db/guildSettingsRepository.test.ts`

**Interfaces:**
- Consumes: `node:sqlite` (`DatabaseSync`).
- Produces:
  - `openDatabase(dbPath: string): DatabaseSync` in `src/db/database.ts`.
  - `GuildSettings`, `GuildSettingsPatch`, `GuildSettingsRepository` (`getOrDefault(guildId: string): GuildSettings`, `update(guildId: string, patch: GuildSettingsPatch): GuildSettings`, `getAll247Guilds(): GuildSettings[]`, `clear247Channel(guildId: string): void`) in `src/db/guildSettingsRepository.ts`.

- [ ] **Step 1: Write the failing test in `tests/db/guildSettingsRepository.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/database.ts';
import { GuildSettingsRepository } from '../../src/db/guildSettingsRepository.ts';

test('openDatabase enables WAL mode and creates all 4 spec tables on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-db-'));
  const dbPath = path.join(dir, 'nested', 'bot.sqlite');
  const db = openDatabase(dbPath);
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r: any) => r.name);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(mode.journal_mode.toLowerCase(), 'wal');
  assert.deepEqual(
    tables.sort(),
    ['active_player_sessions', 'guild_settings', 'lavalink_queues', 'lavalink_sessions'],
  );
});

test('GuildSettingsRepository returns defaults and upserts partial updates', () => {
  const db = openDatabase(':memory:');
  const repo = new GuildSettingsRepository(db);

  const def = repo.getOrDefault('g1');
  assert.deepEqual(
    {
      guildId: def.guildId,
      defaultVolume: def.defaultVolume,
      djRoleId: def.djRoleId,
      musicChannelId: def.musicChannelId,
      autoLeaveSeconds: def.autoLeaveSeconds,
      alwaysOn247: def.alwaysOn247,
      voiceChannelId247: def.voiceChannelId247,
      textChannelId247: def.textChannelId247,
    },
    {
      guildId: 'g1',
      defaultVolume: 80,
      djRoleId: null,
      musicChannelId: null,
      autoLeaveSeconds: 180,
      alwaysOn247: false,
      voiceChannelId247: null,
      textChannelId247: null,
    },
  );

  repo.update('g1', { defaultVolume: 110, djRoleId: 'role-1' });
  const updated = repo.update('g1', { alwaysOn247: true, voiceChannelId247: 'vc-1', textChannelId247: 'tc-1' });
  assert.equal(updated.defaultVolume, 110);
  assert.equal(updated.djRoleId, 'role-1');
  assert.equal(updated.alwaysOn247, true);
  assert.equal(updated.voiceChannelId247, 'vc-1');
  assert.equal(updated.textChannelId247, 'tc-1');

  assert.equal(repo.getAll247Guilds().length, 1);
  repo.clear247Channel('g1');
  assert.equal(repo.getAll247Guilds().length, 0);
  assert.equal(repo.getOrDefault('g1').voiceChannelId247, null);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`  
Expected: FAIL (`Cannot find module '../../src/db/database.ts'`).

- [ ] **Step 3: Implement `src/db/database.ts` and `src/db/guildSettingsRepository.ts`**

- `openDatabase(dbPath)`: when `dbPath !== ':memory:'`, ensure parent directory exists (`fs.mkdirSync(..., { recursive: true })`), instantiate `new DatabaseSync(dbPath)`, execute `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`, and run `CREATE TABLE IF NOT EXISTS` for `guild_settings`, `lavalink_sessions`, `lavalink_queues`, and `active_player_sessions` using the exact columns from Spec Section 5.6.
- `GuildSettingsRepository`: map snake_case SQL columns to camelCase `GuildSettings` (`alwaysOn247: Boolean(row.always_on_247)`), implement `getOrDefault`, partial `update` (merging over `getOrDefault` inside `INSERT ... ON CONFLICT(guild_id) DO UPDATE`), `getAll247Guilds`, and `clear247Channel` (sets `voice_channel_id_247 = NULL, text_channel_id_247 = NULL, updated_at = ?`).

- [ ] **Step 4: Run tests and typecheck to verify pass**

Run: `npm run typecheck && npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/database.ts src/db/guildSettingsRepository.ts tests/db/guildSettingsRepository.test.ts
git commit -m "feat: add SQLite WAL bootstrap and GuildSettingsRepository"
```

---

### Task 3: Lavalink Session Store & SQLite `QueueStoreManager`

**Files:**
- Create: `src/db/sessionStoreRepository.ts`, `src/db/sqliteQueueStore.ts`
- Test: `tests/db/sessionAndQueueStore.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` (from `openDatabase` in Task 2); `QueueStoreManager`, `StoredQueue` from `lavalink-client`.
- Produces:
  - `ActivePlayerSession` (`guildId`, `voiceChannelId`, `textChannelId`, `repeatMode`, `panelChannelId`, `panelMessageId`, `updatedAt`) and `SessionStoreRepository` (`getNodeSessionId(nodeId)`, `saveNodeSessionId(nodeId, sessionId)`, `deleteNodeSessionId(nodeId)`, `getActivePlayer(guildId)`, `listActivePlayers()`, `saveActivePlayer(session: Omit<ActivePlayerSession, 'updatedAt'>)`, `deleteActivePlayer(guildId)`, `clearAllActivePlayers()`) in `src/db/sessionStoreRepository.ts`.
  - `SqliteQueueStore implements QueueStoreManager` (`get`, `set`, `delete`, `stringify`, `parse`, plus `clearAll()`) in `src/db/sqliteQueueStore.ts`.

- [ ] **Step 1: Write the failing test in `tests/db/sessionAndQueueStore.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/database.ts';
import { SessionStoreRepository } from '../../src/db/sessionStoreRepository.ts';
import { SqliteQueueStore } from '../../src/db/sqliteQueueStore.ts';

test('SessionStoreRepository manages node sessionId and active player bindings', () => {
  const db = openDatabase(':memory:');
  const repo = new SessionStoreRepository(db);

  assert.equal(repo.getNodeSessionId('main'), null);
  repo.saveNodeSessionId('main', 'sess-abc');
  assert.equal(repo.getNodeSessionId('main'), 'sess-abc');
  repo.deleteNodeSessionId('main');
  assert.equal(repo.getNodeSessionId('main'), null);

  repo.saveActivePlayer({
    guildId: 'g1',
    voiceChannelId: 'vc1',
    textChannelId: 'tc1',
    repeatMode: 'queue',
    panelChannelId: 'tc1',
    panelMessageId: 'msg1',
  });
  assert.equal(repo.getActivePlayer('g1')?.repeatMode, 'queue');
  assert.equal(repo.listActivePlayers().length, 1);

  repo.clearAllActivePlayers();
  assert.equal(repo.listActivePlayers().length, 0);
  db.close();
});

test('SqliteQueueStore persists, parses, deletes, and handles corrupt JSON safely', async () => {
  const db = openDatabase(':memory:');
  const store = new SqliteQueueStore(db);

  const sample = { current: null, previous: [], tracks: [] };
  const serialized = await store.stringify(sample as any);
  await store.set('g1', serialized);

  const raw = await store.get('g1');
  assert.equal(typeof raw, 'string');
  const parsed = await store.parse(raw);
  assert.deepEqual(parsed.tracks, []);

  // Review Focus #3: corrupt queue_json degrades to empty queue without throwing
  await store.set('g-bad', '{broken-json');
  const badRaw = await store.get('g-bad');
  const safeParsed = await store.parse(badRaw);
  assert.deepEqual(safeParsed, { tracks: [], previous: [] });

  await store.delete('g1');
  assert.equal(await store.get('g1'), undefined);

  store.clearAll();
  assert.equal(await store.get('g-bad'), undefined);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`  
Expected: FAIL (`Cannot find module '../../src/db/sessionStoreRepository.ts'`).

- [ ] **Step 3: Implement `src/db/sessionStoreRepository.ts` and `src/db/sqliteQueueStore.ts`**

Inspect `node_modules/lavalink-client` type definitions for `QueueStoreManager` and `StoredQueue` so `SqliteQueueStore` satisfies the exact interface signature (`get` returns `undefined` when missing; `parse` catches `JSON.parse` errors and returns `{ tracks: [], previous: [] }`).

- [ ] **Step 4: Run tests and typecheck to verify pass**

Run: `npm run typecheck && npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/sessionStoreRepository.ts src/db/sqliteQueueStore.ts tests/db/sessionAndQueueStore.test.ts
git commit -m "feat: add SQLite Lavalink session store and QueueStoreManager"
```

---

### Task 4: Permission Guardrails & Track Error Circuit Breaker

**Files:**
- Create: `src/music/permissions.ts`, `src/music/circuitBreaker.ts`
- Test: `tests/music/permissions.test.ts`, `tests/music/circuitBreaker.test.ts`

**Interfaces:**
- Consumes: `GuildSettings` (Task 2).
- Produces:
  - `ControlPermissionInput`, `canControlPlayer(input: ControlPermissionInput): boolean`, `validateMusicChannel(channelId: string, settings: GuildSettings): { ok: true } | { ok: false; allowedChannelId: string }`, `VoiceAccessInput`, `validateVoiceAccess(input: VoiceAccessInput): { ok: true } | { ok: false; reason: 'NOT_IN_VOICE' | 'DIFFERENT_CHANNEL' | 'MISSING_PERMISSIONS'; botChannelId?: string }` in `src/music/permissions.ts`.
  - `TrackCircuitBreaker` class (`constructor(threshold = 3)`, `recordFailure(guildId: string): { tripped: boolean; count: number }`, `recordSuccess(guildId: string): void`, `reset(guildId: string): void`) in `src/music/circuitBreaker.ts`.

- [ ] **Step 1: Write the failing tests in `tests/music/permissions.test.ts` and `tests/music/circuitBreaker.test.ts`**

`permissions.test.ts`:
- `canControlPlayer`: returns `true` when `djRoleId` is `null`; returns `false` when `djRoleId` set, no DJ role, non-admin, and `humanCountInBotChannel > 1`; returns `true` when member has `djRoleId`; returns `true` when `isAdminOrManager` (`ManageGuild` or `Administrator`); returns `true` when `humanCountInBotChannel <= 1`.
- `validateMusicChannel`: allows any channel when `musicChannelId` is `null`; allows matching channel; rejects mismatch with `{ ok: false, allowedChannelId }`.
- `validateVoiceAccess`: rejects `NOT_IN_VOICE` when `memberVoiceChannelId` is null; rejects `DIFFERENT_CHANNEL` when `botVoiceChannelId` differs; rejects `MISSING_PERMISSIONS` when `botHasVoicePerms` (`ViewChannel` + `Connect` + `Speak`) is false; returns `{ ok: true }` otherwise.

`circuitBreaker.test.ts`:
- Trips (`tripped: true`) on 3rd consecutive `recordFailure(guildId)` (`count: 1`, `2`, `3`).
- `recordSuccess(guildId)` resets consecutive counter so subsequent failure starts back at `1`.
- Tracks guilds independently (`g1` failing twice does not affect `g2`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`  
Expected: FAIL (`Cannot find module '../../src/music/permissions.ts'`).

- [ ] **Step 3: Implement `src/music/permissions.ts` and `src/music/circuitBreaker.ts`**

Pure TypeScript functions/class with no `discord.js` runtime dependency so tests stay fast and decoupled.

- [ ] **Step 4: Run tests and typecheck to verify pass**

Run: `npm run typecheck && npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/music/permissions.ts src/music/circuitBreaker.ts tests/music/permissions.test.ts tests/music/circuitBreaker.test.ts
git commit -m "feat: add multi-server permission guardrails and track circuit breaker"
```

---

### Task 5: Query Classifier, Formatters & Interactive Player Panel

**Files:**
- Create: `src/music/queryValidator.ts`, `src/music/formatters.ts`, `src/music/playerPanel.ts`
- Test: `tests/music/queryValidator.test.ts`, `tests/music/formatters.test.ts`, `tests/music/playerPanel.test.ts`

**Interfaces:**
- Consumes: `discord.js` (`EmbedBuilder`, `ActionRowBuilder`, `ButtonBuilder`, `ButtonStyle`).
- Produces:
  - `classifyQuery(rawInput: string, spotifyEnabled: boolean): QueryClassification` in `src/music/queryValidator.ts`.
  - `formatDuration(ms: number | null | undefined, isStream?: boolean): string`, `buildProgressBar(positionMs: number, durationMs: number, size?: number): string`, `paginateQueue<T>(items: readonly T[], page: number, pageSize?: number)` in `src/music/formatters.ts`.
  - `PANEL_BUTTON_IDS`, `QUEUE_BUTTON_PREFIX`, `PanelTrackView`, `QueueTrackView`, `buildNowPlayingEmbed`, `buildControlButtons`, `buildQueueEmbed`, `buildQueuePaginationButtons`, `PanelMessageRef`, `PanelTracker` (`setPanel`, `getPanel`, `clearPanel`, `disablePanelSafely`) in `src/music/playerPanel.ts`.

- [ ] **Step 1: Write the failing tests**

- `tests/music/queryValidator.test.ts`:
  - YouTube URLs (`youtube.com/watch?v=...`, `youtu.be/...`, `youtube.com/shorts/...`, `music.youtube.com/playlist?list=...`, `youtube.com/watch?v=abc&list=RDabc`) → `{ ok: true, kind: 'youtube_url' }`.
  - Spotify URLs (`open.spotify.com/track/...`, `/album/...`, `/playlist/...`, `/artist/...`, `open.spotify.com/intl-pt/track/...`) with `spotifyEnabled: true` → `{ ok: true, kind: 'spotify_url' }`.
  - Plain text (`"evidências chitãozinho"`) → `{ ok: true, kind: 'search', source: 'ytmsearch' }`.
  - **Review Focus #1:** `https://soundcloud.com/x` or `https://example.com/song.mp3` → `{ ok: false, reason: 'UNSUPPORTED_URL' }` with `pt-BR` message; Spotify URL with `spotifyEnabled: false` → `{ ok: false, reason: 'SPOTIFY_DISABLED' }` with `pt-BR` message; blank string → `{ ok: false, reason: 'EMPTY' }`.
- `tests/music/formatters.test.ts`:
  - `formatDuration(225_000)` → `'03:45'`, `formatDuration(3_725_000)` → `'1:02:05'`, `formatDuration(0, true)` → `'AO VIVO'`.
  - `buildProgressBar(0, 100_000, 10)` and `buildProgressBar(50_000, 100_000, 10)` clamp safely within `0..durationMs`.
  - `paginateQueue(25 items, page 3, pageSize 10)` → `totalPages: 3`, `currentPage: 3`, `items.length: 5`, `startIndex: 20`; clamping out-of-range page `99` to `3` and `0` to `1`.
- `tests/music/playerPanel.test.ts`:
  - `buildControlButtons({ paused: false, repeatMode: 'off' })` returns 5 buttons (`music:toggle`, `music:skip`, `music:loop`, `music:shuffle`, `music:stop`) with Portuguese labels (`Pausar`, `Pular`, `Loop: Off`, `Embaralhar`, `Parar`); when `paused: true` label becomes `Retomar`; when `disabled: true` all 5 buttons are disabled.
  - **Review Focus #5:** `PanelTracker.disablePanelSafely` disables buttons on fetched message and swallows `Unknown Message` (code `10008`) / `Missing Access` (code `50001`) errors silently without throwing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`  
Expected: FAIL.

- [ ] **Step 3: Implement `queryValidator.ts`, `formatters.ts`, and `playerPanel.ts`**

- `classifyQuery`: parse `http:`/`https:` URLs with `new URL()` (also handling `spotify:` URIs if pasted), checking hostnames against YouTube (`youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`) and Spotify (`open.spotify.com`).
- All embed/button copy strictly in `pt-BR`.

- [ ] **Step 4: Run tests and typecheck to verify pass**

Run: `npm run typecheck && npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/music/queryValidator.ts src/music/formatters.ts src/music/playerPanel.ts tests/music/queryValidator.test.ts tests/music/formatters.test.ts tests/music/playerPanel.test.ts
git commit -m "feat: add query validator, formatters, and interactive player panel"
```

---

### Task 6: Timer Manager & Core `MusicService` (Decoupled from Discord Interactions)

**Files:**
- Create: `src/music/timerManager.ts`, `src/music/musicService.ts`
- Test: `tests/music/timerManager.test.ts`, `tests/music/musicService.test.ts`

**Interfaces:**
- Consumes: `GuildSettingsRepository` (Task 2), `SessionStoreRepository`, `SqliteQueueStore` (Task 3), `TrackCircuitBreaker` (Task 4), `classifyQuery`, `PanelTracker`, `PanelTrackView`, `QueueTrackView` (Task 5), `AppLogger` (Task 1), and a clean `LavalinkGateway` + `GuildMessenger` adapter interface defined in `src/music/musicService.ts` (decoupled from `discord.js` interactions).
- Produces: `TimerManager`, `RepeatMode`, `MusicService` (playback actions: `play`, `pause`, `resume`, `togglePause`, `skip`, `stop`, `shuffle`, `setLoop`, `cycleLoop`, `setVolume`, `remove`, `clearQueue`, `getNowPlaying`, `getQueue`; 24/7 helpers: `ensureConnected247(guildId, voiceChannelId, textChannelId)`, `handle247Disabled(guildId)`; lifecycle handlers: `handleTrackStart`, `handleTrackError`, `handleTrackStuck`, `handleQueueEnd`, `handleVoiceChannelEmpty`, `handleVoiceHumanJoined`, `handleVoiceDisconnect`, `handleNodeConnect`, `handleNodeResumed`, `handleFreshNodeSession`, `rejoin247Guilds`, `shutdownGracefully`).

- [ ] **Step 1: Write the failing tests in `tests/music/timerManager.test.ts` and `tests/music/musicService.test.ts`**

- `timerManager.test.ts`: verifies `schedule` fires callback after delay, replacing an existing timer cancels the prior one, `cancel` prevents firing, and `clearAll` clears all pending timers.
- `musicService.test.ts` (using in-memory `:memory:` SQLite DB + fake `LavalinkGateway` & `GuildMessenger`):
  - `play`: rejects unsupported URL / disabled Spotify before hitting Lavalink; returns friendly unavailable notice when no Lavalink node is connected; applies `defaultVolume` from `GuildSettingsRepository` on new player; updates `voiceChannelId247` + `textChannelId247` when `alwaysOn247 = true`; starts playback if idle.
  - **Review Focus #2:** `play` with a playlist exceeding `maxQueueSize` (e.g. `maxQueueSize = 5`, 2 already queued, 10 tracks returned) enqueues only `3` and returns `{ addedCount: 3, truncatedCount: 7 }`; when queue already at `5`, rejects with queue-full message without adding tracks.
  - `skip`: skips `amount` tracks; if `amount > queue.length`, clears remaining queue and stops current track safely (respecting 24/7 connection state).
  - `stop`: when `alwaysOn247 = false`, clears queue and disconnects (`botInitiatedDisconnect` recorded); when `alwaysOn247 = true`, stops playback and clears queue **without** disconnecting.
  - `ensureConnected247` & `handle247Disabled`: connects immediately into 24/7 voice channel when idle; `handle247Disabled` schedules `autoLeaveSeconds` timer if idle/empty.
  - `handleTrackError` / `handleTrackStuck`: 1st and 2nd consecutive failures notify channel & advance; 3rd trips circuit breaker, clears queue, notifies channel, and disconnects only if `alwaysOn247 = false`. `handleTrackStart` resets failure count and disables previous panel before sending new panel.
  - `handleQueueEnd` & `handleVoiceChannelEmpty`: schedules auto-leave timer (`autoLeaveSeconds`) when `alwaysOn247 = false` (cancelled by `play` or `handleVoiceHumanJoined`); when `alwaysOn247 = true`, pauses on empty channel instead of leaving.
  - **Review Focus #4:** `handleVoiceDisconnect` clears `voiceChannelId247` when triggered externally (moderator kick), but preserves `voiceChannelId247` when disconnect was bot-initiated (`stop`/`autoLeave`/`shutdown`).
  - **Review Focus #3:** `handleNodeConnect` saves `sessionId` and calls `updateSession(true, 60_000)` (or equivalent); `handleNodeResumed` rehydrates active players/panels from `active_player_sessions`; `handleFreshNodeSession` purges stale `lavalink_queues` + `active_player_sessions` and executes `250ms` staggered 24/7 rejoin (clearing invalid/permissionless channels gracefully).
  - `shutdownGracefully`: cancels all timers and closes without destroying Lavalink players.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`  
Expected: FAIL.

- [ ] **Step 3: Implement `src/music/timerManager.ts` and `src/music/musicService.ts`**

Inspect `node_modules/lavalink-client` type definitions for `updateSession` unit (seconds vs milliseconds) so the adapter passes exact `60s` timeout. Track `botInitiatedDisconnects: Set<string>` in `MusicService` to distinguish bot-driven disconnects from moderator kicks cleanly.

- [ ] **Step 4: Run tests and typecheck to verify pass**

Run: `npm run typecheck && npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/music/timerManager.ts src/music/musicService.ts tests/music/timerManager.test.ts tests/music/musicService.test.ts
git commit -m "feat: add TimerManager and decoupled MusicService with 24/7 and restart recovery"
```

---

### Task 7: All 13 Slash Commands & `deploy-commands` Script

**Files:**
- Create: `src/commands/types.ts`, `src/commands/guards.ts`, `src/commands/play.ts`, `src/commands/pause.ts`, `src/commands/resume.ts`, `src/commands/skip.ts`, `src/commands/stop.ts`, `src/commands/queue.ts`, `src/commands/nowplaying.ts`, `src/commands/shuffle.ts`, `src/commands/loop.ts`, `src/commands/volume.ts`, `src/commands/remove.ts`, `src/commands/clear.ts`, `src/commands/config.ts`, `src/commands/index.ts`, `src/deployCommands.ts`
- Test: `tests/commands/commands.test.ts`

**Interfaces:**
- Consumes: `EnvConfig` (Task 1), `GuildSettingsRepository` (Task 2), `canControlPlayer`, `validateMusicChannel`, `validateVoiceAccess` (Task 4), `buildNowPlayingEmbed`, `buildControlButtons`, `buildQueueEmbed`, `buildQueuePaginationButtons` (Task 5), `MusicService` (Task 6).
- Produces: `CommandContext`, `SlashCommand`, `allCommands`, `commandsByName`, `enforceCommandGuards` (`src/commands/guards.ts`), and `deployCommands(options)` (`src/deployCommands.ts`).

- [ ] **Step 1: Write the failing test in `tests/commands/commands.test.ts`**

Test:
- All 13 commands (`play`, `pause`, `resume`, `skip`, `stop`, `queue`, `nowplaying`, `shuffle`, `loop`, `volume`, `remove`, `clear`, `config`) exist in `commandsByName` and serialize cleanly via `.data.toJSON()`.
- Exact option constraints match spec: `/volume nivel` (`0..150`), `/config` has `default_member_permissions` requiring `ManageGuild`, `/config volume nivel` (`1..150`), `/config autosaida segundos` (`30..1800`), `/config modo247 ativado` (boolean), `/loop modo` choices (`off`, `track`, `queue`).
- `enforceCommandGuards`: enforces `music_channel_id` on music commands but bypasses it for `/config`; verifies voice membership + `ViewChannel`/`Connect`/`Speak` (with Stage Channel hint); enforces `canControlPlayer` on control commands (`pause`, `resume`, `skip`, `stop`, `shuffle`, `loop`, `volume`, `remove`, `clear`).
- `/config modo247`: enabling (`true`) rejects if neither bot nor member is in a voice channel, verifies bot voice perms, saves `voiceChannelId247` + `textChannelId247`, and calls `musicService.ensureConnected247(...)`; disabling (`false`) clears `voiceChannelId247` + `textChannelId247` and calls `musicService.handle247Disabled(...)`.
- `deployCommands` chooses guild route when `DEV_GUILD_ID` or `--guild` provided, and global route when `--global` or no `DEV_GUILD_ID`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`  
Expected: FAIL.

- [ ] **Step 3: Implement commands, guards, registry, and `src/deployCommands.ts`**

Use `Shared` `enforceCommandGuards` in `src/commands/guards.ts` so individual command files stay short, focused, and free of duplicated permission logic. In `/queue`, create a message component collector (`120_000` ms) to handle `queue:page:` buttons and disable buttons safely on timeout.

- [ ] **Step 4: Run tests and typecheck to verify pass**

Run: `npm run typecheck && npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands src/deployCommands.ts tests/commands/commands.test.ts
git commit -m "feat: add 13 pt-BR slash commands, guards, and deploy-commands script"
```

---

### Task 8: Discord Client Wiring, Interaction & Voice Handlers, and Main Entrypoint

**Files:**
- Create: `src/bot/createLavalinkManager.ts`, `src/bot/interactionHandler.ts`, `src/bot/voiceStateHandler.ts`, `src/bot/createBot.ts`, `src/index.ts`
- Test: `tests/bot/interactionHandler.test.ts`, `tests/bot/voiceStateHandler.test.ts`

**Interfaces:**
- Consumes: all Tasks 1–7 (`loadEnv`, `createLogger`, `openDatabase`, `GuildSettingsRepository`, `SessionStoreRepository`, `SqliteQueueStore`, `MusicService`, `commandsByName`, `PANEL_BUTTON_IDS`).
- Produces: `createLavalinkManager`, `handleInteraction`, `handleVoiceStateUpdate`, `createBot`, runnable `src/index.ts`.

- [ ] **Step 1: Write the failing tests in `tests/bot/interactionHandler.test.ts` and `tests/bot/voiceStateHandler.test.ts`**

- `interactionHandler.test.ts`:
  - Dispatches chat input commands to `commandsByName` and catches unexpected throws with an ephemeral `pt-BR` error reply (handling already-deferred interactions).
  - Handles all 5 `music:*` panel button clicks (`toggle`, `skip`, `loop`, `shuffle`, `stop`), checking same-voice-channel + `canControlPlayer` before acting.
  - **Review Focus #5:** clicking any `music:*` panel button when no player is active replies ephemerally in `pt-BR` and disables the stale message buttons cleanly without throwing.
- `voiceStateHandler.test.ts`:
  - Calls `musicService.handleVoiceDisconnect(guildId)` when `oldState` was the bot's own user leaving a channel (`newState.channelId === null`).
  - Calls `musicService.handleVoiceChannelEmpty(guildId)` when a human leaves the bot's channel and `0` non-bot members remain (ignoring other bots).
  - Calls `musicService.handleVoiceHumanJoined(guildId)` when a human joins the bot's channel.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`  
Expected: FAIL.

- [ ] **Step 3: Implement `src/bot/*` and `src/index.ts`**

- `createBot.ts`: creates `Client` with ONLY `GatewayIntentBits.Guilds` and `GatewayIntentBits.GuildVoiceStates`, forwards `raw` packets to `lavalink.sendRawData(packet)`, wires `LavalinkManager` with `SqliteQueueStore`, saved `sessionId`, `retryAmount: 100`, `retryDelay: 5_000`, `playerOptions.onDisconnect.autoReconnect: false`, `playerOptions.onEmptyQueue.autoPlayFunction: undefined` (so `MusicService` handles circuit breaker & 24/7 lifecycle), logs warning on boot if `!env.spotifyEnabled`, exposes `shutdown()` (`musicService.shutdownGracefully()`, `client.destroy()`, `db.close()` — never calling `player.destroy()`).
- `src/index.ts`: loads `dotenv/config` + `loadEnv()`, registers `SIGINT`, `SIGTERM`, `unhandledRejection`, `uncaughtException`, and starts bot.

- [ ] **Step 4: Run tests and typecheck to verify pass**

Run: `npm run typecheck && npm test`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot src/index.ts tests/bot/interactionHandler.test.ts tests/bot/voiceStateHandler.test.ts
git commit -m "feat: wire Discord client, Lavalink manager, interaction/voice handlers, and entrypoint"
```

---

### Task 9: Lavalink v4.2 Config, Multi-Stage Docker Compose, Portuguese `README.md` & Full Verification

**Files:**
- Create: `lavalink/application.yml`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `README.md`
- Test: `tests/infra/configFiles.test.ts`

**Interfaces:**
- Produces production containerization, Lavalink v4.2+ plugin configuration, and complete `pt-BR` operational docs matching Spec Sections 5.7, 5.8, and 6.

- [ ] **Step 1: Write the failing test in `tests/infra/configFiles.test.ts`**

Assert exact spec invariants across the config and doc files:
- `lavalink/application.yml`: contains `youtube: false`, `dev.lavalink.youtube:youtube-plugin:1.18.2`, `com.github.topi314.lavasrc:lavasrc-plugin:4.8.3`, root `plugins:` block with `MUSIC`/`ANDROID_VR`/`WEB`, `spotify: true`, `countryCode: "BR"`, `playlistLoadLimit: 6`, `albumLoadLimit: 6`, `${LAVALINK_SERVER_PASSWORD}`, `${SPOTIFY_CLIENT_ID:}`, `${SPOTIFY_CLIENT_SECRET:}`, `${SPOTIFY_SP_DC:}`, and NO hardcoded secrets.
- `docker-compose.yml`: uses `ghcr.io/lavalink-devs/lavalink:4.2-alpine`, `-Xmx1G`, `service_healthy`, `./data:/app/data`, named volume for `/opt/Lavalink/plugins`, `restart: unless-stopped`, and does NOT publish port `2333` (`ports:` absent on `lavalink`).
- `Dockerfile`: multi-stage `node:24-alpine`, non-root `USER node`, `--disable-warning=ExperimentalWarning`.
- `.env.example` and `README.md`: `README.md` is written in `pt-BR` and documents Discord Developer Portal, Spotify Premium 2026 Developer rule, local Windows run (Docker & Java 21 + Node 24), Oracle Cloud Always Free ARM64 deploy, OAuth/poToken YouTube block mitigation, and Oracle idle reclamation policy.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`  
Expected: FAIL (`ENOENT` on missing files).

- [ ] **Step 3: Create `lavalink/application.yml`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, and `README.md`**

Make sure `docker-compose.yml` mounts `./lavalink/application.yml:/opt/Lavalink/application.yml:ro`, passes `LAVALINK_SERVER_PASSWORD=${LAVALINK_PASSWORD}` and Spotify env vars to `lavalink`, and configures a `lavalink` healthcheck probing `http://127.0.0.1:2333/version` using BusyBox `wget --header="Authorization: $$LAVALINK_SERVER_PASSWORD" -q -O /dev/null http://127.0.0.1:2333/version || exit 1` via `CMD-SHELL`. Make sure `Dockerfile` creates `/app/data` owned by `node:node` before switching to `USER node`.

- [ ] **Step 4: Run full verification suite (`typecheck`, `build`, and all `tests`)**

Run: `npm run typecheck && npm run build && npm test`  
Expected: PASS (0 TypeScript errors, `dist/` compiled cleanly, all unit tests passing with 0 skips).

- [ ] **Step 5: Commit**

```bash
git add lavalink/application.yml Dockerfile docker-compose.yml .dockerignore README.md tests/infra/configFiles.test.ts
git commit -m "chore: add Lavalink v4.2 config, ARM64/AMD64 Docker Compose, and pt-BR README"
```
