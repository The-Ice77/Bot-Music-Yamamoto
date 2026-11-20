import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ApplicationCommandOptionType,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { EnvConfig } from '../../src/config/env.ts';
import { openDatabase } from '../../src/db/database.ts';
import { GuildSettingsRepository } from '../../src/db/guildSettingsRepository.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { QUEUE_BUTTON_PREFIX } from '../../src/music/playerPanel.ts';
import type { MusicService, RepeatMode } from '../../src/music/musicService.ts';
import { allCommands, commandsByName } from '../../src/commands/index.ts';
import { enforceCommandGuards } from '../../src/commands/guards.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { deployCommands } from '../../src/deployCommands.ts';

const EXPECTED_COMMAND_NAMES = [
  'play',
  'pause',
  'resume',
  'skip',
  'stop',
  'queue',
  'nowplaying',
  'shuffle',
  'loop',
  'volume',
  'remove',
  'clear',
  'config',
] as const;

function makeEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    DISCORD_TOKEN: 'discord-token-test',
    DISCORD_CLIENT_ID: 'client-123',
    DEV_GUILD_ID: undefined,
    LAVALINK_HOST: 'localhost',
    LAVALINK_PORT: 2333,
    LAVALINK_PASSWORD: 'secret',
    LAVALINK_SECURE: false,
    DATABASE_PATH: ':memory:',
    MAX_QUEUE_SIZE: 500,
    LOG_LEVEL: 'fatal',
    spotifyEnabled: true,
    ...overrides,
  };
}

interface FakeVoiceMember {
  id: string;
  user: { bot: boolean };
}

interface FakeVoiceChannel {
  id: string;
  type: ChannelType;
  members: Map<string, FakeVoiceMember>;
  permissionsFor: () => PermissionsBitField;
}

function makeVoiceChannel(options: {
  id?: string;
  type?: ChannelType;
  humanCount?: number;
  includeBot?: boolean;
  permissions?: bigint[];
} = {}): FakeVoiceChannel {
  const id = options.id ?? 'vc-1';
  const type = options.type ?? ChannelType.GuildVoice;
  const humanCount = options.humanCount ?? 1;
  const includeBot = options.includeBot ?? true;
  const members = new Map<string, FakeVoiceMember>();

  for (let i = 1; i <= humanCount; i += 1) {
    members.set(`user-${i}`, { id: `user-${i}`, user: { bot: false } });
  }
  if (includeBot) {
    members.set('bot-1', { id: 'bot-1', user: { bot: true } });
  }

  const perms = new PermissionsBitField(
    options.permissions ?? [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
    ],
  );

  return {
    id,
    type,
    members,
    permissionsFor: () => perms,
  };
}

class MockCollector extends EventEmitter {
  stoppedReason: string | null = null;
  stop(reason = 'user'): void {
    this.stoppedReason = reason;
    this.emit('end', new Map(), reason);
  }
}

interface InteractionMockOptions {
  guildId?: string | null;
  channelId?: string;
  userId?: string;
  memberVoiceChannel?: FakeVoiceChannel | null;
  botVoiceChannel?: FakeVoiceChannel | null;
  memberRoleIds?: string[];
  memberPerms?: bigint[];
  subcommand?: string;
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  booleans?: Record<string, boolean | null>;
  roles?: Record<string, { id: string } | null>;
  channels?: Record<string, { id: string } | null>;
}

function makeInteraction(opts: InteractionMockOptions = {}) {
  const replies: Array<Record<string, unknown>> = [];
  const edits: Array<Record<string, unknown>> = [];
  const messageEdits: Array<Record<string, unknown>> = [];
  const collectorOptionsList: Array<Record<string, unknown>> = [];
  let deferred = false;
  let replied = false;
  let lastCollector: MockCollector | null = null;
  let lastReplyPayload: Record<string, unknown> = {};

  const memberPerms = new PermissionsBitField(opts.memberPerms ?? []);
  const roleCache = new Map((opts.memberRoleIds ?? []).map((id) => [id, { id }]));

  const channelsCache = new Map<string, FakeVoiceChannel>();
  if (opts.memberVoiceChannel) {
    channelsCache.set(opts.memberVoiceChannel.id, opts.memberVoiceChannel);
  }
  if (opts.botVoiceChannel) {
    channelsCache.set(opts.botVoiceChannel.id, opts.botVoiceChannel);
  }

  const messageObj = {
    id: 'msg-reply-1',
    channelId: opts.channelId ?? 'tc-1',
    get components() {
      return (lastReplyPayload.components as unknown[]) ?? [];
    },
    edit: async (payload: Record<string, unknown>) => {
      messageEdits.push(payload);
      return messageObj;
    },
  };

  const responseObj = {
    id: 'msg-reply-1',
    fetch: async () => messageObj,
    createMessageComponentCollector: (collectorOpts: Record<string, unknown>) => {
      collectorOptionsList.push(collectorOpts);
      lastCollector = new MockCollector();
      return lastCollector;
    },
  };

  const guild =
    opts.guildId === null
      ? null
      : {
          id: opts.guildId ?? 'guild-1',
          channels: { cache: channelsCache },
          members: {
            me: {
              id: 'bot-1',
              voice: {
                channelId: opts.botVoiceChannel?.id ?? null,
                channel: opts.botVoiceChannel ?? null,
              },
            },
          },
        };

  const member =
    opts.guildId === null
      ? null
      : {
          id: opts.userId ?? 'user-1',
          user: { id: opts.userId ?? 'user-1', bot: false },
          voice: {
            channelId: opts.memberVoiceChannel?.id ?? null,
            channel: opts.memberVoiceChannel ?? null,
          },
          roles: { cache: roleCache },
          permissions: memberPerms,
        };

  const interaction = {
    guildId: opts.guildId === null ? null : (opts.guildId ?? 'guild-1'),
    channelId: opts.channelId ?? 'tc-1',
    user: { id: opts.userId ?? 'user-1', tag: 'user#0001', username: 'user' },
    guild,
    member,
    memberPermissions: opts.guildId === null ? null : memberPerms,
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    options: {
      getSubcommand: () => opts.subcommand ?? '',
      getString: (name: string, required?: boolean) => {
        const val = opts.strings?.[name] ?? null;
        if (required && val === null) {
          throw new Error(`Missing required string option: ${name}`);
        }
        return val;
      },
      getInteger: (name: string, required?: boolean) => {
        const val = opts.integers?.[name] ?? null;
        if (required && val === null) {
          throw new Error(`Missing required integer option: ${name}`);
        }
        return val;
      },
      getBoolean: (name: string, required?: boolean) => {
        const val = opts.booleans?.[name] ?? null;
        if (required && val === null) {
          throw new Error(`Missing required boolean option: ${name}`);
        }
        return val;
      },
      getRole: (name: string) => opts.roles?.[name] ?? null,
      getChannel: (name: string) => opts.channels?.[name] ?? null,
    },
    deferReply: async () => {
      deferred = true;
    },
    reply: async (payload: Record<string, unknown> | string) => {
      replied = true;
      const normalized = typeof payload === 'string' ? { content: payload } : payload;
      lastReplyPayload = normalized;
      replies.push(normalized);
      return responseObj;
    },
    editReply: async (payload: Record<string, unknown> | string) => {
      replied = true;
      const normalized = typeof payload === 'string' ? { content: payload } : payload;
      lastReplyPayload = normalized;
      edits.push(normalized);
      return messageObj;
    },
    fetchReply: async () => messageObj,
  };

  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    replies,
    edits,
    messageEdits,
    collectorOptionsList,
    getCollector: () => lastCollector,
  };
}

function isEphemeral(payload: Record<string, unknown>): boolean {
  return payload.ephemeral === true || payload.flags === MessageFlags.Ephemeral;
}

function makeFakeMusicService() {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const service = {
    play: async (...args: unknown[]) => {
      calls.push({ method: 'play', args });
      return {
        ok: true,
        isPlaylist: false,
        playlistName: null,
        tracks: [],
        firstTrack: {
          info: {
            title: 'Evidências',
            author: 'Chitãozinho & Xororó',
            duration: 279_000,
            uri: 'https://www.youtube.com/watch?v=abc',
            artworkUrl: null,
            isStream: false,
          },
        },
        addedCount: 1,
        truncatedCount: 0,
        startedImmediately: true,
        message: 'Tocando agora: **Evidências** — Chitãozinho & Xororó.',
      };
    },
    pause: async (...args: unknown[]) => {
      calls.push({ method: 'pause', args });
      return { ok: true, paused: true, message: 'Reprodução pausada.' };
    },
    resume: async (...args: unknown[]) => {
      calls.push({ method: 'resume', args });
      return { ok: true, paused: false, message: 'Reprodução retomada.' };
    },
    skip: async (...args: unknown[]) => {
      calls.push({ method: 'skip', args });
      return {
        ok: true,
        skippedTitle: 'Faixa 1',
        endedQueue: false,
        message: 'Música pulada: **Faixa 1**.',
      };
    },
    stop: async (...args: unknown[]) => {
      calls.push({ method: 'stop', args });
      return {
        ok: true,
        disconnected: true,
        message: 'Reprodução parada, fila limpa e desconectado do canal de voz.',
      };
    },
    shuffle: async (...args: unknown[]) => {
      calls.push({ method: 'shuffle', args });
      return { ok: true, queueLength: 4, message: 'Fila embaralhada com sucesso!' };
    },
    setLoop: async (...args: unknown[]) => {
      calls.push({ method: 'setLoop', args });
      const mode = args[1] as RepeatMode;
      return { ok: true, repeatMode: mode, message: `Modo de repetição: **${mode}**.` };
    },
    setVolume: async (...args: unknown[]) => {
      calls.push({ method: 'setVolume', args });
      return { ok: true, volume: args[1] as number, message: `Volume ajustado para **${args[1]}%**.` };
    },
    remove: async (...args: unknown[]) => {
      calls.push({ method: 'remove', args });
      return {
        ok: true,
        position: args[1] as number,
        removedTrack: { info: { title: 'Removida' } },
        message: 'Removida da fila (posição **1**): **Removida**.',
      };
    },
    clearQueue: async (...args: unknown[]) => {
      calls.push({ method: 'clearQueue', args });
      return { ok: true, clearedCount: 3, message: 'Fila limpa (**3** músicas removidas).' };
    },
    getNowPlaying: (...args: unknown[]) => {
      calls.push({ method: 'getNowPlaying', args });
      return {
        track: {
          title: 'Tocando Agora',
          author: 'Artista',
          uri: 'https://www.youtube.com/watch?v=1',
          artworkUrl: null,
          durationMs: 200_000,
          positionMs: 50_000,
          isStream: false,
          requesterId: 'user-1',
        },
        paused: false,
        volume: 80,
        repeatMode: 'off' as RepeatMode,
        queueLength: 2,
        voiceChannelId: 'vc-1',
        textChannelId: 'tc-1',
      };
    },
    getQueue: (...args: unknown[]) => {
      calls.push({ method: 'getQueue', args });
      return {
        currentTrack: {
          title: 'Atual',
          author: 'Artista',
          durationMs: 180_000,
          isStream: false,
          requesterId: 'user-1',
        },
        queue: Array.from({ length: 15 }, (_, i) => ({
          title: `Faixa ${i + 1}`,
          author: `Autor ${i + 1}`,
          durationMs: 120_000,
          isStream: false,
          requesterId: 'user-1',
        })),
        repeatMode: 'off' as RepeatMode,
        paused: false,
        volume: 80,
      };
    },
    registerPanel: async (...args: unknown[]) => {
      calls.push({ method: 'registerPanel', args });
    },
    ensureConnected247: async (...args: unknown[]) => {
      calls.push({ method: 'ensureConnected247', args });
      return { ok: true, alreadyConnected: false };
    },
    handle247Disabled: async (...args: unknown[]) => {
      calls.push({ method: 'handle247Disabled', args });
    },
  };

  return {
    service,
    calls,
  };
}

function makeTestContext(musicService?: unknown): {
  context: CommandContext;
  settingsRepo: GuildSettingsRepository;
  close: () => void;
} {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  const logger = createLogger('fatal', new PassThrough());
  const env = makeEnv();

  return {
    context: {
      env,
      logger,
      settingsRepo,
      musicService: (musicService ?? makeFakeMusicService().service) as MusicService,
    },
    settingsRepo,
    close: () => db.close(),
  };
}

test('all 13 commands exist in commandsByName and serialize cleanly via .data.toJSON()', () => {
  assert.equal(allCommands.length, 13);
  assert.equal(commandsByName.size, 13);

  for (const name of EXPECTED_COMMAND_NAMES) {
    const cmd = commandsByName.get(name);
    assert.ok(cmd, `Expected command ${name} in commandsByName`);
    const json = cmd.data.toJSON();
    assert.equal(json.name, name);
    assert.ok(json.description.length > 0 && json.description.length <= 100);
    assert.equal(typeof cmd.execute, 'function');
  }
});

test('command option schemas and constraints match spec', () => {
  const playJson = commandsByName.get('play')!.data.toJSON();
  assert.equal(playJson.options?.length, 1);
  assert.equal(playJson.options?.[0]?.name, 'busca');
  assert.equal(playJson.options?.[0]?.type, ApplicationCommandOptionType.String);
  assert.equal(playJson.options?.[0]?.required, true);
  assert.equal('autocomplete' in playJson.options![0] ? playJson.options![0].autocomplete : undefined, undefined);

  const volumeJson = commandsByName.get('volume')!.data.toJSON();
  const volumeOption = volumeJson.options?.[0] as {
    name: string;
    type: number;
    required?: boolean;
    min_value?: number;
    max_value?: number;
  };
  assert.equal(volumeOption.name, 'nivel');
  assert.equal(volumeOption.type, ApplicationCommandOptionType.Integer);
  assert.equal(volumeOption.required, true);
  assert.equal(volumeOption.min_value, 0);
  assert.equal(volumeOption.max_value, 150);

  const loopJson = commandsByName.get('loop')!.data.toJSON();
  const loopOption = loopJson.options?.[0] as {
    name: string;
    type: number;
    required?: boolean;
    choices?: Array<{ name: string; value: string }>;
  };
  assert.equal(loopOption.name, 'modo');
  assert.equal(loopOption.type, ApplicationCommandOptionType.String);
  assert.equal(loopOption.required, true);
  assert.deepEqual(
    (loopOption.choices ?? []).map((c) => ({ name: c.name, value: c.value })),
    [
      { name: 'Desativado', value: 'off' },
      { name: 'Música', value: 'track' },
      { name: 'Fila', value: 'queue' },
    ],
  );

  const skipJson = commandsByName.get('skip')!.data.toJSON();
  assert.equal(skipJson.options?.[0]?.name, 'quantidade');
  assert.equal((skipJson.options?.[0] as { min_value?: number }).min_value, 1);

  const queueJson = commandsByName.get('queue')!.data.toJSON();
  assert.equal(queueJson.options?.[0]?.name, 'pagina');
  assert.equal((queueJson.options?.[0] as { min_value?: number }).min_value, 1);

  const removeJson = commandsByName.get('remove')!.data.toJSON();
  assert.equal(removeJson.options?.[0]?.name, 'posicao');
  assert.equal(removeJson.options?.[0]?.required, true);
  assert.equal((removeJson.options?.[0] as { min_value?: number }).min_value, 1);

  const configJson = commandsByName.get('config')!.data.toJSON();
  assert.equal(
    configJson.default_member_permissions,
    PermissionFlagsBits.ManageGuild.toString(),
  );

  const subcommands = configJson.options ?? [];
  assert.deepEqual(
    subcommands.map((s) => s.name),
    ['ver', 'volume', 'dj', 'canal', 'autosaida', 'modo247'],
  );

  const cfgVol = subcommands.find((s) => s.name === 'volume') as {
    options?: Array<{ name: string; required?: boolean; min_value?: number; max_value?: number }>;
  };
  assert.equal(cfgVol.options?.[0]?.name, 'nivel');
  assert.equal(cfgVol.options?.[0]?.required, true);
  assert.equal(cfgVol.options?.[0]?.min_value, 1);
  assert.equal(cfgVol.options?.[0]?.max_value, 150);

  const cfgDj = subcommands.find((s) => s.name === 'dj') as {
    options?: Array<{ name: string; type: number; required?: boolean }>;
  };
  assert.equal(cfgDj.options?.[0]?.name, 'cargo');
  assert.equal(cfgDj.options?.[0]?.type, ApplicationCommandOptionType.Role);
  assert.equal(Boolean(cfgDj.options?.[0]?.required), false);

  const cfgCanal = subcommands.find((s) => s.name === 'canal') as {
    options?: Array<{ name: string; type: number; required?: boolean }>;
  };
  assert.equal(cfgCanal.options?.[0]?.name, 'canal_texto');
  assert.equal(cfgCanal.options?.[0]?.type, ApplicationCommandOptionType.Channel);
  assert.equal(Boolean(cfgCanal.options?.[0]?.required), false);

  const cfgAutoSaida = subcommands.find((s) => s.name === 'autosaida') as {
    options?: Array<{ name: string; type: number; required?: boolean; min_value?: number; max_value?: number }>;
  };
  assert.equal(cfgAutoSaida.options?.[0]?.name, 'segundos');
  assert.equal(cfgAutoSaida.options?.[0]?.type, ApplicationCommandOptionType.Integer);
  assert.equal(cfgAutoSaida.options?.[0]?.required, true);
  assert.equal(cfgAutoSaida.options?.[0]?.min_value, 30);
  assert.equal(cfgAutoSaida.options?.[0]?.max_value, 1800);

  const cfg247 = subcommands.find((s) => s.name === 'modo247') as {
    options?: Array<{ name: string; type: number; required?: boolean }>;
  };
  assert.equal(cfg247.options?.[0]?.name, 'ativado');
  assert.equal(cfg247.options?.[0]?.type, ApplicationCommandOptionType.Boolean);
  assert.equal(cfg247.options?.[0]?.required, true);
});

test('enforceCommandGuards enforces music_channel_id on music commands and bypasses it for /config', async () => {
  const { context, settingsRepo, close } = makeTestContext();
  try {
    settingsRepo.update('guild-1', { musicChannelId: 'tc-music' });

    const wrongChannel = makeInteraction({
      guildId: 'guild-1',
      channelId: 'tc-general',
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    const blocked = await enforceCommandGuards(wrongChannel.interaction, context, {
      requireVoice: false,
      requireControl: false,
    });
    assert.equal(blocked.ok, false);
    assert.equal(wrongChannel.replies.length, 1);
    assert.equal(isEphemeral(wrongChannel.replies[0]), true);
    assert.match(String(wrongChannel.replies[0].content), /<#tc-music>/);

    const configInOtherChannel = makeInteraction({
      guildId: 'guild-1',
      channelId: 'tc-general',
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    const allowedConfig = await enforceCommandGuards(configInOtherChannel.interaction, context, {
      enforceMusicChannel: false,
      requireVoice: false,
      requireControl: false,
      requireManageGuild: true,
    });
    assert.equal(allowedConfig.ok, true);
    assert.equal(configInOtherChannel.replies.length, 0);
  } finally {
    close();
  }
});

test('enforceCommandGuards validates voice membership, matching channel, and ViewChannel/Connect/Speak with Stage hint', async () => {
  const { context, close } = makeTestContext();
  try {
    const notInVoice = makeInteraction({ memberVoiceChannel: null });
    const r1 = await enforceCommandGuards(notInVoice.interaction, context, { requireVoice: true });
    assert.equal(r1.ok, false);
    assert.equal(isEphemeral(notInVoice.replies[0]), true);

    const vc1 = makeVoiceChannel({ id: 'vc-1' });
    const vc2 = makeVoiceChannel({ id: 'vc-2' });
    const diffChannel = makeInteraction({ memberVoiceChannel: vc1, botVoiceChannel: vc2 });
    const r2 = await enforceCommandGuards(diffChannel.interaction, context, { requireVoice: true });
    assert.equal(r2.ok, false);
    assert.equal(isEphemeral(diffChannel.replies[0]), true);
    assert.match(String(diffChannel.replies[0].content), /<#vc-2>/);

    const stageNoSpeak = makeVoiceChannel({
      id: 'stage-1',
      type: ChannelType.GuildStageVoice,
      permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    });
    const stageMock = makeInteraction({ memberVoiceChannel: stageNoSpeak });
    const r3 = await enforceCommandGuards(stageMock.interaction, context, { requireVoice: true });
    assert.equal(r3.ok, false);
    assert.equal(isEphemeral(stageMock.replies[0]), true);
    assert.match(String(stageMock.replies[0].content), /Falar|Speak/i);
    assert.match(String(stageMock.replies[0].content), /Palco|Stage|orador/i);
  } finally {
    close();
  }
});

test('enforceCommandGuards enforces canControlPlayer on all 9 control commands while allowing /play', async () => {
  const { context, settingsRepo, close } = makeTestContext();
  try {
    settingsRepo.update('guild-1', { djRoleId: 'role-dj' });
    const sharedVc = makeVoiceChannel({ id: 'vc-1', humanCount: 3, includeBot: true });

    const controlCommands = ['pause', 'resume', 'skip', 'stop', 'shuffle', 'loop', 'volume', 'remove', 'clear'] as const;
    for (const cmdName of controlCommands) {
      const mock = makeInteraction({
        memberVoiceChannel: sharedVc,
        botVoiceChannel: sharedVc,
        memberRoleIds: [],
        memberPerms: [],
        integers: { quantidade: 1, nivel: 50, posicao: 1 },
        strings: { modo: 'track' },
      });
      await commandsByName.get(cmdName)!.execute(mock.interaction, context);
      assert.equal(mock.replies.length, 1, `Expected ephemeral denial for /${cmdName}`);
      assert.equal(isEphemeral(mock.replies[0]), true);
      assert.match(String(mock.replies[0].content), /DJ|<@&role-dj>/i);
    }

    // Non-DJ member in same channel CAN run /play
    const playMock = makeInteraction({
      memberVoiceChannel: sharedVc,
      botVoiceChannel: sharedVc,
      memberRoleIds: [],
      memberPerms: [],
      strings: { busca: 'legiao urbana' },
    });
    await commandsByName.get('play')!.execute(playMock.interaction, context);
    assert.equal(playMock.edits.length, 1);

    // Lone human in channel CAN run control command even without DJ role
    const loneVc = makeVoiceChannel({ id: 'vc-1', humanCount: 1, includeBot: true });
    const lonePause = makeInteraction({
      memberVoiceChannel: loneVc,
      botVoiceChannel: loneVc,
      memberRoleIds: [],
      memberPerms: [],
    });
    await commandsByName.get('pause')!.execute(lonePause.interaction, context);
    assert.equal(lonePause.replies.length, 1);
    assert.equal(isEphemeral(lonePause.replies[0]), false);

    // Member with DJ role CAN run control command in crowded channel
    const djSkip = makeInteraction({
      memberVoiceChannel: sharedVc,
      botVoiceChannel: sharedVc,
      memberRoleIds: ['role-dj'],
      memberPerms: [],
    });
    await commandsByName.get('skip')!.execute(djSkip.interaction, context);
    assert.equal(djSkip.replies.length, 1);
    assert.equal(isEphemeral(djSkip.replies[0]), false);
  } finally {
    close();
  }
});

test('/queue handles pagination buttons with 120_000ms collector and disables buttons on timeout', async () => {
  const fake = makeFakeMusicService();
  const { context, close } = makeTestContext(fake.service);
  try {
    const mock = makeInteraction({
      channelId: 'tc-1',
      integers: { pagina: 1 },
    });

    await commandsByName.get('queue')!.execute(mock.interaction, context);

    assert.equal(mock.replies.length, 1);
    assert.equal(mock.collectorOptionsList.length, 1);
    assert.equal(mock.collectorOptionsList[0].time, 120_000);

    const collector = mock.getCollector();
    assert.ok(collector);

    const updates: Array<Record<string, unknown>> = [];
    collector.emit('collect', {
      customId: `${QUEUE_BUTTON_PREFIX}2`,
      user: { id: 'user-1' },
      update: async (payload: Record<string, unknown>) => {
        updates.push(payload);
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(updates.length, 1);
    const updatedEmbed = (updates[0].embeds as Array<{ toJSON: () => { footer?: { text?: string } } }>)[0].toJSON();
    assert.match(updatedEmbed.footer?.text ?? '', /Página 2 de 2/);

    // Simulate collector timeout ('end')
    collector.emit('end', new Map(), 'time');
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(mock.messageEdits.length, 1);
    const disabledRow = (
      mock.messageEdits[0].components as Array<{
        toJSON: () => { components: Array<{ label?: string; disabled?: boolean }> };
      }>
    )[0].toJSON();
    assert.equal(disabledRow.components.length, 2);
    assert.equal(disabledRow.components[0].label, 'Anterior');
    assert.equal(disabledRow.components[1].label, 'Próxima');
    assert.equal(disabledRow.components.every((btn) => btn.disabled === true), true);
  } finally {
    close();
  }
});

test('/nowplaying posts panel with control buttons and registers panel ref', async () => {
  const fake = makeFakeMusicService();
  const { context, close } = makeTestContext(fake.service);
  try {
    const mock = makeInteraction({ channelId: 'tc-np' });
    await commandsByName.get('nowplaying')!.execute(mock.interaction, context);

    assert.equal(mock.replies.length, 1);
    const reply = mock.replies[0];
    assert.ok(Array.isArray(reply.embeds) && reply.embeds.length === 1);
    assert.ok(Array.isArray(reply.components) && reply.components.length === 1);

    const registerCall = fake.calls.find((c) => c.method === 'registerPanel');
    assert.ok(registerCall);
    assert.deepEqual(registerCall.args, ['guild-1', { channelId: 'tc-np', messageId: 'msg-reply-1' }]);
  } finally {
    close();
  }
});

test('/config subcommands persist guild settings and modo247 handles enable/disable validation', async () => {
  const fake = makeFakeMusicService();
  const { context, settingsRepo, close } = makeTestContext(fake.service);
  try {
    // 1. /config volume, dj, canal, autosaida, ver
    const volCmd = makeInteraction({
      subcommand: 'volume',
      integers: { nivel: 65 },
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(volCmd.interaction, context);
    assert.equal(settingsRepo.getOrDefault('guild-1').defaultVolume, 65);

    const djCmd = makeInteraction({
      subcommand: 'dj',
      roles: { cargo: { id: 'dj-99' } },
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(djCmd.interaction, context);
    assert.equal(settingsRepo.getOrDefault('guild-1').djRoleId, 'dj-99');

    const canalCmd = makeInteraction({
      subcommand: 'canal',
      channels: { canal_texto: { id: 'tc-only' } },
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(canalCmd.interaction, context);
    assert.equal(settingsRepo.getOrDefault('guild-1').musicChannelId, 'tc-only');

    const autoCmd = makeInteraction({
      subcommand: 'autosaida',
      integers: { segundos: 300 },
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(autoCmd.interaction, context);
    assert.equal(settingsRepo.getOrDefault('guild-1').autoLeaveSeconds, 300);

    const verCmd = makeInteraction({
      subcommand: 'ver',
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(verCmd.interaction, context);
    assert.equal(verCmd.replies.length, 1);

    // 2. /config modo247 true rejects when neither bot nor member is in voice
    const m247NoVoice = makeInteraction({
      subcommand: 'modo247',
      booleans: { ativado: true },
      memberVoiceChannel: null,
      botVoiceChannel: null,
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(m247NoVoice.interaction, context);
    assert.equal(isEphemeral(m247NoVoice.replies[0]), true);
    assert.equal(settingsRepo.getOrDefault('guild-1').alwaysOn247, false);

    // 3. /config modo247 true rejects when bot lacks voice perms
    const noPermVc = makeVoiceChannel({
      id: 'vc-locked',
      permissions: [PermissionFlagsBits.ViewChannel],
    });
    const m247NoPerms = makeInteraction({
      subcommand: 'modo247',
      booleans: { ativado: true },
      memberVoiceChannel: noPermVc,
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(m247NoPerms.interaction, context);
    assert.equal(isEphemeral(m247NoPerms.replies[0]), true);
    assert.equal(settingsRepo.getOrDefault('guild-1').alwaysOn247, false);

    // 4. /config modo247 true succeeds when member is in voice with perms
    const okVc = makeVoiceChannel({ id: 'vc-247' });
    const m247Enable = makeInteraction({
      subcommand: 'modo247',
      channelId: 'tc-247',
      booleans: { ativado: true },
      memberVoiceChannel: okVc,
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(m247Enable.interaction, context);

    const afterEnable = settingsRepo.getOrDefault('guild-1');
    assert.equal(afterEnable.alwaysOn247, true);
    assert.equal(afterEnable.voiceChannelId247, 'vc-247');
    assert.equal(afterEnable.textChannelId247, 'tc-247');
    const ensureCall = fake.calls.find((c) => c.method === 'ensureConnected247');
    assert.deepEqual(ensureCall?.args, ['guild-1', 'vc-247', 'tc-247']);

    // 5. /config modo247 false clears 24/7 channels and calls handle247Disabled
    const m247Disable = makeInteraction({
      subcommand: 'modo247',
      booleans: { ativado: false },
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(m247Disable.interaction, context);

    const afterDisable = settingsRepo.getOrDefault('guild-1');
    assert.equal(afterDisable.alwaysOn247, false);
    assert.equal(afterDisable.voiceChannelId247, null);
    assert.equal(afterDisable.textChannelId247, null);
    const disabledCall = fake.calls.find((c) => c.method === 'handle247Disabled');
    assert.deepEqual(disabledCall?.args, ['guild-1']);
  } finally {
    close();
  }
});

test('deployCommands selects guild or global route based on DEV_GUILD_ID, --guild, and --global', async () => {
  const putCalls: Array<{ route: string; body: unknown[] }> = [];
  const fakeRest = {
    put: async (fullRoute: `/${string}`, options: { body: unknown }) => {
      putCalls.push({ route: fullRoute, body: options.body as unknown[] });
      return options.body;
    },
  };
  const logger = createLogger('fatal', new PassThrough());

  // 1. DEV_GUILD_ID set -> guild route
  const r1 = await deployCommands({
    env: makeEnv({ DISCORD_CLIENT_ID: 'app-1', DEV_GUILD_ID: 'guild-dev' }),
    rest: fakeRest,
    logger,
  });
  assert.equal(r1.scope, 'guild');
  assert.equal(r1.route, '/applications/app-1/guilds/guild-dev/commands');
  assert.equal(r1.commandCount, 13);

  // 2. --guild overrides DEV_GUILD_ID
  const r2 = await deployCommands({
    env: makeEnv({ DISCORD_CLIENT_ID: 'app-1', DEV_GUILD_ID: 'guild-dev' }),
    argv: ['--guild', 'guild-override'],
    rest: fakeRest,
    logger,
  });
  assert.equal(r2.scope, 'guild');
  assert.equal(r2.route, '/applications/app-1/guilds/guild-override/commands');

  // 3. --global overrides DEV_GUILD_ID -> global route
  const r3 = await deployCommands({
    env: makeEnv({ DISCORD_CLIENT_ID: 'app-1', DEV_GUILD_ID: 'guild-dev' }),
    argv: ['--global'],
    rest: fakeRest,
    logger,
  });
  assert.equal(r3.scope, 'global');
  assert.equal(r3.route, '/applications/app-1/commands');

  // 4. No DEV_GUILD_ID -> global route
  const r4 = await deployCommands({
    env: makeEnv({ DISCORD_CLIENT_ID: 'app-1', DEV_GUILD_ID: undefined }),
    rest: fakeRest,
    logger,
  });
  assert.equal(r4.scope, 'global');
  assert.equal(r4.route, '/applications/app-1/commands');

  assert.equal(putCalls.length, 4);
  for (const call of putCalls) {
    assert.equal(call.body.length, 13);
  }

  // 5. --guild=<id> equals syntax works, and conflicting --global + --guild rejects
  const r5 = await deployCommands({
    env: makeEnv({ DISCORD_CLIENT_ID: 'app-1' }),
    argv: ['--guild=guild-eq'],
    rest: fakeRest,
    logger,
  });
  assert.equal(r5.route, '/applications/app-1/guilds/guild-eq/commands');

  await assert.rejects(
    () =>
      deployCommands({
        env: makeEnv({ DISCORD_CLIENT_ID: 'app-1' }),
        argv: ['--global', '--guild', 'guild-x'],
        rest: fakeRest,
        logger,
      }),
    /simultaneamente/i,
  );
});

test('music commands forward arguments, render clean embeds on success, and reply ephemerally on service errors', async () => {
  const fake = makeFakeMusicService();
  const { context, close } = makeTestContext(fake.service);
  try {
    const vc = makeVoiceChannel({ id: 'vc-1', humanCount: 1, includeBot: true });

    await commandsByName.get('skip')!.execute(
      makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc, integers: { quantidade: 3 } }).interaction,
      context,
    );
    await commandsByName.get('loop')!.execute(
      makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc, strings: { modo: 'queue' } }).interaction,
      context,
    );
    await commandsByName.get('volume')!.execute(
      makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc, integers: { nivel: 120 } }).interaction,
      context,
    );
    await commandsByName.get('remove')!.execute(
      makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc, integers: { posicao: 2 } }).interaction,
      context,
    );
    await commandsByName.get('clear')!.execute(
      makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc }).interaction,
      context,
    );
    await commandsByName.get('resume')!.execute(
      makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc }).interaction,
      context,
    );
    await commandsByName.get('shuffle')!.execute(
      makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc }).interaction,
      context,
    );
    await commandsByName.get('stop')!.execute(
      makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc }).interaction,
      context,
    );

    assert.deepEqual(fake.calls.find((c) => c.method === 'skip')?.args, ['guild-1', 3]);
    assert.deepEqual(fake.calls.find((c) => c.method === 'setLoop')?.args, ['guild-1', 'queue']);
    assert.deepEqual(fake.calls.find((c) => c.method === 'setVolume')?.args, ['guild-1', 120]);
    assert.deepEqual(fake.calls.find((c) => c.method === 'remove')?.args, ['guild-1', 2]);
    assert.ok(fake.calls.some((c) => c.method === 'clearQueue'));
    assert.ok(fake.calls.some((c) => c.method === 'resume'));
    assert.ok(fake.calls.some((c) => c.method === 'shuffle'));
    assert.ok(fake.calls.some((c) => c.method === 'stop'));

    // Service errors reply ephemerally
    fake.service.pause = async () => ({
      ok: false,
      reason: 'ALREADY_PAUSED',
      message: 'A reprodução já está pausada.',
    });
    const pauseFail = makeInteraction({ memberVoiceChannel: vc, botVoiceChannel: vc });
    await commandsByName.get('pause')!.execute(pauseFail.interaction, context);
    assert.equal(isEphemeral(pauseFail.replies[0]), true);
    assert.match(String(pauseFail.replies[0].content), /já está pausada/i);

    // /play handles playlist and failure
    fake.service.play = async () => ({
      ok: true,
      isPlaylist: true,
      playlistName: 'Rock BR',
      tracks: [],
      firstTrack: {
        info: { title: 'Tempo Perdido', author: 'Legião Urbana', duration: 300_000, uri: null, artworkUrl: null, isStream: false },
      },
      addedCount: 10,
      truncatedCount: 0,
      startedImmediately: true,
      message: 'Playlist **Rock BR** adicionada com **10** músicas.',
    });
    const playlistMock = makeInteraction({
      memberVoiceChannel: vc,
      strings: { busca: 'https://open.spotify.com/playlist/123' },
    });
    await commandsByName.get('play')!.execute(playlistMock.interaction, context);
    assert.equal(playlistMock.edits.length, 1);

    fake.service.play = async () => ({
      ok: false,
      reason: 'SPOTIFY_DISABLED',
      message: 'Links do Spotify estão indisponíveis no momento.',
    });
    const playFail = makeInteraction({
      memberVoiceChannel: vc,
      strings: { busca: 'https://open.spotify.com/track/123' },
    });
    await commandsByName.get('play')!.execute(playFail.interaction, context);
    assert.match(String(playFail.edits[0].content), /Spotify/i);

    // /nowplaying and /queue reply ephemerally when idle/empty
    fake.service.getNowPlaying = () => null as never;
    const npEmpty = makeInteraction({});
    await commandsByName.get('nowplaying')!.execute(npEmpty.interaction, context);
    assert.equal(isEphemeral(npEmpty.replies[0]), true);

    fake.service.getQueue = () => null as never;
    const qEmpty = makeInteraction({});
    await commandsByName.get('queue')!.execute(qEmpty.interaction, context);
    assert.equal(isEphemeral(qEmpty.replies[0]), true);
  } finally {
    close();
  }
});

test('/config enforces ManageGuild, clears optional fields, and supports bot-connected modo247', async () => {
  const fake = makeFakeMusicService();
  const { context, settingsRepo, close } = makeTestContext(fake.service);
  try {
    const nonAdmin = makeInteraction({ subcommand: 'ver', memberPerms: [] });
    await commandsByName.get('config')!.execute(nonAdmin.interaction, context);
    assert.equal(isEphemeral(nonAdmin.replies[0]), true);

    settingsRepo.update('guild-1', { djRoleId: 'dj-1', musicChannelId: 'tc-1' });
    await commandsByName.get('config')!.execute(
      makeInteraction({ subcommand: 'dj', roles: { cargo: null }, memberPerms: [PermissionFlagsBits.ManageGuild] }).interaction,
      context,
    );
    await commandsByName.get('config')!.execute(
      makeInteraction({ subcommand: 'canal', channels: { canal_texto: null }, memberPerms: [PermissionFlagsBits.ManageGuild] }).interaction,
      context,
    );
    assert.equal(settingsRepo.getOrDefault('guild-1').djRoleId, null);
    assert.equal(settingsRepo.getOrDefault('guild-1').musicChannelId, null);

    // Member not in voice, but bot already connected in vc-bot -> modo247 true succeeds
    const botVc = makeVoiceChannel({ id: 'vc-bot' });
    const m247BotOnly = makeInteraction({
      subcommand: 'modo247',
      channelId: 'tc-bot',
      booleans: { ativado: true },
      memberVoiceChannel: null,
      botVoiceChannel: botVc,
      memberPerms: [PermissionFlagsBits.ManageGuild],
    });
    await commandsByName.get('config')!.execute(m247BotOnly.interaction, context);
    assert.equal(settingsRepo.getOrDefault('guild-1').voiceChannelId247, 'vc-bot');
    assert.equal(settingsRepo.getOrDefault('guild-1').textChannelId247, 'tc-bot');
  } finally {
    close();
  }
});
