import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuery } from '../../src/music/queryValidator.ts';

test('classifyQuery accepts supported YouTube URL formats', () => {
  const youtubeUrls = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtube.com/shorts/abc123xyz',
    'https://music.youtube.com/playlist?list=PL123456',
    'https://m.youtube.com/watch?v=abc&list=RDabc',
    'http://youtube.com/watch?v=abc&list=RDabc',
  ];

  for (const url of youtubeUrls) {
    assert.deepEqual(classifyQuery(url, true), {
      ok: true,
      kind: 'youtube_url',
      query: url,
    });
    assert.deepEqual(classifyQuery(url, false), {
      ok: true,
      kind: 'youtube_url',
      query: url,
    });
  }
});

test('classifyQuery accepts Spotify URLs and URIs when spotifyEnabled is true', () => {
  const spotifyQueries = [
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
    'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    'https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg',
    'https://open.spotify.com/intl-pt/track/4uLU6hMCjMI75M1A2tKUQC',
    'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  ];

  for (const query of spotifyQueries) {
    assert.deepEqual(classifyQuery(query, true), {
      ok: true,
      kind: 'spotify_url',
      query,
    });
  }
});

test('classifyQuery classifies plain text as ytmsearch', () => {
  assert.deepEqual(classifyQuery('evidências chitãozinho', true), {
    ok: true,
    kind: 'search',
    query: 'evidências chitãozinho',
    source: 'ytmsearch',
  });

  assert.deepEqual(classifyQuery('  AC/DC: Back in Black  ', false), {
    ok: true,
    kind: 'search',
    query: 'AC/DC: Back in Black',
    source: 'ytmsearch',
  });
});

test('classifyQuery rejects unsupported URLs with UNSUPPORTED_URL in pt-BR', () => {
  const unsupported = [
    'https://soundcloud.com/x',
    'https://example.com/song.mp3',
    'https://deezer.com/track/123',
    'https://[invalid-url',
  ];

  for (const url of unsupported) {
    const result = classifyQuery(url, true);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'UNSUPPORTED_URL');
      assert.match(result.message, /youtube|spotify|suportad/i);
    }
  }
});

test('classifyQuery rejects Spotify links with SPOTIFY_DISABLED in pt-BR when spotifyEnabled is false', () => {
  const result = classifyQuery('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', false);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'SPOTIFY_DISABLED');
    assert.match(result.message, /spotify/i);
    assert.match(result.message, /indispon[ií]vel|desativad|configurad/i);
  }

  const uriResult = classifyQuery('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', false);
  assert.equal(uriResult.ok, false);
  if (!uriResult.ok) {
    assert.equal(uriResult.reason, 'SPOTIFY_DISABLED');
  }
});

test('classifyQuery rejects blank input with EMPTY', () => {
  for (const blank of ['', '   ', '\t\n  ']) {
    const result = classifyQuery(blank, true);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'EMPTY');
      assert.ok(result.message.length > 0);
    }
  }
});
