import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle } from 'discord.js';
import {
  PANEL_BUTTON_IDS,
  QUEUE_ACTION_IDS,
  QUEUE_BUTTON_PREFIX,
  PanelTracker,
  buildControlButtons,
  buildNowPlayingEmbed,
  buildPanelComponents,
  buildQueueActionButtons,
  buildQueueEmbed,
  buildQueuePaginationButtons,
  buildVolumeControlButtons,
} from '../../src/music/playerPanel.ts';

test('buildControlButtons renders 5 pt-BR buttons reflecting pause, repeatMode, and disabled state', () => {
  const row = buildControlButtons({ paused: false, repeatMode: 'off' });
  const json = row.toJSON();

  assert.equal(json.components.length, 5);
  assert.deepEqual(
    json.components.map((c) => ('custom_id' in c ? c.custom_id : undefined)),
    [
      PANEL_BUTTON_IDS.toggle,
      PANEL_BUTTON_IDS.skip,
      PANEL_BUTTON_IDS.loop,
      PANEL_BUTTON_IDS.shuffle,
      PANEL_BUTTON_IDS.stop,
    ],
  );
  assert.deepEqual(
    json.components.map((c) => ('label' in c ? c.label : undefined)),
    ['Pausar', 'Pular', 'Loop: Off', 'Embaralhar', 'Parar'],
  );
  assert.equal(
    json.components.every((c) => !c.disabled),
    true,
  );

  const pausedTrackRow = buildControlButtons({ paused: true, repeatMode: 'track' }).toJSON();
  assert.equal('label' in pausedTrackRow.components[0] ? pausedTrackRow.components[0].label : undefined, 'Retomar');
  assert.equal('label' in pausedTrackRow.components[2] ? pausedTrackRow.components[2].label : undefined, 'Loop: Música');

  const disabledQueueRow = buildControlButtons({
    paused: false,
    repeatMode: 'queue',
    disabled: true,
  }).toJSON();
  assert.equal('label' in disabledQueueRow.components[2] ? disabledQueueRow.components[2].label : undefined, 'Loop: Fila');
  assert.equal(
    disabledQueueRow.components.every((c) => c.disabled === true),
    true,
  );
});

test('buildNowPlayingEmbed renders Portuguese fields, progress bar, and live indicator', () => {
  const embed = buildNowPlayingEmbed({
    track: {
      title: 'Evidências',
      author: 'Chitãozinho & Xororó',
      uri: 'https://www.youtube.com/watch?v=abc',
      durationMs: 279_000,
      positionMs: 60_000,
      isStream: false,
      requesterId: 'user-1',
    },
    paused: false,
    volume: 80,
    repeatMode: 'off',
    queueLength: 3,
  }).toJSON();

  assert.match(embed.title ?? '', /Tocando Agora/i);
  assert.match(embed.description ?? '', /Evidências/);
  assert.match(embed.description ?? '', /01:00/);
  assert.match(embed.description ?? '', /04:39/);

  const fieldsText = (embed.fields ?? []).map((f) => `${f.name}:${f.value}`).join('\n');
  assert.match(fieldsText, /80%/);
  assert.match(fieldsText, /<@user-1>/);
  assert.match(fieldsText, /Desativado|Off/i);

  const liveEmbed = buildNowPlayingEmbed({
    track: {
      title: 'Rádio Ao Vivo',
      author: 'Stream',
      durationMs: 0,
      positionMs: 0,
      isStream: true,
    },
    paused: true,
    volume: 100,
    repeatMode: 'track',
  }).toJSON();

  assert.match(liveEmbed.title ?? '', /Pausad[ao]/i);
  assert.match(liveEmbed.description ?? '', /AO VIVO/);
});

test('buildQueueEmbed and buildQueuePaginationButtons format queue pages and navigation buttons in pt-BR', () => {
  const queue = Array.from({ length: 12 }, (_, idx) => ({
    title: `Música ${idx + 1}`,
    author: `Artista ${idx + 1}`,
    durationMs: 120_000,
    isStream: false,
    requesterId: 'u1',
  }));

  const embed = buildQueueEmbed({
    currentTrack: {
      title: 'Música Atual',
      author: 'Artista Atual',
      durationMs: 180_000,
      isStream: false,
      requesterId: 'u1',
    },
    queue,
    page: 2,
    pageSize: 10,
    repeatMode: 'queue',
  }).toJSON();

  assert.match(embed.title ?? '', /Fila/i);
  assert.match(embed.description ?? '', /Música Atual/);
  assert.match(embed.description ?? '', /11\..*Música 11/);
  assert.match(embed.footer?.text ?? '', /Página 2 de 2/);

  const rowPage1 = buildQueuePaginationButtons({ currentPage: 1, totalPages: 2 }).toJSON();
  assert.equal(rowPage1.components.length, 2);
  assert.equal('label' in rowPage1.components[0] ? rowPage1.components[0].label : undefined, 'Anterior');
  assert.equal('label' in rowPage1.components[1] ? rowPage1.components[1].label : undefined, 'Próxima');
  assert.equal(rowPage1.components[0].disabled, true);
  assert.equal(rowPage1.components[1].disabled, false);
  const id0 = 'custom_id' in rowPage1.components[0] ? rowPage1.components[0].custom_id : '';
  const id1 = 'custom_id' in rowPage1.components[1] ? rowPage1.components[1].custom_id : '';
  assert.ok(id0.startsWith(QUEUE_BUTTON_PREFIX));
  assert.ok(id1.startsWith(QUEUE_BUTTON_PREFIX));
  assert.notEqual(id0, id1);

  const rowPage2 = buildQueuePaginationButtons({ currentPage: 2, totalPages: 2 }).toJSON();
  assert.equal(rowPage2.components[0].disabled, false);
  assert.equal(rowPage2.components[1].disabled, true);
});

test('PanelTracker stores refs and disablePanelSafely disables fetched message buttons', async () => {
  const tracker = new PanelTracker();
  tracker.setPanel('g1', { channelId: 'c1', messageId: 'm1' });
  assert.deepEqual(tracker.getPanel('g1'), { channelId: 'c1', messageId: 'm1' });

  let editedComponents: unknown[] = [];
  await tracker.disablePanelSafely('g1', async (ref) => {
    assert.deepEqual(ref, { channelId: 'c1', messageId: 'm1' });
    return {
      components: [buildControlButtons({ paused: false, repeatMode: 'off' })],
      edit: async (payload: { components: Array<{ toJSON: () => { components: Array<{ disabled?: boolean }> } }> }) => {
        editedComponents = payload.components.map((row) => row.toJSON());
      },
    };
  });

  assert.equal(tracker.getPanel('g1'), null);
  assert.equal(editedComponents.length, 1);
  const firstRow = editedComponents[0] as { components: Array<{ disabled?: boolean }> };
  assert.equal(firstRow.components.length, 5);
  assert.equal(
    firstRow.components.every((btn) => btn.disabled === true),
    true,
  );
});

test('PanelTracker.disablePanelSafely swallows Discord Unknown Message (10008) and Missing Access (50001) silently', async () => {
  const tracker = new PanelTracker();

  tracker.setPanel('g-10008', { channelId: 'c1', messageId: 'm-deleted' });
  await assert.doesNotReject(async () => {
    await tracker.disablePanelSafely('g-10008', async () => {
      throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    });
  });
  assert.equal(tracker.getPanel('g-10008'), null);

  tracker.setPanel('g-50001', { channelId: 'c2', messageId: 'm-noaccess' });
  await assert.doesNotReject(async () => {
    await tracker.disablePanelSafely('g-50001', async () => ({
      components: [buildControlButtons({ paused: false, repeatMode: 'off' })],
      edit: async () => {
        throw Object.assign(new Error('Missing Access'), { code: 50001 });
      },
    }));
  });
  assert.equal(tracker.getPanel('g-50001'), null);
});

test('buildNowPlayingEmbed renders live Discord countdown timestamp, paused badge, and volume emoji tiers', () => {
  const baseNowMs = 1_700_000_000_000;
  const playing = buildNowPlayingEmbed({
    track: {
      title: 'Timer Song',
      author: 'Artist',
      durationMs: 240_000,
      positionMs: 60_000,
      isStream: false,
    },
    paused: false,
    volume: 120,
    repeatMode: 'off',
    nowMs: baseNowMs,
  }).toJSON();

  // remaining = 180s -> endsAt = 1_700_000_180
  assert.match(playing.description ?? '', /termina <t:1700000180:R>/);
  const playingVolume = playing.fields?.find((f) => f.name === 'Volume')?.value;
  assert.equal(playingVolume, '🔊 120% (Boost)');

  const paused = buildNowPlayingEmbed({
    track: {
      title: 'Timer Song',
      author: 'Artist',
      durationMs: 240_000,
      positionMs: 60_000,
      isStream: false,
    },
    paused: true,
    volume: 0,
    repeatMode: 'off',
    nowMs: baseNowMs,
  }).toJSON();

  assert.match(paused.description ?? '', /• `Pausada`/);
  assert.doesNotMatch(paused.description ?? '', /<t:/);
  assert.equal(paused.fields?.find((f) => f.name === 'Volume')?.value, '🔇 0% (Mudo)');

  const quiet = buildNowPlayingEmbed({
    track: {
      title: 'Quiet Song',
      author: 'Artist',
      durationMs: 120_000,
      positionMs: 0,
      isStream: false,
    },
    paused: false,
    volume: 30,
    repeatMode: 'off',
  }).toJSON();
  assert.equal(quiet.fields?.find((f) => f.name === 'Volume')?.value, '🔉 30%');
});

test('buildVolumeControlButtons, buildPanelComponents, and buildQueueActionButtons respect bounds and states', () => {
  const mutedRow = buildVolumeControlButtons({ volume: 0 }).toJSON();
  assert.equal(mutedRow.components.length, 4);
  assert.deepEqual(
    mutedRow.components.map((c) => ('custom_id' in c ? c.custom_id : undefined)),
    [
      PANEL_BUTTON_IDS.volumeDown,
      PANEL_BUTTON_IDS.mute,
      PANEL_BUTTON_IDS.volumeUp,
      PANEL_BUTTON_IDS.queue,
    ],
  );
  assert.equal(mutedRow.components[0].disabled, true);
  assert.equal(mutedRow.components[1].disabled, false);
  assert.equal('label' in mutedRow.components[1] ? mutedRow.components[1].label : undefined, '🔊 Desmutar');
  assert.equal(mutedRow.components[1].style, ButtonStyle.Danger);
  assert.equal(mutedRow.components[2].disabled, false);

  const maxRow = buildVolumeControlButtons({ volume: 150 }).toJSON();
  assert.equal(maxRow.components[0].disabled, false);
  assert.equal('label' in maxRow.components[1] ? maxRow.components[1].label : undefined, '🔇 Mudo');
  assert.equal(maxRow.components[1].style, ButtonStyle.Secondary);
  assert.equal(maxRow.components[2].disabled, true);

  const rows = buildPanelComponents({ paused: false, repeatMode: 'off', volume: 80 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].toJSON().components.length, 5);
  assert.equal(rows[1].toJSON().components.length, 4);

  const emptyQueueActions = buildQueueActionButtons({ hasTracks: false }).toJSON();
  assert.deepEqual(
    emptyQueueActions.components.map((c) => ('custom_id' in c ? c.custom_id : undefined)),
    [
      QUEUE_ACTION_IDS.refresh,
      QUEUE_ACTION_IDS.shuffle,
      QUEUE_ACTION_IDS.dedupe,
      QUEUE_ACTION_IDS.clear,
    ],
  );
  assert.equal(emptyQueueActions.components[0].disabled, false);
  assert.equal(emptyQueueActions.components[1].disabled, true);
  assert.equal(emptyQueueActions.components[2].disabled, true);
  assert.equal(emptyQueueActions.components[3].disabled, true);

  const populatedQueue = buildQueueEmbed({
    currentTrack: {
      title: 'Atual',
      author: 'Artista',
      durationMs: 180_000,
      isStream: false,
    },
    currentPositionMs: 65_000,
    queue: [
      {
        title: 'Próxima',
        author: 'Artista 2',
        durationMs: 90_000,
        isStream: false,
        requesterId: 'req-42',
      },
    ],
    page: 1,
    repeatMode: 'off',
  }).toJSON();
  assert.match(populatedQueue.description ?? '', /01:05 \/ 03:00/);
  assert.match(populatedQueue.description ?? '', /<@req-42>/);
});

test('PanelTracker.updatePanelSafely edits active panels, clears on 10008, and preserves on transient errors', async () => {
  const unexpectedErrors: unknown[] = [];
  const tracker = new PanelTracker((err) => unexpectedErrors.push(err));
  tracker.setPanel('g1', { channelId: 'c1', messageId: 'm1' });

  const embed = buildNowPlayingEmbed({
    track: { title: 'T', author: 'A', durationMs: 100_000, positionMs: 10_000, isStream: false },
    paused: false,
    volume: 80,
    repeatMode: 'off',
  });
  const components = buildPanelComponents({ paused: false, repeatMode: 'off', volume: 80 });

  let editCount = 0;
  const ok = await tracker.updatePanelSafely(
    'g1',
    async () => ({
      edit: async () => {
        editCount += 1;
      },
    }),
    { embeds: [embed], components },
  );
  assert.equal(ok, true);
  assert.equal(editCount, 1);
  assert.notEqual(tracker.getPanel('g1'), null);

  // Transient non-ignored error keeps panel registered and reports via callback
  const transientOk = await tracker.updatePanelSafely(
    'g1',
    async () => ({
      edit: async () => {
        throw new Error('502 Bad Gateway');
      },
    }),
    { embeds: [embed], components },
  );
  assert.equal(transientOk, true);
  assert.equal(unexpectedErrors.length, 1);
  assert.notEqual(tracker.getPanel('g1'), null);

  // Unknown Message (10008) cleans ref and returns false
  const deletedOk = await tracker.updatePanelSafely(
    'g1',
    async () => {
      throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    },
    { embeds: [embed], components },
  );
  assert.equal(deletedOk, false);
  assert.equal(tracker.getPanel('g1'), null);
});
