FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openjdk21-jre-headless wget

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY lavalink /opt/Lavalink
RUN wget -q -O /opt/Lavalink/Lavalink.jar "https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar" \
  && mkdir -p /app/data /opt/Lavalink/logs \
  && chown -R node:node /app /opt/Lavalink

USER node

CMD ["node", "--max-old-space-size=160", "--disable-warning=ExperimentalWarning", "dist/index.js"]
