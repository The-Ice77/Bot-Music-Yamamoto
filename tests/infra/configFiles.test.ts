import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');
}

test('lavalink/application.yml matches Lavalink v4.2+ and plugin spec invariants', () => {
  const yml = readRepoFile('lavalink/application.yml');

  // Native YouTube source disabled, password read from env without hardcoded fallback
  assert.match(yml, /\byoutube:\s*false\b/);
  assert.match(yml, /password:\s*\$\{LAVALINK_SERVER_PASSWORD\}/);
  assert.equal(yml.includes('youshallnotpass'), false);

  // Required plugins and repository
  assert.ok(yml.includes('dev.lavalink.youtube:youtube-plugin:1.18.2'));
  assert.ok(yml.includes('com.github.topi314.lavasrc:lavasrc-plugin:4.8.3'));
  assert.ok(yml.includes('https://maven.lavalink.dev/releases'));

  // Root-level plugins: block (column 0, outside lavalink:)
  assert.match(yml, /^plugins:\s*$/m);

  // YouTube plugin settings + OAuth/poToken placeholders
  assert.match(yml, /\ballowSearch:\s*true\b/);
  assert.match(yml, /\ballowDirectVideoIds:\s*true\b/);
  assert.match(yml, /\ballowDirectPlaylistIds:\s*true\b/);
  assert.ok(yml.includes('MUSIC'));
  assert.ok(yml.includes('ANDROID_VR'));
  assert.ok(yml.includes('WEB'));
  assert.match(yml, /\boauth:/);
  assert.match(yml, /#\s*pot:/);

  // LavaSrc Spotify configuration
  assert.match(yml, /\bspotify:\s*true\b/);
  assert.ok(yml.includes('ytmsearch:"%ISRC%"'));
  assert.ok(yml.includes('ytmsearch:%QUERY%'));
  assert.ok(yml.includes('ytsearch:%QUERY%'));
  assert.ok(yml.includes('${SPOTIFY_CLIENT_ID:}'));
  assert.ok(yml.includes('${SPOTIFY_CLIENT_SECRET:}'));
  assert.ok(yml.includes('${SPOTIFY_SP_DC:}'));
  assert.match(yml, /countryCode:\s*["']?BR["']?/);
  assert.match(yml, /playlistLoadLimit:\s*6\b/);
  assert.match(yml, /albumLoadLimit:\s*6\b/);
});

test('docker-compose.yml defines secure internal Lavalink and healthy bot dependency', () => {
  const compose = readRepoFile('docker-compose.yml');

  assert.ok(compose.includes('ghcr.io/lavalink-devs/lavalink:4.2-alpine'));
  assert.ok(compose.includes('-Xmx1G'));
  assert.ok(compose.includes('service_healthy'));
  assert.ok(compose.includes('./data:/app/data'));
  assert.ok(compose.includes('lavalink_plugins:/opt/Lavalink/plugins'));
  assert.ok(compose.includes('./lavalink/application.yml:/opt/Lavalink/application.yml:ro'));
  assert.match(compose, /restart:\s*unless-stopped/);

  // Lavalink env mapping and healthcheck
  assert.ok(compose.includes('LAVALINK_SERVER_PASSWORD=${LAVALINK_PASSWORD}'));
  assert.ok(compose.includes('SPOTIFY_CLIENT_ID'));
  assert.ok(compose.includes('SPOTIFY_CLIENT_SECRET'));
  assert.ok(compose.includes('SPOTIFY_SP_DC'));
  assert.ok(
    compose.includes(
      'wget --header="Authorization: $$LAVALINK_SERVER_PASSWORD" -q -O /dev/null http://127.0.0.1:2333/version || exit 1',
    ),
  );
  assert.ok(compose.includes('CMD-SHELL'));

  // Bot service config
  assert.match(compose, /build:\s*\./);
  assert.match(compose, /env_file:\s*\n?\s*-?\s*\.env/);
  assert.ok(compose.includes('process.exit(0)'));

  // Must NOT publish port 2333 or declare ports: on lavalink service
  assert.equal(compose.includes('2333:2333'), false);
  const lavalinkSectionMatch = compose.match(/^\s{2}lavalink:\s*\n([\s\S]*?)^\s{2}bot:/m);
  assert.ok(lavalinkSectionMatch, 'Expected lavalink service section before bot service');
  assert.equal(/^\s{4}ports:/m.test(lavalinkSectionMatch[1]), false);
});

test('Dockerfile uses multi-stage node:24-alpine, non-root user, and ExperimentalWarning suppression', () => {
  const dockerfile = readRepoFile('Dockerfile');

  const alpineMatches = dockerfile.match(/FROM\s+node:24-alpine/g) ?? [];
  assert.ok(alpineMatches.length >= 2, 'Expected multi-stage build with at least two node:24-alpine stages');

  assert.ok(dockerfile.includes('npm ci'));
  assert.ok(dockerfile.includes('npm run build'));
  assert.ok(dockerfile.includes('npm ci --omit=dev'));
  assert.ok(dockerfile.includes('/app/data'));
  assert.ok(dockerfile.includes('node:node'));
  assert.match(dockerfile, /^USER\s+node\s*$/m);
  assert.ok(dockerfile.includes('--disable-warning=ExperimentalWarning'));
  assert.ok(dockerfile.includes('dist/index.js'));

  const chownIndex = dockerfile.indexOf('/app/data');
  const userIndex = dockerfile.search(/^USER\s+node\s*$/m);
  assert.ok(chownIndex !== -1 && userIndex !== -1 && chownIndex < userIndex, '/app/data must be created/owned before switching to USER node');
});

test('.dockerignore excludes local artifacts, secrets, and dependencies', () => {
  const dockerignore = readRepoFile('.dockerignore');

  for (const entry of ['node_modules', '.env', 'data', 'dist', '.git']) {
    assert.ok(dockerignore.includes(entry), `Expected .dockerignore to include ${entry}`);
  }
});

test('.env.example and pt-BR README.md cover all required operational topics and commands', () => {
  const envExample = readRepoFile('.env.example');
  for (const key of [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DEV_GUILD_ID',
    'LAVALINK_HOST',
    'LAVALINK_PORT',
    'LAVALINK_PASSWORD',
    'LAVALINK_SECURE',
    'SPOTIFY_CLIENT_ID',
    'SPOTIFY_CLIENT_SECRET',
    'SPOTIFY_SP_DC',
    'DATABASE_PATH',
    'MAX_QUEUE_SIZE',
    'LOG_LEVEL',
  ]) {
    assert.ok(envExample.includes(`${key}=`), `Expected .env.example to define ${key}`);
  }

  const readme = readRepoFile('README.md');

  // Written in Portuguese (pt-BR)
  assert.match(readme, /Discord Developer Portal/i);
  assert.match(readme, /Spotify for Developers/i);
  assert.match(readme, /Spotify Premium/i);
  assert.match(readme, /2026/);
  assert.match(readme, /Development Mode|Modo de Desenvolvimento/i);

  // Local Windows run (Docker & Java 21 + Node 24)
  assert.match(readme, /Windows/i);
  assert.match(readme, /Docker/i);
  assert.match(readme, /Java 21/i);
  assert.match(readme, /Node(\.js)?\s*24/i);

  // Oracle Cloud Always Free ARM64 deploy, Linux ./data UID 1000 ownership, OAuth/poToken, idle reclamation
  assert.match(readme, /Oracle Cloud Always Free/i);
  assert.match(readme, /ARM64/i);
  assert.ok(readme.includes('mkdir -p data && sudo chown -R 1000:1000 data'));
  assert.match(readme, /UID\s*`?1000`?/i);
  assert.match(readme, /OAuth/i);
  assert.match(readme, /poToken/i);
  assert.match(readme, /ociosidade|idle/i);

  // Command deployment and all 13 slash commands
  assert.ok(readme.includes('npm run deploy-commands'));
  for (const cmd of [
    '/play',
    '/pause',
    '/resume',
    '/skip',
    '/stop',
    '/queue',
    '/nowplaying',
    '/shuffle',
    '/loop',
    '/volume',
    '/remove',
    '/clear',
    '/config',
  ]) {
    assert.ok(readme.includes(cmd), `Expected README.md to document ${cmd}`);
  }
});
