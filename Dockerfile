# syntax=docker/dockerfile:1
# One Node server: the site, the API and the background coordinator. Dokploy runs it as a Swarm service
# and updates it start-first, so the new version takes over before the old one stops (docs/DOKPLOY.md).
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/bigint-buffer ./vendor/bigint-buffer
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
# A new id per build: a browser still on the previous version reloads on its next navigation instead of
# mixing old and new code. Pass the commit as DEPLOYMENT_ID if you like; the build time is the fallback.
ARG DEPLOYMENT_ID
RUN BUILD_ID="${DEPLOYMENT_ID:-$(date +%s)}" \
 && VITE_BUILD_ID="$BUILD_ID" npm run build \
 && printf '%s' "$BUILD_ID" > build-id \
 && mv dist/assets static-build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS app
WORKDIR /app
# DATABASE_REQUIRED: no embedded Postgres, whose data an update would wipe.
ENV NODE_ENV=production HOST=0.0.0.0 API_PORT=4100 DATABASE_REQUIRED=true
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
# Source for the npm scripts (`npm run check`) in the container's terminal.
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node deploy ./deploy
COPY --chown=node:node vendor/bigint-buffer ./vendor/bigint-buffer
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/static-build ./static-build
COPY --from=build --chown=node:node /app/build-id ./build-id
# dist/assets is filled at start (deploy/publish-static.mjs); a Dokploy volume there keeps earlier builds' files.
RUN mkdir -p dist/assets reports && chown node:node dist/assets reports
USER node
EXPOSE 4100
# Healthy includes "standby": during an update the new server waits for the old one to hand over the database.
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["sh", "deploy/start.sh"]
