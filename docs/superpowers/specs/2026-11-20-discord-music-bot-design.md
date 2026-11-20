# Design Spec: Bot de Música Multi-Servidor para Discord (YouTube & Spotify)

**Data:** 2026-11-20  
**Status:** Pronto para aprovação  
**Escopo:** Fase 1 — Bot de Música 24h (base preparada para a Fase 2 — Site/Painel Web)

> **Convenção deste documento:** Decisões técnicas e de produto que preenchemos além do que você pediu explicitamente estão marcadas com `[Nossa escolha]`, para que você consiga revisar e ajustar qualquer ponto com facilidade antes da implementação.

---

## 1. Intenção e Motivação

Construir um **bot de música multi-servidor para Discord**, projetado para ficar **online 24 horas por dia**, atendendo o usuário, seus amigos e diversos servidores simultaneamente.

O bot deve tocar músicas avulsas, buscas por nome, álbuns e playlists do **YouTube** e do **Spotify** de forma transparente para quem está na call.

### Prioridades do Projeto
1. **Estabilidade acima de tudo:** vários servidores tocando ao mesmo tempo sem engasgos, áudio robótico ou quedas globais.
2. **Hospedagem gratuita 24h viável:** empacotado para rodar em infraestrutura gratuita (com foco em Oracle Cloud Always Free).
3. **Base preparada para a Fase 2:** um futuro site/painel web para gerenciar o bot nos servidores, sem precisar reescrever o núcleo do bot quando o site for construído.

### Divisão em Fases e Fronteira entre Fase 1 e Fase 2
- **Fase 1 (este documento):** Bot de música completo, estável, multi-servidor, com filas isoladas, painel de botões no Discord, retomada de sessão em reinícios curtos, modo 24/7 completo e configurações por servidor persistidas em banco de dados.
  - **Fronteira clara `[Nossa escolha]`:** A Fase 1 **não** expõe nenhum servidor HTTP ou IPC (nem público nem interno). O preparo para a Fase 2 consiste em manter dois módulos internos desacoplados do `discord.js`:
    1. `GuildSettingsRepository` sobre SQLite em modo `WAL`;
    2. `MusicService` / `PlayerController` desacoplado dos objetos de interação do Discord.
- **Fase 2 (projeto/etapa futura, após o bot estar pronto e estável):** Site/painel web (login com Discord OAuth2 + gerenciamento de configurações dos servidores e controles). Quando a Fase 2 for construída, ela poderá ler/gravar diretamente o arquivo `bot.sqlite` (caso rode na mesma VM) e/ou plugar um módulo adaptador HTTP/WebSocket autenticado sobre `MusicService` + `GuildSettingsRepository` sem precisar reescrever o núcleo do bot.

---

## 2. Objetivos, Não-Objetivos e Anti-Objetivos

### Objetivos (Fase 1)
- **Suporte completo a YouTube e Spotify:**
  - YouTube: links de vídeo, YouTube Shorts, playlists/mixes, links do YouTube Music e busca por texto.
  - Spotify: links de faixa (`track`), álbum (`album`), playlist (`playlist`) e artista (`artist`), resolvidos via metadados oficiais (`Client ID` + `Client Secret` com conta Spotify Premium confirmada pelo usuário) e reproduzidos pelo YouTube Music / YouTube.
- **Comandos Slash (`/`) em português (`pt-BR`):** `/play`, `/pause`, `/resume`, `/skip`, `/stop`, `/queue`, `/nowplaying`, `/shuffle`, `/loop`, `/volume`, `/remove`, `/clear` e `/config`.
- **Painel interativo com botões na mensagem "Tocando Agora":** botões de Pausar/Retomar, Pular, Loop, Embaralhar e Parar, atualizando estado visualmente e desabilitando botões de mensagens antigas quando a música muda ou a sessão encerra.
- **Isolamento por servidor:** fila, volume atual, modo de loop, painel ativo e timers completamente independentes por `guildId`.
- **Saída automática e modo 24/7 completo (Opção A):** desconexão automática após tempo configurável de ociosidade ou canal vazio (padrão de 3 minutos), com opção de modo 24/7 completo por servidor (persiste canal de voz, reconecta no boot e mantém o bot na call ao usar `/stop`).
- **Sobrevivência a reinícios curtos (`<60s`) `[Nossa escolha]`:** persistência de `sessionId` do Lavalink, filas e sessões ativas em SQLite para que atualizações ou reinícios rápidos do bot não interrompam o áudio nem percam a fila.
- **Persistência de configurações para a Fase 2:** configurações por servidor armazenadas em SQLite (`guild_settings` em modo `WAL`).
- **Alta estabilidade operacional:** motor de áudio desacoplado em servidor Lavalink v4.2+ (compatível com o protocolo de criptografia DAVE do Discord), reconexão automática, isolamento de erro por faixa e *circuit breaker* contra loops infinitos de erro.
- **Pronto para deploy 24h gratuito:** `Dockerfile` e `docker-compose.yml` multi-arquitetura (`linux/amd64` e `linux/arm64`) focados em Oracle Cloud Always Free + guia completo de configuração e deploy (`README.md` em português).

### Não-Objetivos (Fora do Escopo da Fase 1)
- Site/painel web, servidor HTTP/IPC (público ou interno) e autenticação Discord OAuth2 (pertencem à **Fase 2**).
- Comandos por prefixo de texto (ex.: `!play`) — o bot usará exclusivamente Slash Commands (`/`).
- Autocomplete em tempo real no campo de busca do `/play` — omitido para evitar excesso de requisições e bloqueios (*rate limit*) no YouTube `[Nossa escolha]`.
- Filtros de áudio/equalizador (bassboost, nightcore), letras sincronizadas, *autoplay* por recomendação e outras fontes (SoundCloud, Apple Music, Deezer) — podem ser ativados futuramente sem alterar a arquitetura `[Nossa escolha]`.
- Playlists personalizadas salvas por usuário dentro do banco do bot.
- Sistema de assinaturas, planos pagos ou recursos *premium*.

### Anti-Objetivos (O Que Configura Falha Mesmo Funcionando Localmente)
- Áudio picotando, quedas de voz com código `4017` (falta de suporte ao protocolo DAVE) ou travamento/crash global do bot quando um único servidor envia um link quebrado ou restrito do YouTube.
- Depender de hospedagem paga ou de nós Lavalink públicos instáveis como único caminho de produção.
- Guardar configurações dos servidores apenas em memória, obrigando a refazer o bot ao iniciar o site da Fase 2.
- Versionar segredos (`DISCORD_TOKEN`, `SPOTIFY_CLIENT_SECRET`, `LAVALINK_PASSWORD`, cookies `sp_dc`) no Git ou imprimi-los em logs.

---

## 3. Restrições e Realidades Técnicas

- **Protocolo DAVE do Discord (2026):** O Discord exige criptografia de voz ponta a ponta (DAVE) nos canais de voz; clientes desatualizados são desconectados com código `4017`. O **Lavalink v4.2+** trata o protocolo DAVE nativamente no servidor de áudio, dispensando bibliotecas nativas extras de criptografia no processo Node.js do bot.
- **Como o Spotify funciona e política de 2026:**
  - O Spotify não permite streaming direto de áudio para bots do Discord. O plugin **LavaSrc (`4.8.3`, já atualizado para o endpoint `/playlists/{id}/items`)** consulta metadados via *Spotify Web API* (`SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET`, com suporte opcional a `SPOTIFY_SP_DC` para playlists algorítmicas/privadas) e espelha cada faixa no YouTube Music / YouTube (por ISRC primeiro e busca textual em seguida).
  - **Regra do Spotify Developer Mode (2026):** Desde fev/mar de 2026, o Spotify exige que o dono do app no *Spotify for Developers* possua uma assinatura **Spotify Premium** ativa até para o fluxo *Client Credentials*, e limita a conta a **1 Client ID** em Development Mode. O usuário confirmou possuir assinatura Spotify Premium, viabilizando a integração oficial.
- **Bloqueios anti-bot do YouTube:** A fonte nativa legada do Lavalink foi descontinuada (`sources.youtube: false`). É obrigatório usar o plugin oficial `dev.lavalink.youtube:youtube-plugin:1.18.2` configurado com clientes InnerTube (`MUSIC`, `ANDROID_VR`, `WEB`) e suporte documentado a `OAuth` / `poToken` caso o IP da nuvem receba bloqueio do YouTube.
- **Intents do Discord:** Usando apenas Slash Commands e controle de voz, o bot precisa somente de `GatewayIntentBits.Guilds` e `GatewayIntentBits.GuildVoiceStates`. **Não** requer a *privileged intent* `MessageContent`, evitando bloqueios burocráticos ao crescer para mais de 100 servidores `[Nossa escolha]`.
- **Ambiente local atual vs. Produção:**
  - A máquina atual de desenvolvimento possui `Node.js v24.19.0`, `npm 11.17.0` e `Git 2.55.0`, sem Docker nem Java 21 instalados (apenas Java 8). Por isso, o projeto e o `README.md` suportarão desenvolvimento local tanto via Docker Compose quanto rodando o `Lavalink.jar` com Java 21 diretamente ao lado do Node.js 24.
  - Ambiente de produção gratuito alvo: **Oracle Cloud Always Free** (VM Ubuntu ARM64 Ampere A1 — até 4 OCPUs e 24 GB RAM gratuitos; exige cartão apenas para verificação de identidade, sem cobrança) executando `docker compose up -d`. As imagens `node:24-alpine` e `ghcr.io/lavalink-devs/lavalink:4.2-alpine` (ou `4-alpine` >= 4.2.0) possuem suporte oficial a `linux/arm64` (`musl` + `libdave`/DAVE nativo) e `linux/amd64`.

---

## 4. Abordagens Consideradas

### Abordagem 1 (Escolhida): Bot em TypeScript (`discord.js` v14 + `lavalink-client` v2) + Motor Lavalink v4.2+ + SQLite (`node:sqlite`) + Docker Compose
- **Como funciona:** O processo Node.js/TypeScript atua como plano de controle (Slash Commands, botões, permissões, persistência de filas/sessões e configurações SQLite). Todo o trabalho pesado de rede, extração de streams, tradução Spotify→YouTube e criptografia DAVE ocorre em um servidor separado (**Lavalink v4.2+** com `youtube-plugin` e `lavasrc-plugin`).
- **Trade-offs:** Requer dois serviços em execução (bot + Lavalink) e, para hospedagem 100% gratuita 24h com nó privado confiável, o uso de uma VPS gratuita como a Oracle Cloud Always Free (que pede cartão na verificação de conta). Em contrapartida, oferece estabilidade real para múltiplos servidores simultâneos, isolamento de falhas, retomada de áudio durante reinícios curtos do bot (`<60s` via sessão e fila persistidas em SQLite) e base TypeScript ideal para integrar a Fase 2.

### Abordagem 2 (Descartada): Bot Tudo-em-Um (`discord.js` + `@discordjs/voice` + `discord-player`/FFmpeg/`yt-dlp`)
- **Como funciona:** Um único processo Node.js gerencia comandos, busca faixas, decodifica áudio via FFmpeg e envia pacotes de voz diretamente ao Discord.
- **Trade-offs:** Mais simples de subir em hospedagens simples de bot sem VPS/cartão. Porém, decodificar áudio no mesmo processo Node.js consome muita CPU/RAM quando vários servidores tocam ao mesmo tempo (gerando engasgos), sofre quebras mais frequentes com mudanças do YouTube e derruba todas as calls sempre que o bot reinicia.

**Motivo da escolha:** O usuário priorizou estabilidade 24h para vários servidores simultâneos e escolheu explicitamente a Abordagem 1.

---

## 5. Arquitetura e Comportamento Detalhado

### 5.1 Stack Principal `[Nossa escolha]`
- **Linguagem e Runtime:** TypeScript (strict mode) sobre **Node.js 24 LTS**.
- **Biblioteca Discord:** `discord.js` v14.
- **Cliente Lavalink:** `lavalink-client` v2 (suporte nativo ao protocolo REST/WebSocket do Lavalink v4, `QueueStoreManager` plugável em SQLite, encaminhamento de pacotes de voz via `sendRawData` para handshake DAVE e `resuming` de sessão de 60 segundos).
- **Banco de dados:** **SQLite nativo via `node:sqlite`** (embutido e *unflagged* no Node.js 24 — zero compilação C++ no Windows ou ARM64), configurado em modo `WAL` (`PRAGMA journal_mode = WAL`) para suportar acesso concorrente na Fase 2. Na execução em produção/scripts npm, usa `node --disable-warning=ExperimentalWarning` para manter os logs limpos.
- **Observabilidade:** `pino` para logs estruturados, com redação automática de campos sensíveis (`token`, `password`, `authorization`, `clientSecret`, `spDc`).

### 5.2 Comandos Slash (`/`) e Regras de Uso

Todos os nomes, descrições e respostas ao usuário serão em **português (`pt-BR`)**, utilizando respostas efêmeras (`ephemeral`) para erros de validação/permissão e embeds limpos para confirmações públicas no canal.

| Comando | Parâmetros | Comportamento |
|---|---|---|
| `/play` | `busca` (texto ou URL, obrigatório) | Aceita URL do **YouTube** (vídeo, Shorts, playlist/mix, YT Music), URL do **Spotify** (faixa, álbum, playlist, artista) ou termo de busca textual (padrão `ytmsearch` `[Nossa escolha]`).<br>• URLs de outros domínios não suportados são recusadas com mensagem clara em português `[Nossa escolha]`.<br>• URLs do YouTube contendo vídeo + playlist/mix (`&list=...`) carregam a playlist/mix respeitando o limite máximo de fila (`MAX_QUEUE_SIZE`, padrão `500` `[Nossa escolha]`) `[Nossa escolha]`.<br>• Se o servidor solicitou link do Spotify mas `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` não estiverem configurados no ambiente, responde com aviso amigável informando que o Spotify está indisponível no momento `[Nossa escolha]`.<br>• Conecta na call do usuário (`selfDeaf: true`), aplica `default_volume` do banco ao criar novo player, atualiza `voice_channel_id_247`/`text_channel_id_247` se `always_on_247 = 1` e inicia a reprodução se ocioso. |
| `/pause` | — | Pausa a faixa atual; informa se já estiver pausada. |
| `/resume` | — | Retoma a faixa pausada `[Nossa escolha — além do botão toggle, oferece comando explícito]`. |
| `/skip` | `quantidade` (inteiro `>= 1`, opcional, padrão `1`) | Pula a música atual ou avança `quantidade` posições na fila (se `quantidade` exceder o tamanho da fila, encerra a fila atual com segurança respeitando o comportamento do modo 24/7). |
| `/stop` | — | • Com `always_on_247 = 0`: para a reprodução, limpa a fila, cancela timers pendentes, desconecta da call e desabilita o painel ativo.<br>• Com `always_on_247 = 1` (Opção A): para a reprodução, limpa a fila, cancela timers e desabilita o painel ativo, **permanecendo conectado na call**. |
| `/queue` | `pagina` (inteiro `>= 1`, opcional, padrão `1`) | Mostra a música tocando agora e a fila paginada (`10` faixas por página `[Nossa escolha]`), com duração total estimada, estado do loop e botões `Anterior` / `Próxima` (com timeout do coletor que desabilita os botões ao expirar). |
| `/nowplaying` | — | Exibe embed detalhado da música atual (título, autor/artista, barra de progresso, tempo decorrido/total, solicitante, volume, modo de loop) acompanhado de um painel de botões atualizado. |
| `/shuffle` | — | Embaralha as próximas faixas da fila sem interromper a faixa atual. |
| `/loop` | `modo` (`Desativado` \| `Música` \| `Fila`, obrigatório) | Define o modo de repetição do servidor (`off`, `track`, `queue`). |
| `/volume` | `nivel` (inteiro `0`–`150`, obrigatório) | Ajusta o volume da sessão atual. Teto em `150` para evitar distorção severa `[Nossa escolha]`. |
| `/remove` | `posicao` (inteiro `>= 1`, obrigatório) | Remove a faixa na posição informada (1-indexada relativa às próximas da fila). |
| `/clear` | — | Remove todas as faixas pendentes da fila mantendo a música atual tocando `[Nossa escolha]`. |
| `/config` | Subcomandos (exige permissão `ManageGuild` `[Nossa escolha]`): `ver`, `volume`, `dj`, `canal`, `autosaida`, `modo247` | Visualiza e altera configurações persistentes do servidor no SQLite:<br>• `/config ver`: lista todas as configurações atuais (incluindo canal vinculado ao 24/7, se houver).<br>• `/config volume <1-150>`: define o volume padrão inicial (default `80`).<br>• `/config dj [cargo]`: define o cargo de DJ (ou remove a restrição se omitido).<br>• `/config canal [canal_texto]`: restringe comandos musicais a um canal de texto (ou libera todos se omitido).<br>• `/config autosaida <segundos>`: define espera antes de sair quando ocioso/vazio (`30` a `1800`s; default `180`).<br>• `/config modo247 <ativado>`: ativa/desativa modo 24/7 completo (default `false`). Ao ativar (`true`), exige que o bot já esteja conectado ou que o usuário esteja em um canal de voz (validando `Connect`/`Speak`) para gravar `voice_channel_id_247` e `text_channel_id_247`, conectando o bot na hora se necessário. Ao desativar (`false`), limpa esses campos e inicia `auto_leave_seconds` caso esteja ocioso/sozinho na call. |

### 5.3 Painel Interativo ("Tocando Agora") `[Nossa escolha]`
- Sempre que uma nova faixa começa (`trackStart`) ou quando o usuário chama `/nowplaying`, o bot envia um embed com uma `ActionRow` contendo 5 botões:
  1. **Pausar / Retomar** (rótulo e estilo mudam conforme o estado pausado/tocando).
  2. **Pular**.
  3. **Loop** (cicla entre `off → track → queue`, refletindo o modo atual).
  4. **Embaralhar**.
  5. **Parar** (segue exatamente a mesma regra do `/stop` quanto a sair ou permanecer na call no modo 24/7).
- **Ciclo de vida das mensagens:** o bot armazena `(channelId, messageId)` do painel ativo por `guildId` (em memória e persistido em `active_player_sessions` para sobreviver a reinícios curtos). Quando uma nova faixa começa ou a reprodução encerra, os botões do painel anterior são editados para `disabled: true` (falhas como mensagem apagada por moderadores são tratadas silenciosamente).

### 5.4 Regras de Permissão e Guardrails Multi-Servidor `[Nossa escolha]`
- **Canal de texto restrito:** se `music_channel_id` estiver definido para o servidor, comandos musicais executados fora desse canal recebem resposta efêmera indicando o canal permitido (exceto `/config`, que pode ser usado por administradores em qualquer canal).
- **Validação de canal de voz:**
  - Todos os comandos de reprodução/controle (exceto `/queue`, `/nowplaying` e `/config`) exigem que o membro esteja conectado a um canal de voz.
  - Se o bot já estiver conectado em outro canal de voz do mesmo servidor, recusa o comando e informa em qual canal o bot está ativo.
  - Antes de entrar em um canal de voz, verifica se o bot possui as permissões `ViewChannel`, `Connect` e `Speak` naquele canal, retornando mensagem clara em caso de falta de permissão (em *Stage Channels*, orienta caso falte permissão de fala/orador).
- **Permissão de controle (`canControlPlayer`):** função única compartilhada entre Slash Commands e cliques nos botões do painel:
  - Ações de controle/modificação (`pause`, `resume`, `skip`, `stop`, `shuffle`, `loop`, `volume`, `remove`, `clear`) são permitidas se **pelo menos uma** condição for verdadeira:
    1. Nenhum `dj_role_id` estiver configurado no servidor;
    2. O membro possuir o cargo `dj_role_id`;
    3. O membro possuir permissão `ManageGuild` ou `Administrator`;
    4. O membro for o **único humano** no canal de voz junto com o bot.
  - `/play`, `/queue` e `/nowplaying` são permitidos a qualquer membro presente no mesmo canal de voz (ou qualquer membro do servidor para `/queue` e `/nowplaying`).

### 5.5 Estabilidade, Reconexão, Sobrevivência a Reinícios e Recuperação de Falhas
- **Erro ou travamento de faixa (`trackError` / `trackStuck`):**
  - Registra log estruturado com `guildId`, URL/título da faixa e causa.
  - Notifica o canal de texto da sessão em português e tenta avançar para a próxima música.
  - **Circuit breaker `[Nossa escolha]`:** se `3` faixas falharem consecutivamente sem nenhuma reproduzir com sucesso, o bot interrompe o avanço automático, limpa a fila, informa no canal que houve falhas seguidas na fonte e encerra a reprodução (desconectando se `always_on_247 = 0` ou permanecendo na call se `always_on_247 = 1`) — evitando loop infinito e spam.
- **Fim da fila (`queueEnd`):**
  - Desabilita botões do painel ativo, remove estado de fila pendente e, se `always_on_247 = 0`, agenda timer de saída automática após `auto_leave_seconds` (padrão `180s`). Qualquer novo `/play` cancela imediatamente esse timer. Com `always_on_247 = 1`, o bot permanece conectado na call aguardando novos pedidos.
- **Mudança de estado de voz (`voiceStateUpdate`):**
  - Se todos os usuários humanos saírem do canal de voz onde o bot está:
    - Com `always_on_247 = 0`: inicia timer de saída automática (`auto_leave_seconds`). Se alguém entrar antes do fim do timer, cancela-o.
    - Com `always_on_247 = 1`: pausa a reprodução atual (economizando banda e CPU) até um humano retornar, sem sair da call.
  - **Desconexão manual por moderador `[Nossa escolha]`:** se o bot for desconectado manualmente da call (`oldChannelId` presente e `newChannelId === null` sem que o próprio bot tenha pedido desconexão), destrói o player, cancela timers, desabilita o painel e **limpa `voice_channel_id_247`** para não reconectar à força brigando com o moderador (para reativar, basta usar `/play` ou `/config modo247 true`).
- **Resiliência e sobrevivência a reinícios curtos (`<60s`) `[Nossa escolha]`:**
  - **Ao conectar no Lavalink (`connect`):** salva o `sessionId` na tabela `lavalink_sessions` e executa `node.updateSession({ resuming: true, timeout: 60 })`.
  - **Reconexão automática:** configura `retryAmount` alto e `retryDelay` progressivo; se não houver nó conectado quando um usuário executar `/play`, responde imediatamente com aviso amigável em português ("O servidor de áudio está reconectando, tente novamente em alguns segundos").
  - **Encerramento gracioso (`SIGINT` / `SIGTERM`):** cancela timers locais, fecha cliente Discord e banco SQLite (`db.close()`) **sem chamar `player.destroy()` no Lavalink**, permitindo que o áudio ativo continue tocando durante deploys ou reinícios curtos (`<60s`) do container do bot.
  - **Subida (`boot`):** envia o `sessionId` salvo ao `LavalinkManager`:
    - Se o Lavalink emitir `resumed`: reanexa automaticamente os players ativos, filas persistidas em `lavalink_queues` e referências de `active_player_sessions` (painel/canal/loop).
    - Se a sessão tiver expirado (`>60s`) e o Lavalink criar uma nova sessão: limpa as linhas obsoletas de `lavalink_queues` e `active_player_sessions`.
  - **Reconexão automática 24/7 no boot (Opção A):** após o Discord e o Lavalink estarem prontos, para servidores com `always_on_247 = 1` e `voice_channel_id_247 IS NOT NULL` que **não** foram retomados via `resumed`, o bot reconecta de forma escalonada (*staggered*, ex.: intervalo de `250ms` entre servidores) para evitar picos de rate-limit. Se o servidor/canal não existir mais ou faltarem permissões `ViewChannel`/`Connect`/`Speak`, registra aviso em log e limpa `voice_channel_id_247` sem derrubar a inicialização.
- **Erros globais:** handlers para `unhandledRejection` e `uncaughtException` registram o erro completo via `pino`.

### 5.6 Modelo de Dados SQLite (Pronto para a Fase 2 e Reinícios Curtos) `[Nossa escolha]`
- Arquivo configurável via `DATABASE_PATH` (padrão `./data/bot.sqlite`, montado em volume persistente no Docker).
- Pragmas na inicialização: `PRAGMA journal_mode = WAL;` e `PRAGMA busy_timeout = 5000;`.
- **Tabela de negócio compartilhada com a Fase 2 (`guild_settings`):**
  ```sql
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    default_volume INTEGER NOT NULL DEFAULT 80,
    dj_role_id TEXT NULL,
    music_channel_id TEXT NULL,
    auto_leave_seconds INTEGER NOT NULL DEFAULT 180,
    always_on_247 INTEGER NOT NULL DEFAULT 0,
    voice_channel_id_247 TEXT NULL,
    text_channel_id_247 TEXT NULL,
    updated_at TEXT NOT NULL
  );
  ```
- **Tabelas internas de resiliência de sessão e fila (`Phase 1`):**
  ```sql
  CREATE TABLE IF NOT EXISTS lavalink_sessions (
    node_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lavalink_queues (
    guild_id TEXT PRIMARY KEY,
    queue_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS active_player_sessions (
    guild_id TEXT PRIMARY KEY,
    voice_channel_id TEXT NOT NULL,
    text_channel_id TEXT NOT NULL,
    repeat_mode TEXT NOT NULL DEFAULT 'off',
    panel_channel_id TEXT NULL,
    panel_message_id TEXT NULL,
    updated_at TEXT NOT NULL
  );
  ```
- Acesso encapsulado em repositórios (`GuildSettingsRepository`, `SessionStoreRepository`, `SqliteQueueStore` implementando o `QueueStoreManager` do `lavalink-client` v2), totalmente desacoplados do `discord.js` e com inicialização automática do schema na subida.

### 5.7 Configuração do Lavalink v4.2+ (`lavalink/application.yml`)
- Imagem Docker: `ghcr.io/lavalink-devs/lavalink:4.2-alpine` (DAVE nativo + suporte oficial a `linux/amd64` e `linux/arm64` em `musl`, executando com UID/GID `322`).
- Fonte YouTube nativa desligada: `lavalink.server.sources.youtube: false`.
- Bloco raiz `plugins:` (fora do bloco `lavalink:`):
  - `dev.lavalink.youtube:youtube-plugin:1.18.2` (`https://maven.lavalink.dev/releases`):
    - `enabled: true`, `allowSearch: true`, `allowDirectVideoIds: true`, `allowDirectPlaylistIds: true`.
    - Clientes configurados: `MUSIC`, `ANDROID_VR`, `WEB`.
    - Seção comentada/preparada para `oauth` (`refreshToken`) e `pot` (`token` / `visitorData`) caso o IP da nuvem sofra bloqueio anti-bot do YouTube.
  - `com.github.topi314.lavasrc:lavasrc-plugin:4.8.3` (`https://maven.lavalink.dev/releases`):
    - `sources.spotify: true`.
    - `providers`: `['ytmsearch:"%ISRC%"', 'ytmsearch:%QUERY%', 'ytsearch:%QUERY%']`.
    - `spotify`: `clientId: ${SPOTIFY_CLIENT_ID:}`, `clientSecret: ${SPOTIFY_CLIENT_SECRET:}`, `countryCode: "BR"`, `playlistLoadLimit: 6`, `albumLoadLimit: 6`, com `spDc: ${SPOTIFY_SP_DC:}` opcional.
- Senha do Lavalink lida de `${LAVALINK_SERVER_PASSWORD}` (sem senha padrão fraca em produção).
- **Segurança de rede:** no `docker-compose.yml`, o serviço `lavalink` fica acessível apenas na rede interna entre containers — sem expor a porta `2333` para a internet pública em produção.

### 5.8 Infraestrutura, Variáveis de Ambiente e Operação 24h
- **`docker-compose.yml`:**
  - Serviço `lavalink`: imagem `ghcr.io/lavalink-devs/lavalink:4.2-alpine`, `restart: unless-stopped`, memória `-Xmx1G` configurável, volume nomeado para cache de plugins (`/opt/Lavalink/plugins`, garantindo permissão ao UID `322`) e `application.yml` montado, *healthcheck* consultando `/version` com o header `Authorization`.
  - Serviço `bot`: build via `Dockerfile`, `depends_on: lavalink (condition: service_healthy)`, `restart: unless-stopped`, volume persistente `./data:/app/data` para o SQLite, *healthcheck* de processo.
- **Variáveis de ambiente (`.env.example`):**
  - `DISCORD_TOKEN` (obrigatório)
  - `DISCORD_CLIENT_ID` (obrigatório)
  - `DEV_GUILD_ID` (opcional — permite registrar comandos instantaneamente em um servidor de testes durante o desenvolvimento `[Nossa escolha]`)
  - `LAVALINK_HOST`, `LAVALINK_PORT`, `LAVALINK_PASSWORD`, `LAVALINK_SECURE`
  - `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (necessários para Spotify; se ausentes no boot, o bot sobe com aviso em log mantendo o YouTube ativo `[Nossa escolha]`), `SPOTIFY_SP_DC` (opcional)
  - `DATABASE_PATH` (padrão `./data/bot.sqlite`)
  - `MAX_QUEUE_SIZE` (padrão `500`)
  - `LOG_LEVEL` (padrão `info`)
- **Registro de Slash Commands:** script dedicado (`npm run deploy-commands`), capaz de publicar em um servidor específico (se `DEV_GUILD_ID` estiver definido ou via flag `--guild`) ou globalmente em todos os servidores (`--global` / sem `DEV_GUILD_ID`) `[Nossa escolha]`.
- **Documentação (`README.md` em português):** passo a passo completo cobrindo:
  1. Criar aplicação e bot no Discord Developer Portal + link de convite com permissões corretas (`bot` + `applications.commands`, permissões de voz e texto).
  2. Criar aplicação no Spotify for Developers com conta Spotify Premium (regra de 2026: 1 Client ID em Development Mode) para obter `Client ID` e `Client Secret`.
  3. Rodar localmente no Windows (via Docker Desktop ou via Java 21 + Node.js 24).
  4. Subir 24h gratuitamente na **Oracle Cloud Always Free** (VM Ubuntu ARM64, firewall/portas, instalação do Docker, `docker compose up -d`, atualização sem perder o banco SQLite, mitigação de bloqueio do YouTube com OAuth/poToken e cuidados com a política de ociosidade da Oracle).

---

## 6. O Que Fica a Cargo do Construtor

- Organização interna exata das pastas e módulos dentro de `src/` (ex.: `commands/`, `events/`, `music/`, `db/`, `config/`, `utils/`).
- Configuração de `tsconfig.json`, scripts npm (`dev`, `build`, `start`, `deploy-commands`, `test`) e escolha do runner de testes (ex.: `node:test` nativo do Node 24 ou `vitest`).
- Estilo visual exato dos embeds (paleta de cores, ícones, barra de progresso e redação detalhada das respostas em `pt-BR`).
- Implementação e cobertura dos testes unitários (regras de permissão `canControlPlayer`, repositórios SQLite, *circuit breaker*, gerenciamento de timers, fluxo 24/7 e formatação de fila/duração).
- Otimização do `Dockerfile` em multi-stage build (compilação TypeScript na etapa de build + imagem final enxuta `node:24-alpine` com usuário não-root e `--disable-warning=ExperimentalWarning`).
