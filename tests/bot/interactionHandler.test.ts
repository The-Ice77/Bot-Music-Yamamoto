import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { openDatabase } from '../../src/db/database.ts';
import { GuildSettingsRepository } from '../../src/db/guildSettingsRepository.ts';
import { createLogger } from '../../src/utils/logger.ts';
import {
  PANEL_BUTTON_IDS,
  QUEUE_ACTION_IDS,
  QUEUE_ACTION_PREFIX,
  QUEUE_BUTTON_PREFIX,
  buildControlButtons,
} from '../../src/music/playerPanel.ts';
import type { MusicService, NowPlayingSnapshot } from '../../src/music/musicService.ts';
import type { SlashCommand } from '../../src/commands/types.ts';
import { handleInteraction } from '../../src/bot/interactionHandler.ts';

function makeSilentLogger() {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk) => chunks.push(chunk.toString()));
  return {
    logger: createLogger('error', stream),
    getLogs: () => chunks.join(''),
  };
}

interface FakeVoiceMember {
  id: string;
  user: { bot: boolean };
}

function makeVoiceChannel(options: {
  id: string;
  humanCount?: number;
  includeBot?: boolean;
}) {
  const members = new Map<string, FakeVoiceMember>();
  const humanCount = options.humanCount ?? 1;
  for (let i = 1; i <= humanCount; i += 1) {
    members.set(`user-${i}`, { id: `user-${i}`, user: { bot: false } });
  }
  if (options.includeBot ?? true) {
    members.set('bot-1', { id: 'bot-1', user: { bot: true } });
  }
  return {
    id: options.id,
    members,
  };
}

function makeCommandInteraction(options: {
  commandName?: string;
  guildId?: string | null;
  deferred?: boolean;
  replied?: boolean;
} = {}) {
  const replies: Array<Record<string, unknown>> = [];
  const followUps: Array<Record<string, unknown>> = [];
  let deferred = options.deferred ?? false;
  let replied = options.replied ?? false;

  const interaction = {
    commandName: options.commandName ?? 'play',
    guildId: options.guildId === undefined ? 'g1' : options.guildId,
    user: { id: 'user-1', tag: 'User#0001' },
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    isChatInputCommand: () => true,
    isButton: () => false,
    reply: async (payload: Record<string, unknown>) => {
      replied = true;
      replies.push(payload);
    },
    followUp: async (payload: Record<string, unknown>) => {
      replied = true;
      followUps.push(payload);
    },
    deferReply: async () => {
      deferred = true;
    },
  } as unknown as ChatInputCommandInteraction;

  return { interaction, replies, followUps };
}

function makeButtonInteraction(options: {
  customId: string;
  guildId?: string | null;
  channelId?: string;
  userId?: string;
  memberVoiceChannel?: ReturnType<typeof makeVoiceChannel> | null;
  botVoiceChannel?: ReturnType<typeof makeVoiceChannel> | null;
  memberRoleIds?: string[];
  memberPerms?: bigint[];
  messageEditError?: unknown;
  callOrder?: string[];
}) {
  const replies: Array<Record<string, unknown>> = [];
  const deferReplies: Array<Record<string, unknown>> = [];
  const editReplies: Array<Record<string, unknown>> = [];
  const followUps: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const messageEdits: Array<Record<string, unknown>> = [];
  let replied = false;
  let deferred = false;

  const guildId = options.guildId === undefined ? 'g1' : options.guildId;
  const memberPerms = new PermissionsBitField(options.memberPerms ?? []);
  const roleCache = new Map((options.memberRoleIds ?? []).map((id) => [id, { id }]));

  const channelsCache = new Map<string, ReturnType<typeof makeVoiceChannel>>();
  if (options.memberVoiceChannel) {
    channelsCache.set(options.memberVoiceChannel.id, options.memberVoiceChannel);
  }
  if (options.botVoiceChannel) {
    channelsCache.set(options.botVoiceChannel.id, options.botVoiceChannel);
  }

  const member = {
    id: options.userId ?? 'user-1',
    user: { id: options.userId ?? 'user-1', bot: false },
    permissions: memberPerms,
    roles: { cache: roleCache },
    voice: {
      channelId: options.memberVoiceChannel?.id ?? null,
      channel: options.memberVoiceChannel ?? null,
    },
  };

  const botMember = {
    id: 'bot-1',
    user: { id: 'bot-1', bot: true },
    voice: {
      channelId: options.botVoiceChannel?.id ?? null,
      channel: options.botVoiceChannel ?? null,
    },
  };

  const message = {
    id: 'panel-msg-1',
    channelId: options.channelId ?? 'tc-1',
    components: [buildControlButtons({ paused: false, repeatMode: 'off' })],
    edit: async (payload: Record<string, unknown>) => {
      options.callOrder?.push('message.edit');
      if (options.messageEditError) {
        throw options.messageEditError;
      }
      messageEdits.push(payload);
      return message;
    },
  };

  const guild = guildId
    ? {
        id: guildId,
        channels: { cache: channelsCache },
        members: {
          me: botMember,
          cache: new Map([[member.id, member]]),
        },
      }
    : null;

  const interaction = {
    customId: options.customId,
    guildId,
    channelId: options.channelId ?? 'tc-1',
    guild,
    member: guild ? member : null,
    memberPermissions: memberPerms,
    user: { id: options.userId ?? 'user-1', tag: 'User#0001' },
    message,
    get replied() {
      return replied;
    },
    get deferred() {
      return deferred;
    },
    inGuild: () => Boolean(guildId && guild),
    isChatInputCommand: () => false,
    isButton: () => true,
    deferReply: async (payload: Record<string, unknown> = {}) => {
      options.callOrder?.push('deferReply');
      deferred = true;
      deferReplies.push(payload);
    },
    editReply: async (payload: Record<string, unknown>) => {
      options.callOrder?.push('editReply');
      replied = true;
      editReplies.push(payload);
    },
    reply: async (payload: Record<string, unknown>) => {
      options.callOrder?.push('reply');
      replied = true;
      replies.push(payload);
    },
    followUp: async (payload: Record<string, unknown>) => {
      options.callOrder?.push('followUp');
      replied = true;
      followUps.push(payload);
    },
    update: async (payload: Record<string, unknown>) => {
      options.callOrder?.push('update');
      replied = true;
      updates.push(payload);
    },
  } as unknown as ButtonInteraction;

  return {
    interaction,
    replies,
    deferReplies,
    editReplies,
    followUps,
    updates,
    messageEdits,
  };
}

function makeSnapshot(overrides: Partial<NowPlayingSnapshot> = {}): NowPlayingSnapshot {
  return {
    track: {
      title: 'Evidências',
      author: 'Chitãozinho & Xororó',
      uri: 'https://www.youtube.com/watch?v=123',
      artworkUrl: null,
      durationMs: 240_000,
      positionMs: 30_000,
      isStream: false,
      requesterId: 'user-1',
      requesterTag: 'User#0001',
    },
    paused: false,
    volume: 80,
    repeatMode: 'off',
    queueLength: 2,
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    ...overrides,
  };
}

function makeMusicServiceMock(overrides: Partial<MusicService> = {}): MusicService {
  const mock: Partial<MusicService> = {
    togglePause: async () => ({ ok: true, paused: true, message: 'Reprodução pausada.' }),
    skip: async () => ({
      ok: true,
      skippedTitle: 'Track 1',
      endedQueue: false,
      message: 'Música pulada: **Track 1**.',
    }),
    cycleLoop: async () => ({
      ok: true,
      repeatMode: 'track',
      message: 'Modo de repetição: **Música**.',
    }),
    shuffle: async () => ({
      ok: true,
      queueLength: 3,
      message: 'Fila embaralhada com sucesso!',
    }),
    stop: async () => ({
      ok: true,
      disconnected: true,
      message: 'Reprodução parada, fila limpa e desconectado do canal de voz.',
    }),
    adjustVolume: async (_guildId, delta) => ({
      ok: true,
      volume: Math.max(0, Math.min(150, 80 + delta)),
      message: `Volume ajustado para **${80 + delta}%**.`,
    }),
    toggleMute: async () => ({
      ok: true,
      volume: 0,
      muted: true,
      message: 'Áudio mutado (**0%**).',
    }),
    getNowPlaying: () => makeSnapshot(),
    getQueue: () => ({
      currentTrack: {
        title: 'Evidências',
        author: 'Chitãozinho & Xororó',
        uri: 'https://www.youtube.com/watch?v=123',
        durationMs: 240_000,
        isStream: false,
        requesterId: 'user-1',
        requesterTag: 'User#0001',
      },
      currentPositionMs: 30_000,
      queue: [],
      repeatMode: 'off',
      paused: false,
      volume: 80,
    }),
    ...overrides,
  };
  return mock as MusicService;
}

test('handleInteraction dispatches chat input commands and catches unexpected throws safely', async () => {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  const { logger, getLogs } = makeSilentLogger();
  const musicService = makeMusicServiceMock();

  const executed: string[] = [];
  const customCommands = new Map<string, SlashCommand>([
    [
      'ok-cmd',
      {
        data: { name: 'ok-cmd' } as SlashCommand['data'],
        execute: async (interaction) => {
          executed.push(interaction.commandName);
          await interaction.reply({ content: 'Tudo certo!' });
        },
      },
    ],
    [
      'boom-cmd',
      {
        data: { name: 'boom-cmd' } as SlashCommand['data'],
        execute: async () => {
          throw new Error('Falha simulada');
        },
      },
    ],
    [
      'boom-deferred',
      {
        data: { name: 'boom-deferred' } as SlashCommand['data'],
        execute: async (interaction) => {
          await interaction.deferReply();
          throw new Error('Falha após defer');
        },
      },
    ],
  ]);

  const ok = makeCommandInteraction({ commandName: 'ok-cmd' });
  await handleInteraction(ok.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
    commands: customCommands,
  });
  assert.deepEqual(executed, ['ok-cmd']);
  assert.equal(ok.replies.length, 1);

  const boom = makeCommandInteraction({ commandName: 'boom-cmd' });
  await handleInteraction(boom.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
    commands: customCommands,
  });
  assert.equal(boom.replies.length, 1);
  assert.equal(boom.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(String(boom.replies[0].content), /erro inesperado/i);

  const boomDeferred = makeCommandInteraction({ commandName: 'boom-deferred' });
  await handleInteraction(boomDeferred.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
    commands: customCommands,
  });
  assert.equal(boomDeferred.replies.length, 0);
  assert.equal(boomDeferred.followUps.length, 1);
  assert.equal(boomDeferred.followUps[0].flags, MessageFlags.Ephemeral);
  assert.match(String(boomDeferred.followUps[0].content), /erro inesperado/i);

  const unknown = makeCommandInteraction({ commandName: 'nao-existe' });
  await handleInteraction(unknown.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
    commands: customCommands,
  });
  assert.equal(unknown.replies.length, 1);
  assert.equal(unknown.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(getLogs(), /Falha simulada/);

  db.close();
});

test('handleInteraction ignores queue pagination and queue action buttons left to /queue collector', async () => {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  const { logger } = makeSilentLogger();
  const musicService = makeMusicServiceMock();

  for (const customId of [`${QUEUE_BUTTON_PREFIX}2`, QUEUE_ACTION_IDS.shuffle, `${QUEUE_ACTION_PREFIX}custom`]) {
    const { interaction, replies, updates, messageEdits } = makeButtonInteraction({
      customId,
      memberVoiceChannel: null,
    });

    await handleInteraction(interaction as unknown as Interaction, {
      musicService,
      settingsRepo,
      logger,
    });

    assert.equal(replies.length, 0);
    assert.equal(updates.length, 0);
    assert.equal(messageEdits.length, 0);
  }
  db.close();
});

test('handleInteraction handles all 5 music:* panel buttons when authorized in the same voice channel', async () => {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  const { logger } = makeSilentLogger();

  const calls: string[] = [];
  let paused = false;
  let repeatMode: 'off' | 'track' | 'queue' = 'off';

  const musicService = makeMusicServiceMock({
    togglePause: async (guildId) => {
      calls.push(`toggle:${guildId}`);
      paused = !paused;
      return { ok: true, paused, message: paused ? 'Reprodução pausada.' : 'Reprodução retomada.' };
    },
    skip: async (guildId, amount) => {
      calls.push(`skip:${guildId}:${amount}`);
      return { ok: true, skippedTitle: 'Faixa 1', endedQueue: false, message: 'Música pulada.' };
    },
    cycleLoop: async (guildId) => {
      calls.push(`loop:${guildId}`);
      repeatMode = 'track';
      return { ok: true, repeatMode, message: 'Modo de repetição: **Música**.' };
    },
    shuffle: async (guildId) => {
      calls.push(`shuffle:${guildId}`);
      return { ok: true, queueLength: 2, message: 'Fila embaralhada com sucesso!' };
    },
    stop: async (guildId) => {
      calls.push(`stop:${guildId}`);
      return { ok: true, disconnected: true, message: 'Reprodução parada.' };
    },
    getNowPlaying: () => makeSnapshot({ paused, repeatMode }),
  });

  const vc = makeVoiceChannel({ id: 'vc-1', humanCount: 1 });

  const toggle = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.toggle,
    memberVoiceChannel: vc,
    botVoiceChannel: vc,
  });
  await handleInteraction(toggle.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(toggle.updates.length, 1);
  const toggleRow = (toggle.updates[0].components as Array<{ toJSON(): { components: Array<{ label: string }> } }>)[0].toJSON();
  assert.equal(toggleRow.components[0].label, 'Retomar');

  const skip = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.skip,
    memberVoiceChannel: vc,
    botVoiceChannel: vc,
  });
  await handleInteraction(skip.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(skip.deferReplies.length, 1);
  assert.equal(skip.deferReplies[0].flags, MessageFlags.Ephemeral);
  assert.equal(skip.editReplies.length, 1);
  assert.match(String(skip.editReplies[0].content), /Música pulada/i);

  const loop = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.loop,
    memberVoiceChannel: vc,
    botVoiceChannel: vc,
  });
  await handleInteraction(loop.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(loop.updates.length, 1);
  const loopRow = (loop.updates[0].components as Array<{ toJSON(): { components: Array<{ label: string }> } }>)[0].toJSON();
  assert.equal(loopRow.components[2].label, 'Loop: Música');

  const shuffle = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.shuffle,
    memberVoiceChannel: vc,
    botVoiceChannel: vc,
  });
  await handleInteraction(shuffle.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(shuffle.deferReplies.length, 1);
  assert.equal(shuffle.deferReplies[0].flags, MessageFlags.Ephemeral);
  assert.equal(shuffle.editReplies.length, 1);
  assert.match(String(shuffle.editReplies[0].content), /Fila embaralhada/i);

  const stopCallOrder: string[] = [];
  const stopMusicService = makeMusicServiceMock({
    stop: async (guildId) => {
      stopCallOrder.push('musicService.stop');
      calls.push(`stop:${guildId}`);
      return { ok: true, disconnected: true, message: 'Reprodução parada.' };
    },
    getNowPlaying: () => makeSnapshot({ paused, repeatMode }),
  });

  const stop = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.stop,
    memberVoiceChannel: vc,
    botVoiceChannel: vc,
    callOrder: stopCallOrder,
  });
  await handleInteraction(stop.interaction as unknown as Interaction, {
    musicService: stopMusicService,
    settingsRepo,
    logger,
  });
  assert.equal(stop.deferReplies.length, 1);
  assert.equal(stop.deferReplies[0].flags, MessageFlags.Ephemeral);
  assert.equal(stop.editReplies.length, 1);
  assert.equal(stop.messageEdits.length, 1);
  assert.deepEqual(stopCallOrder, ['deferReply', 'musicService.stop', 'editReply', 'message.edit']);

  assert.deepEqual(calls, ['toggle:g1', 'skip:g1:1', 'loop:g1', 'shuffle:g1', 'stop:g1']);
  db.close();
});

test('handleInteraction enforces same-voice-channel and canControlPlayer on music:* panel buttons', async () => {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  settingsRepo.update('g1', { djRoleId: 'dj-role' });
  const { logger } = makeSilentLogger();

  let serviceCalls = 0;
  const musicService = makeMusicServiceMock({
    skip: async () => {
      serviceCalls += 1;
      return { ok: true, skippedTitle: null, endedQueue: false, message: 'ok' };
    },
  });

  // 1) User not in voice channel
  const botVc = makeVoiceChannel({ id: 'vc-bot', humanCount: 2 });
  const notInVoice = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.skip,
    memberVoiceChannel: null,
    botVoiceChannel: botVc,
  });
  await handleInteraction(notInVoice.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(notInVoice.replies.length, 1);
  assert.equal(notInVoice.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(String(notInVoice.replies[0].content), /canal de voz/i);

  // 2) User in different voice channel than bot
  const otherVc = makeVoiceChannel({ id: 'vc-other', humanCount: 1, includeBot: false });
  const diffVoice = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.skip,
    memberVoiceChannel: otherVc,
    botVoiceChannel: botVc,
  });
  await handleInteraction(diffVoice.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(diffVoice.replies.length, 1);
  assert.equal(diffVoice.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(String(diffVoice.replies[0].content), /mesmo canal de voz/i);

  // 3) User in same channel, >1 humans, no DJ role and not admin
  const denied = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.skip,
    memberVoiceChannel: botVc,
    botVoiceChannel: botVc,
    memberRoleIds: [],
    memberPerms: [],
  });
  await handleInteraction(denied.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(denied.replies.length, 1);
  assert.equal(denied.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(String(denied.replies[0].content), /dj/i);
  assert.equal(serviceCalls, 0);

  // 4) User with DJ role in same channel succeeds
  const allowedDj = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.skip,
    memberVoiceChannel: botVc,
    botVoiceChannel: botVc,
    memberRoleIds: ['dj-role'],
  });
  await handleInteraction(allowedDj.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(serviceCalls, 1);

  // 5) Lone human in bot voice channel succeeds without DJ role
  const loneVc = makeVoiceChannel({ id: 'vc-bot', humanCount: 1 });
  const allowedLone = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.skip,
    memberVoiceChannel: loneVc,
    botVoiceChannel: loneVc,
    memberRoleIds: [],
  });
  await handleInteraction(allowedLone.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(serviceCalls, 2);

  // 6) Admin / ManageGuild permission succeeds
  const allowedAdmin = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.skip,
    memberVoiceChannel: botVc,
    botVoiceChannel: botVc,
    memberRoleIds: [],
    memberPerms: [PermissionFlagsBits.ManageGuild],
  });
  await handleInteraction(allowedAdmin.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(serviceCalls, 3);

  db.close();
});

test('Review Focus #5: stale music:* panel buttons when no player is active reply ephemerally in pt-BR and disable buttons cleanly regardless of user voice state', async () => {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  settingsRepo.update('g1', { djRoleId: 'dj-role' });
  const { logger } = makeSilentLogger();

  const noPlayerFailure = {
    ok: false as const,
    reason: 'NO_PLAYER' as const,
    message: 'Não há nenhuma reprodução ativa no momento.',
  };
  const noTrackFailure = {
    ok: false as const,
    reason: 'NO_ACTIVE_TRACK' as const,
    message: 'Não há nenhuma música tocando no momento.',
  };

  const musicService = makeMusicServiceMock({
    togglePause: async () => noTrackFailure,
    skip: async () => noTrackFailure,
    cycleLoop: async () => noTrackFailure,
    shuffle: async () => noTrackFailure,
    stop: async () => noPlayerFailure,
    getNowPlaying: () => null,
  });

  // 1) User not in voice and bot out of voice (no active player)
  for (const customId of Object.values(PANEL_BUTTON_IDS)) {
    const { interaction, replies, messageEdits } = makeButtonInteraction({
      customId,
      memberVoiceChannel: null,
      botVoiceChannel: null,
    });

    await handleInteraction(interaction as unknown as Interaction, {
      musicService,
      settingsRepo,
      logger,
    });

    assert.equal(replies.length, 1, `Expected ephemeral reply for ${customId} with memberVoiceChannel=null`);
    assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    assert.match(String(replies[0].content), /Não há nenhuma reprodução ativa/i);

    assert.equal(messageEdits.length, 1, `Expected message buttons disabled for ${customId}`);
    const editedRow = (messageEdits[0].components as Array<{ toJSON(): { components: Array<{ disabled: boolean }> } }>)[0].toJSON();
    assert.equal(editedRow.components.every((btn) => btn.disabled === true), true);
  }

  // 2) Non-DJ user in a populated voice channel when bot is out of voice and idle
  const populatedVc = makeVoiceChannel({ id: 'vc-1', humanCount: 3, includeBot: false });
  const nonDjStale = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.skip,
    memberVoiceChannel: populatedVc,
    botVoiceChannel: null,
    memberRoleIds: [],
    memberPerms: [],
  });
  await handleInteraction(nonDjStale.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(nonDjStale.replies.length, 1);
  assert.equal(nonDjStale.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(String(nonDjStale.replies[0].content), /Não há nenhuma reprodução ativa/i);
  assert.equal(nonDjStale.messageEdits.length, 1);

  // 3) Also swallows Discord 10008 Unknown Message cleanly without throwing
  const unknownMsgErr = Object.assign(new Error('Unknown Message'), { code: 10008 });
  const staleDeleted = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.toggle,
    memberVoiceChannel: null,
    botVoiceChannel: null,
    messageEditError: unknownMsgErr,
  });

  await assert.doesNotReject(async () => {
    await handleInteraction(staleDeleted.interaction as unknown as Interaction, {
      musicService,
      settingsRepo,
      logger,
    });
  });
  assert.equal(staleDeleted.replies.length, 1);
  assert.equal(staleDeleted.replies[0].flags, MessageFlags.Ephemeral);

  db.close();
});

test('handleInteraction handles music:vol_down, music:vol_up, music:mute, and music:queue panel buttons', async () => {
  const db = openDatabase(':memory:');
  const settingsRepo = new GuildSettingsRepository(db);
  settingsRepo.update('g1', { djRoleId: 'dj-role' });
  const { logger } = makeSilentLogger();

  let volume = 80;
  let muted = false;
  const calls: string[] = [];

  const musicService = makeMusicServiceMock({
    adjustVolume: async (guildId, delta) => {
      calls.push(`adjust:${guildId}:${delta}`);
      volume = Math.max(0, Math.min(150, volume + delta));
      muted = volume === 0;
      return { ok: true, volume, muted, message: `Volume ajustado para **${volume}%**.` };
    },
    toggleMute: async (guildId) => {
      calls.push(`mute:${guildId}`);
      if (volume > 0) {
        volume = 0;
        muted = true;
      } else {
        volume = 70;
        muted = false;
      }
      return { ok: true, volume, muted, message: 'Mudo alternado.' };
    },
    getNowPlaying: () => makeSnapshot({ volume }),
  });

  const vc = makeVoiceChannel({ id: 'vc-1', humanCount: 1 });

  // Volume -10%
  const volDown = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.volumeDown,
    memberVoiceChannel: vc,
    botVoiceChannel: vc,
  });
  await handleInteraction(volDown.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(volDown.updates.length, 1);
  const downComponents = volDown.updates[0].components as Array<{
    toJSON: () => { components: Array<{ label?: string }> };
  }>;
  assert.equal(downComponents.length, 2);

  // Volume +10%
  const volUp = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.volumeUp,
    memberVoiceChannel: vc,
    botVoiceChannel: vc,
  });
  await handleInteraction(volUp.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(volUp.updates.length, 1);

  // Mute toggle
  const mute = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.mute,
    memberVoiceChannel: vc,
    botVoiceChannel: vc,
  });
  await handleInteraction(mute.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(mute.updates.length, 1);
  const muteRow2 = (
    mute.updates[0].components as Array<{
      toJSON: () => { components: Array<{ label?: string }> };
    }>
  )[1].toJSON();
  assert.equal(muteRow2.components[1].label, '🔊 Desmutar');

  // music:queue allows viewing ephemerally WITHOUT voice membership or DJ role
  const populatedBotVc = makeVoiceChannel({ id: 'vc-1', humanCount: 3 });
  const viewQueue = makeButtonInteraction({
    customId: PANEL_BUTTON_IDS.queue,
    memberVoiceChannel: null,
    botVoiceChannel: populatedBotVc,
    memberRoleIds: [],
    memberPerms: [],
  });
  await handleInteraction(viewQueue.interaction as unknown as Interaction, {
    musicService,
    settingsRepo,
    logger,
  });
  assert.equal(viewQueue.replies.length, 1);
  assert.equal(viewQueue.replies[0].flags, MessageFlags.Ephemeral);
  assert.ok(Array.isArray(viewQueue.replies[0].embeds) && viewQueue.replies[0].embeds.length === 1);

  assert.deepEqual(calls, ['adjust:g1:-10', 'adjust:g1:10', 'mute:g1']);
  db.close();
});
