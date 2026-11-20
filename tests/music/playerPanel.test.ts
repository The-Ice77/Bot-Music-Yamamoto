import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_BUTTON_IDS,
  QUEUE_BUTTON_PREFIX,
  PanelTracker,
  buildControlButtons,
  buildNowPlayingEmbed,
  buildQueueEmbed,
  buildQueuePaginationButtons,
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
