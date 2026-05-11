# Phase 8 BE container build template.
# Source: lib/stack_templates/BE/Dockerfile.
# Copied to BE/Dockerfile by lib/bootstrap.js (idempotent, missing-only).
# Protected by stack.config.json's BE.protectedConfigFiles → Agent cannot edit.
#
# Decision provenance (docs/DECISIONS.md, 2026-05-08):
#   D11 = A → use a Dockerfile (vs runtime mount)
#   D12 = A → live in lib/stack_templates, copied by bootstrap
#   D19 = A → base image: node:20 (Debian-based, fast bcrypt native build)
#   D20 = A → npm ci (lock-based, deterministic install)
#   D21 = A → split COPY (package*.json first → ci → src) for layer cache

FROM node:20

WORKDIR /app

# Layer cache step (D21=A):
# This RUN re-executes only when package.json or package-lock.json changes.
# Plain source edits skip straight to the COPY below, keeping rebuilds fast.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the rest of the source.
# Re-runs on every src change, but the npm ci layer above stays cached.
COPY . .

# Documents the in-container port. Actual host:container mapping is set by
# docker-compose.yml's ports block (DEPLOY_PORT_BE → 3001).
EXPOSE 3001

# Resolves to "node src/server.js" via BE/package.json's "start" script.
# server.js reads BE_PORT (3001) and DB_* env vars injected by docker-compose.
CMD ["npm", "start"]
