# Phase 8 FE container build template.
# Source: lib/stack_templates/FE/Dockerfile.
# Copied to FE/Dockerfile by lib/bootstrap.js (idempotent, missing-only).
# Protected by stack.config.json's FE.protectedConfigFiles → Agent cannot edit.
#
# Decision provenance (docs/DECISIONS.md, 2026-05-08):
#   D11 = A → use a Dockerfile (vs runtime mount)
#   D12 = A → live in lib/stack_templates, copied by bootstrap
#   D13 = A → Vite dev server for FE
#   D22 = A → base image: node:20 (consistent with BE)
#   D23 = A → npm ci (lock-based, deterministic install)
#   D24 = A → split COPY (package*.json first → ci → src) for layer cache

FROM node:20

WORKDIR /app

# Layer cache step (D24=A): install deps from lock first.
# Re-runs only when package.json or package-lock.json changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the rest of the source.
COPY . .

# Documents the in-container port. Actual host:container mapping is set by
# docker-compose.yml's ports block (DEPLOY_PORT_FE → 5173).
EXPOSE 5173

# D13=A: Vite dev server.
# --host 0.0.0.0 binds to all interfaces so the container port is reachable
# from the host. Default is 127.0.0.1 (loopback inside the container only),
# which makes the port unreachable from outside.
# --port 5173 is explicit to match the EXPOSE / docker-compose mapping.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
