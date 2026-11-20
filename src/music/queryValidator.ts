export type QueryClassification =
  | { ok: true; kind: 'youtube_url'; query: string }
  | { ok: true; kind: 'spotify_url'; query: string }
  | { ok: true; kind: 'search'; query: string; source: 'ytmsearch' }
  | { ok: false; reason: 'EMPTY' | 'UNSUPPORTED_URL' | 'SPOTIFY_DISABLED'; message: string };

const YOUTUBE_HOSTNAMES = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const SPOTIFY_HOSTNAMES = new Set(['open.spotify.com']);

const SPOTIFY_URI_PATTERN = /^spotify:(?:track|album|playlist|artist):[A-Za-z0-9_-]+$/i;
const SCHEME_PREFIX_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

const MESSAGES = {
  empty: 'Informe um link do YouTube, do Spotify ou o nome de uma música para buscar.',
  unsupportedUrl:
    'URL não suportada. Envie um link do YouTube ou do Spotify, ou digite o nome da música para buscar.',
  spotifyDisabled:
    'Links do Spotify estão indisponíveis no momento porque a integração com o Spotify não está configurada. Use um link do YouTube ou busque pelo nome da música.',
} as const;

function classifySpotifyInput(query: string, spotifyEnabled: boolean): QueryClassification {
  if (!spotifyEnabled) {
    return { ok: false, reason: 'SPOTIFY_DISABLED', message: MESSAGES.spotifyDisabled };
  }

  return { ok: true, kind: 'spotify_url', query };
}

/**
 * Classifies raw `/play` input into a validated YouTube URL, Spotify URL/URI,
 * `ytmsearch` text query, or a `pt-BR` validation rejection.
 */
export function classifyQuery(rawInput: string, spotifyEnabled: boolean): QueryClassification {
  const query = rawInput.trim();
  if (!query) {
    return { ok: false, reason: 'EMPTY', message: MESSAGES.empty };
  }

  if (SPOTIFY_URI_PATTERN.test(query)) {
    return classifySpotifyInput(query, spotifyEnabled);
  }

  if (SCHEME_PREFIX_PATTERN.test(query)) {
    let parsed: URL;
    try {
      parsed = new URL(query);
    } catch {
      return { ok: false, reason: 'UNSUPPORTED_URL', message: MESSAGES.unsupportedUrl };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'UNSUPPORTED_URL', message: MESSAGES.unsupportedUrl };
    }

    const hostname = parsed.hostname.toLowerCase();
    if (YOUTUBE_HOSTNAMES.has(hostname)) {
      return { ok: true, kind: 'youtube_url', query };
    }

    if (SPOTIFY_HOSTNAMES.has(hostname)) {
      return classifySpotifyInput(query, spotifyEnabled);
    }

    return { ok: false, reason: 'UNSUPPORTED_URL', message: MESSAGES.unsupportedUrl };
  }

  return {
    ok: true,
    kind: 'search',
    query,
    source: 'ytmsearch',
  };
}
