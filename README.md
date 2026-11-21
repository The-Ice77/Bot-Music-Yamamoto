# Bot de Música Multi-Servidor para Discord (YouTube & Spotify)

Bot de música em **TypeScript + Node.js 24 LTS**, projetado para operar **24 horas por dia** em múltiplos servidores com estabilidade, filas isoladas e áudio desacoplado via **Lavalink v4.2+** (com suporte nativo ao protocolo de voz **DAVE** do Discord).

---

## Principais Recursos

- **YouTube e Spotify integrados:**
  - **YouTube:** links de vídeo, Shorts, playlists/mixes, YouTube Music e busca por texto.
  - **Spotify:** faixas, álbuns, playlists e artistas via **LavaSrc (`4.8.3`)** + Spotify Web API, reproduzidos via YouTube Music / YouTube (por ISRC e busca textual).
- **Painel interativo "Tocando Agora":** botões de Pausar/Retomar, Pular, Loop, Embaralhar e Parar, desabilitando painéis antigos automaticamente.
- **Modo 24/7 completo e saída automática configurável:** configurações persistidas por servidor em SQLite (`node:sqlite` em modo `WAL`).
- **Sobrevivência a reinícios curtos (`< 60s`):** persistência de `sessionId` do Lavalink, filas e painéis ativos para manter o áudio tocando durante atualizações rápidas.
- **Isolamento de falhas e *circuit breaker*:** 3 erros consecutivos de faixa encerram a fila do servidor afetado sem derrubar outros servidores.
- **Pronto para Docker (`linux/amd64` e `linux/arm64`):** ideal para **Oracle Cloud Always Free** (Ampere ARM64) e desenvolvimento local no Windows.

---

## Comandos Slash (`/`)

| Comando | Parâmetros | Descrição |
|---|---|---|
| `/play` | `busca` (texto ou URL) | Toca uma música, álbum ou playlist do YouTube/Spotify, ou busca por nome. |
| `/pause` | — | Pausa a música atual. |
| `/resume` | — | Retoma a música pausada. |
| `/skip` | `quantidade` (opcional, padrão `1`) | Pula a faixa atual ou avança várias posições na fila. |
| `/stop` | — | Para a reprodução e limpa a fila (permanece na call se o Modo 24/7 estiver ativo). |
| `/queue` | `pagina` (opcional, padrão `1`) | Exibe a fila paginada com botões de navegação e duração total estimada. |
| `/nowplaying` | — | Exibe o embed detalhado da faixa atual e um painel de controle atualizado. |
| `/shuffle` | — | Embaralha as próximas músicas da fila. |
| `/loop` | `modo` (`Desativado`, `Música`, `Fila`) | Define o modo de repetição do servidor. |
| `/volume` | `nivel` (`0`–`150`) | Ajusta o volume da reprodução atual. |
| `/remove` | `posicao` (`>= 1`) | Remove uma música específica da fila. |
| `/clear` | — | Remove todas as próximas músicas da fila mantendo a faixa atual tocando. |
| `/config` | `ver`, `volume`, `dj`, `canal`, `autosaida`, `modo247` | Configura padrão de volume, cargo DJ, canal de texto restrito, tempo de autosaída (`30`–`1800`s) e Modo 24/7 (exige permissão `Gerenciar Servidor`). |

---

## 1. Criar Aplicação e Bot no Discord Developer Portal

1. Acesse o [Discord Developer Portal](https://discord.com/developers/applications) e clique em **New Application**.
2. Na aba **General Information**, copie o **Application ID** (ele será o seu `DISCORD_CLIENT_ID`).
3. Na aba **Bot**:
   - Clique em **Reset Token** e guarde o token gerado com segurança (ele será o seu `DISCORD_TOKEN`).
   - **Intents:** este bot utiliza apenas `Guilds` e `GuildVoiceStates` (Slash Commands + voz). **Não** é necessário ativar a *Privileged Gateway Intent* `Message Content Intent`.
4. Na aba **OAuth2 → URL Generator**, gere o link de convite do bot:
   - **Scopes:** marque `bot` e `applications.commands`.
   - **Bot Permissions:** marque `View Channels`, `Send Messages`, `Embed Links`, `Connect`, `Speak` e `Use Voice Activity`.
5. Abra a URL gerada no navegador e adicione o bot ao seu servidor.

---

## 2. Configurar o Spotify (Regra de 2026 — Spotify Premium)

O Spotify não permite streaming direto de áudio para bots do Discord. Por isso, o plugin **LavaSrc** consulta os metadados da faixa/álbum/playlist via **Spotify Web API** e encontra automaticamente o áudio correspondente no YouTube Music / YouTube.

> **Atenção à regra do Spotify Developer Mode (2026):** desde fevereiro/março de 2026, o Spotify exige que o dono da aplicação no **Spotify for Developers** possua uma assinatura **Spotify Premium** ativa até mesmo para o fluxo *Client Credentials*, e limita a conta a **1 Client ID** em *Development Mode* (Modo de Desenvolvimento).

1. Acesse o [Spotify for Developers Dashboard](https://developer.spotify.com/dashboard) com sua conta **Spotify Premium**.
2. Crie um app (ex.: `Discord Music Bot`), marcando a API **Web API**.
3. Nas configurações (**Settings**) do app, copie:
   - **Client ID** → `SPOTIFY_CLIENT_ID`
   - **Client Secret** → `SPOTIFY_CLIENT_SECRET`
4. *(Opcional)* Se quiser resolver playlists algorítmicas/privadas (como *Descobertas da Semana* ou *Mix*), preencha `SPOTIFY_SP_DC` com o valor do cookie `sp_dc` da sessão autenticada do Spotify Web.
5. Caso `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` não sejam informados, o bot ainda sobe normalmente com um aviso no log, mantendo todas as funções do YouTube ativas.

---

## 3. Configurar Variáveis de Ambiente (`.env`)

Crie o arquivo `.env` na raiz do projeto a partir do modelo:

```bash
cp .env.example .env
```

No PowerShell (Windows):

```powershell
Copy-Item .env.example .env
```

Preencha as variáveis:

| Variável | Obrigatória | Descrição / Padrão |
|---|---|---|
| `DISCORD_TOKEN` | Sim | Token do bot obtido no Discord Developer Portal. |
| `DISCORD_CLIENT_ID` | Sim | Application ID do bot no Discord Developer Portal. |
| `DEV_GUILD_ID` | Não | ID de um servidor de testes para registrar comandos instantaneamente durante o desenvolvimento. |
| `LAVALINK_HOST` | Sim | Use `lavalink` dentro do Docker Compose ou `localhost` ao rodar localmente fora do Docker. |
| `LAVALINK_PORT` | Não | Porta do Lavalink (padrão `2333`). |
| `LAVALINK_PASSWORD` | Sim | Senha forte compartilhada entre o bot e o servidor Lavalink (troque o valor de exemplo!). |
| `LAVALINK_SECURE` | Não | `false` em rede local/Docker interna (padrão `false`). |
| `SPOTIFY_CLIENT_ID` | Não | Client ID do app no Spotify for Developers. |
| `SPOTIFY_CLIENT_SECRET` | Não | Client Secret do app no Spotify for Developers. |
| `SPOTIFY_SP_DC` | Não | Cookie `sp_dc` opcional para playlists algorítmicas/privadas. |
| `DATABASE_PATH` | Não | Caminho do SQLite (padrão `./data/bot.sqlite`). |
| `MAX_QUEUE_SIZE` | Não | Limite máximo de faixas na fila por servidor (padrão `500`). |
| `LOG_LEVEL` | Não | Nível de log do `pino` (`fatal`, `error`, `warn`, `info`, `debug`, `trace`; padrão `info`). |

---

## 4. Registrar os Comandos Slash (`/`)

Antes de usar os comandos no Discord, publique-os com o script dedicado:

- **Servidor de testes (atualização instantânea):**
  ```bash
  npm run deploy-commands -- --guild SEU_GUILD_ID
  ```
  *(ou defina `DEV_GUILD_ID` no `.env` e execute apenas `npm run deploy-commands`)*

- **Global (todos os servidores — recomendado para produção):**
  ```bash
  npm run deploy-commands -- --global
  ```

---

## 5. Rodar Localmente no Windows

### Opção A: Via Docker Desktop (Recomendado)

1. Instale e inicie o **Docker Desktop** no Windows.
2. No `.env`, garanta `LAVALINK_HOST=lavalink` e uma senha forte em `LAVALINK_PASSWORD`.
3. Crie a pasta `./data` antes de subir os containers (no Docker Engine em Linux ou WSL2 nativo, garanta permissão de escrita ao UID `1000`, que corresponde ao usuário `node` dentro do container para o SQLite gravar em `/app/data/bot.sqlite`):
   ```powershell
   New-Item -ItemType Directory -Force -Path data | Out-Null
   ```
   *(Se estiver rodando em um shell Linux/WSL2: `mkdir -p data && sudo chown -R 1000:1000 data`.)*
4. Suba o Lavalink e o bot com:
   ```powershell
   docker compose up -d --build
   ```
5. Acompanhe os logs:
   ```powershell
   docker compose logs -f
   ```
6. Caso ainda não tenha publicado os comandos Slash, execute dentro do container ou localmente com Node.js 24:
   ```powershell
   docker compose run --rm --no-deps bot node --disable-warning=ExperimentalWarning dist/deployCommands.js
   ```

### Opção B: Sem Docker (Java 21 + Node.js 24)

1. Instale o **Node.js 24 LTS** e o **Java 21** (ex.: Eclipse Temurin JDK 21).
2. Baixe o `Lavalink.jar` (versão **4.2.0 ou superior**) no [GitHub Releases do Lavalink](https://github.com/lavalink-devs/Lavalink/releases) e coloque-o junto com uma cópia de `lavalink/application.yml`.
3. No PowerShell, exporte a senha e as credenciais do Spotify na sessão do Lavalink e inicie o servidor:
   ```powershell
   $env:LAVALINK_SERVER_PASSWORD="sua-senha-forte-aqui"
   $env:SPOTIFY_CLIENT_ID="seu-client-id"
   $env:SPOTIFY_CLIENT_SECRET="seu-client-secret"
   java -Xmx1G -jar Lavalink.jar
   ```
4. No `.env`, ajuste `LAVALINK_HOST=localhost` e `LAVALINK_PASSWORD=sua-senha-forte-aqui`.
5. Em outro terminal na pasta do projeto:
   ```powershell
   npm ci
   npm run deploy-commands
   npm run dev
   ```
   Para rodar compilado em produção local:
   ```powershell
   npm run build
   npm start
   ```

---

## 6. Deploy 24h Gratuito na Oracle Cloud Always Free (Ubuntu ARM64)

### 6.1 Provisionamento da VM e Firewall

1. Crie uma conta na **Oracle Cloud Free Tier** (exige cartão apenas para verificação de identidade; o uso dentro da cota *Always Free* não gera cobrança).
2. Crie uma instância **Compute** com:
   - **Imagem:** Ubuntu (22.04 ou 24.04 LTS)
   - **Shape:** `VM.Standard.A1.Flex` (**ARM64 / Ampere A1**) — ex.: `2 OCPUs` e `12 GB RAM` (o limite Always Free oferece até `4 OCPUs` e `24 GB RAM`).
3. **Firewall e Portas:**
   - Na **VCN → Security Lists** e no firewall do Ubuntu (`ufw` / `iptables`), deixe aberta apenas a porta **22 (SSH)** para administração.
   - **Não abra a porta `2333` para a internet:** no `docker-compose.yml`, o Lavalink não publica portas externas e fica acessível exclusivamente pela rede interna entre os containers `lavalink` e `bot`.

### 6.2 Instalação do Docker e Subida 24h

Conectado na VM via SSH:

```bash
# Instalar Docker Engine e Docker Compose plugin (Ubuntu ARM64)
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker

# Clonar projeto e configurar .env
git clone <URL_DO_SEU_REPOSITORIO> bot-musica
cd bot-musica
cp .env.example .env
nano .env   # preencha DISCORD_TOKEN, DISCORD_CLIENT_ID, LAVALINK_PASSWORD, Spotify etc.

# Criar ./data com dono UID 1000 (usuário `node` do container) para evitar EACCES/SQLITE_CANTOPEN no SQLite
mkdir -p data && sudo chown -R 1000:1000 data

# Subir Lavalink v4.2-alpine + Bot em background
docker compose up -d --build

# Publicar comandos Slash globalmente
docker compose run --rm --no-deps bot node --disable-warning=ExperimentalWarning dist/deployCommands.js --global
```

> **Observação:** como `dist/deployCommands.js` já vai compilado na imagem de produção, o registro funciona diretamente sem instalar dependências de desenvolvimento. Alternativamente, você pode rodar `npm ci && npm run deploy-commands -- --global` em uma máquina com Node.js 24 e o mesmo `.env`.

### 6.3 Atualizações Sem Perder o Banco SQLite

O banco SQLite fica salvo no host em `./data/bot.sqlite` (montado em `/app/data`) e o cache dos plugins do Lavalink no volume `lavalink_plugins`. Para atualizar o bot com segurança:

```bash
git pull
docker compose up -d --build bot
```

Durante reinícios curtos (`< 60s`), o mecanismo de *resuming* do Lavalink e a persistência SQLite preservam as filas e permitem que o áudio continue tocando sem queda brusca.

### 6.4 Mitigação de Bloqueio Anti-Bot do YouTube (`OAuth` / `poToken`)

Se o IP público da nuvem passar a receber erros de autenticação/bloqueio do YouTube (ex.: *"Sign in to confirm you're not a bot"*):

1. Abra `lavalink/application.yml` e localize o bloco `plugins.youtube`.
2. Descomente e configure `oauth` (`refreshToken`) e/ou `pot` (`token` e `visitorData`) seguindo a documentação oficial do [`youtube-plugin`](https://github.com/lavalink-devs/youtube-source).
3. Reinicie apenas o container do Lavalink:
   ```bash
   docker compose restart lavalink
   ```

### 6.5 Cuidados com a Política de Ociosidade (*Idle Reclamation*) da Oracle Cloud

A Oracle Cloud pode recuperar instâncias **Always Free** consideradas ociosas se, durante **7 dias consecutivos**, a utilização do percentil 95 de CPU, rede e memória (para shapes A1) ficar abaixo dos limites mínimos definidos pela Oracle (ex.: CPU e rede abaixo de 20%).

- Acompanhe o consumo no painel da Oracle Cloud e monitore alertas de e-mail da Oracle sobre instâncias ociosas.
- Mantenha logs e *healthchecks* ativos e, caso a VM fique muitos dias sem uso algum de áudio em nenhum servidor, evite dimensionar recursos muito além do necessário (ex.: `1–2 OCPUs` e `6–12 GB RAM` costuma equilibrar bem folga para Lavalink + Node.js sem desperdiçar cota).

---

## 7. Scripts de Desenvolvimento e Verificação

```bash
npm run typecheck       # Verifica tipos TypeScript sem emitir arquivos
npm run build           # Compila src/ para dist/
npm test                # Executa toda a suíte de testes automatizados (node:test)
npm run dev             # Executa o bot em modo desenvolvimento com tsx
npm run deploy-commands # Registra Slash Commands no Discord
```
