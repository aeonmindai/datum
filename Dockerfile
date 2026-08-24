# syntax=docker/dockerfile:1
#
# Datum — one image, three deploy paths (docker compose, Fly, Railway).
#
# Base is `node:24-slim` (Debian), deliberately NOT alpine: `@node-rs/argon2` ships glibc
# prebuilds, alpine needs musl ones, and a password hasher that silently falls back to a
# slow JS path — or fails to load at boot — is not a trade worth making for 40 MB.
#
# The final stage carries no compiler, no TypeScript, no test files and no source. It holds
# the compiled server, the migrations (they run on boot), the built admin bundle, and
# production node_modules.

# ---- deps: resolve the full workspace tree from the lockfile ---------------------------
FROM node:24-slim AS deps
WORKDIR /app

# Only the manifests, so this layer is reused on every source-only change.
COPY package.json package-lock.json ./
COPY packages/datum/package.json packages/datum/package.json
COPY packages/admin/package.json packages/admin/package.json

RUN npm ci --no-audit --no-fund

# ---- build: admin bundle first, then the server -----------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# node_modules (hoisted at the root by npm workspaces) plus the manifests.
COPY --from=deps /app ./
# Source. `.dockerignore` keeps node_modules, dist/, public/ and the research corpus out,
# so this cannot clobber the installed tree with a stale local one.
COPY . .

# Order matters: the admin build emits into packages/datum/public/admin, which the server
# then serves as a static route. Building the server first would produce an image whose
# /admin is a 404.
RUN npm run build --workspace @aeonmind/datum-admin \
 && npm run build --workspace @aeonmind/datum

# ---- runtime: production deps + build output, nothing else -------------------------------
FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# A second, dev-free install rather than a prune: `npm ci --omit=dev` is the only form that
# is guaranteed to reproduce exactly what the lockfile says for production.
COPY package.json package-lock.json ./
COPY packages/datum/package.json packages/datum/package.json
COPY packages/admin/package.json packages/admin/package.json
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/packages/datum/dist       ./packages/datum/dist
COPY --from=build /app/packages/datum/migrations ./packages/datum/migrations
COPY --from=build /app/packages/datum/public     ./packages/datum/public
# `datum seed --example` is a documented command and a v0 deliverable, so the fixtures have to
# be in the image. Without this the README's "click through a fresh install" path is a lie.
COPY --from=build /app/packages/datum/seeds      ./packages/datum/seeds
COPY LICENSE NOTICE ./

# Apache-2.0, and the image says so.
LABEL org.opencontainers.image.title="datum" \
      org.opencontainers.image.description="Append-only, provenance-enforcing fact store for fleets of agents." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/aeonmind/datum"

# `node` (uid 1000) ships with the base image. The server writes nothing to disk, so the
# whole tree stays root-owned and read-only to the process that runs it.
USER node

# Explicit rather than inferred: the admin bundle lives where the build put it.
ENV DATUM_ADMIN_DIST=/app/packages/datum/public/admin
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# No curl in a slim image, and no reason to add one — node can ask for itself. Honours PORT
# so the check still works on platforms that assign the port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `serve` runs migrations on boot, idempotently, then listens. There is no separate
# release/pre-deploy step to forget.
CMD ["node", "packages/datum/dist/cli/index.js", "serve"]
