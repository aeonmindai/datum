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

# Optional deps stay HERE. They are not all ours: rollup ships its platform binary as an optional
# dependency, so omitting them silently removes the thing vite builds with and the admin bundle
# fails to compile. They are dropped in the runtime stage instead, which is the stage that gets
# pushed and the only place the weight matters.
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
# --omit=optional here, and only here. The optional deps are rollup's build-time platform binary
# and tree-sitter plus four grammars — native modules with a node-gyp-build install script. The
# runtime needs none of them: the indexer is deliberately decoupled, so `datum index` emits JSON
# where the code lives and `datum ingest-graph` needs no parser. Keeping them cost ~80 MB in every
# layer push and a native install attempt on an image with no C++ toolchain.
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund \
 && npm cache clean --force

# Normalise modes after copying, because git does not track the read bit. A contributor whose umask
# is 077 commits a migration that git records as 100644 and that is 0600 on disk; the image then
# builds fine, boots as the non-root `node` user, and dies with EACCES reading its own migration.
# The failure depends on the *builder's* umask, so it passes CI and breaks on a laptop, or the
# reverse — which is the worst kind of bug to ship in a boot path.
#
# `a+rX` and not `--chmod=644`: COPY --chmod applies one mode to directories too, which strips
# their traverse bit and breaks every file underneath. The capital X adds execute only to
# directories and to files that already had it, which is exactly the distinction needed here.
COPY --from=build /app/packages/datum/dist       ./packages/datum/dist
COPY --from=build /app/packages/datum/migrations ./packages/datum/migrations
COPY --from=build /app/packages/datum/public     ./packages/datum/public
# `datum seed --example` is a documented command and a v0 deliverable, so the fixtures have to
# be in the image. Without this the README's "click through a fresh install" path is a lie.
COPY --from=build /app/packages/datum/seeds      ./packages/datum/seeds
COPY LICENSE NOTICE ./
RUN chmod -R a+rX ./packages/datum/dist ./packages/datum/migrations \
                  ./packages/datum/public ./packages/datum/seeds ./LICENSE ./NOTICE

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
