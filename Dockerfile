FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
