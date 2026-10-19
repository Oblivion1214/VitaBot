FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS dependencias
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM base AS bot
COPY --from=dependencias --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node index.js ./
COPY --chown=node:node commands ./commands
COPY --chown=node:node utils ./utils
COPY --chown=node:node audio ./audio
COPY --chown=node:node config ./config
COPY --chown=node:node docker ./docker
USER node
CMD ["node", "--unhandled-rejections=strict", "docker/iniciar.cjs", "bot"]

FROM bot AS pruebas
COPY --chown=node:node test ./test
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node deploy-commands.js ecosistema.config.cjs ./
USER root
RUN mkdir -p /app/.cache && chown node:node /app/.cache
USER node
CMD ["node", "--test"]

FROM base AS audio
ARG YTDLP_VERSION=2026.8.19
ARG EJS_VERSION=0.8.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
    && python3 -m venv /opt/audio \
    && /opt/audio/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" "yt-dlp-ejs==${EJS_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_PATH=/usr/bin/ffmpeg YTDLP_PATH=/opt/audio/bin/yt-dlp
COPY --chown=node:node audio ./audio
COPY --chown=node:node utils/herramientasAudio.js ./utils/herramientasAudio.js
COPY --chown=node:node docker ./docker
USER node
CMD ["node", "--unhandled-rejections=strict", "docker/iniciar.cjs", "audio"]
