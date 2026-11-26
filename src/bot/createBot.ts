import type { DatabaseSync } from 'node:sqlite';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { LavalinkManager } from 'lavalink-client';
import type { EnvConfig } from '../config/env.js';
import { openDatabase } from '../db/database.js';
import { GuildSettingsRepository } from '../db/guildSettingsRepository.js';
import { SessionStoreRepository } from '../db/sessionStoreRepository.js';
import { SqliteQueueStore } from '../db/sqliteQueueStore.js';
import { MusicService, type GuildMessenger } from '../music/musicService.js';
import {
  buildNowPlayingEmbed,
  buildPanelComponents,
  type EditablePanelMessage,
  type PanelMessageRef,
} from '../music/playerPanel.js';
import { createLogger, type AppLogger } from '../utils/logger.js';
import { createLavalinkManager } from './createLavalinkManager.js';
import { handleInteraction } from './interactionHandler.js';
import { handleVoiceStateUpdate } from './voiceStateHandler.js';

export interface CreateBotOptions {
  logger?: AppLogger;
  db?: DatabaseSync;
}

export interface BotRuntime {
  client: Client;
  lavalink: LavalinkManager;
  musicService: MusicService;
  settingsRepo: GuildSettingsRepository;
  sessionStore: SessionStoreRepository;
  queueStore: SqliteQueueStore;
  db: DatabaseSync;
  start(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}

interface SendableTextChannel {
  send(options: Record<string, unknown>): Promise<{ id: string; channelId: string }>;
  messages?: {
    fetch(messageId: string): Promise<unknown>;
  };
}

async function resolveSendableChannel(
  client: Client,
  channelId: string,
): Promise<SendableTextChannel | null> {
  const channel =
    client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    return null;
  }
  return channel as unknown as SendableTextChannel;
}

function createDiscordGuildMessenger(client: Client): GuildMessenger {
  return {
    async sendMessage(channelId, content) {
      const channel = await resolveSendableChannel(client, channelId);
      if (!channel) {
        return;
      }
      await channel.send({ content });
    },

    async sendNowPlayingPanel(channelId, payload): Promise<PanelMessageRef | null> {
      const channel = await resolveSendableChannel(client, channelId);
      if (!channel) {
        return null;
      }

      const embed = buildNowPlayingEmbed({
        track: payload.track,
        paused: payload.paused,
        volume: payload.volume,
        repeatMode: payload.repeatMode,
        queueLength: payload.queueLength,
      });
      const components = buildPanelComponents({
        paused: payload.paused,
        repeatMode: payload.repeatMode,
        volume: payload.volume,
      });

      const sent = await channel.send({
        embeds: [embed],
        components,
      });

      return {
        channelId: sent.channelId,
        messageId: sent.id,
      };
    },

    async fetchPanelMessage(ref): Promise<EditablePanelMessage | null | undefined> {
      const channel =
        client.channels.cache.get(ref.channelId) ?? (await client.channels.fetch(ref.channelId));
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return null;
      }
      const message = await channel.messages.fetch(ref.messageId);
      return message as unknown as EditablePanelMessage;
    },
  };
}

/**
 * Assembles the Discord client, SQLite repositories, Lavalink manager, `MusicService`,
 * and event listeners with graceful short-restart shutdown semantics.
 */
export function createBot(env: EnvConfig, options: CreateBotOptions = {}): BotRuntime {
  const logger = options.logger ?? createLogger(env.LOG_LEVEL);
  const db = options.db ?? openDatabase(env.DATABASE_PATH);
  const settingsRepo = new GuildSettingsRepository(db);
  const sessionStore = new SessionStoreRepository(db);
  const queueStore = new SqliteQueueStore(db);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const messenger = createDiscordGuildMessenger(client);
  const { lavalink, gateway, bindEvents } = createLavalinkManager({
    client,
    env,
    queueStore,
    sessionStore,
    logger,
  });

  const musicService = new MusicService({
    gateway,
    messenger,
    settingsRepo,
    sessionStore,
    queueStore,
    logger,
    spotifyEnabled: env.spotifyEnabled,
    maxQueueSize: env.MAX_QUEUE_SIZE,
  });

  bindEvents(musicService);

  client.on(Events.Raw, (packet) => {
    void lavalink
      .sendRawData(packet as Parameters<LavalinkManager['sendRawData']>[0])
      .catch((error) => {
        logger.warn({ err: error }, 'Falha ao encaminhar pacote raw do Discord ao Lavalink');
      });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, {
      musicService,
      settingsRepo,
      logger,
      env,
    });
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    void handleVoiceStateUpdate(oldState, newState, musicService, logger);
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      { tag: readyClient.user.tag, guildCount: readyClient.guilds.cache.size },
      'Bot conectado ao Discord',
    );

    void lavalink
      .init({
        id: readyClient.user.id,
        username: readyClient.user.username,
      })
      .catch((error) => {
        logger.error({ err: error }, 'Falha ao inicializar LavalinkManager');
      });
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, 'Erro no cliente Discord');
  });

  client.on(Events.Warn, (warning) => {
    logger.warn({ warning }, 'Aviso do cliente Discord');
  });

  let shutdownPromise: Promise<void> | null = null;

  async function start(): Promise<void> {
    if (!env.spotifyEnabled) {
      logger.warn(
        'SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET não configurados; links do Spotify estão desabilitados enquanto YouTube e busca por texto permanecem ativos.',
      );
    }

    await client.login(env.DISCORD_TOKEN);
  }

  async function shutdown(reason = 'manual'): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.info({ reason }, 'Iniciando encerramento gracioso do bot...');

      await musicService.shutdownGracefully();

      // Disconnect Lavalink WebSocket locally without destroying players so audio survives <60s restarts.
      for (const node of lavalink.nodeManager.nodes.values()) {
        if (node.connected) {
          node.disconnect(reason);
        }
      }

      try {
        await client.destroy();
      } catch (error) {
        logger.warn({ err: error }, 'Erro ao destruir cliente Discord durante shutdown');
      }

      try {
        db.close();
      } catch (error) {
        logger.warn({ err: error }, 'Erro ao fechar banco SQLite durante shutdown');
      }
    })();

    return shutdownPromise;
  }

  return {
    client,
    lavalink,
    musicService,
    settingsRepo,
    sessionStore,
    queueStore,
    db,
    start,
    shutdown,
  };
}
