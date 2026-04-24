# syntax=docker/dockerfile:1.7

# ---- builder ---------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --ignore-scripts

COPY shared ./shared
COPY server ./server
COPY client ./client

RUN npm -w shared run build \
 && npm -w server run build \
 && npm -w client run build

# Prune to production deps only in a second install pass into a clean
# directory, so the runtime stage doesn't ship vitest/tsx/vite.
RUN mkdir /out \
 && cp -r shared/dist /out/shared-dist \
 && cp -r server/dist /out/server-dist \
 && cp -r client/dist /out/client-dist \
 && cp shared/package.json /out/shared-package.json \
 && cp server/package.json /out/server-package.json

# ---- runner ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CANVASLIVE_DB=/data/canvaslive.db

RUN useradd --system --uid 10001 --no-create-home canvaslive \
 && mkdir -p /data /app/shared /app/server /app/client \
 && chown -R canvaslive:canvaslive /data /app

COPY --from=builder --chown=canvaslive:canvaslive /out/shared-package.json /app/shared/package.json
COPY --from=builder --chown=canvaslive:canvaslive /out/server-package.json /app/server/package.json
COPY --from=builder --chown=canvaslive:canvaslive /out/shared-dist /app/shared/dist
COPY --from=builder --chown=canvaslive:canvaslive /out/server-dist /app/server/dist
COPY --from=builder --chown=canvaslive:canvaslive /out/client-dist /app/client/dist
COPY --chown=canvaslive:canvaslive package.json /app/package.json

RUN npm install --workspaces --omit=dev --ignore-scripts \
 && npm cache clean --force

USER canvaslive
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/server/dist/index.js"]
