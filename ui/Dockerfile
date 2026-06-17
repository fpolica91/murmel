# syntax=docker/dockerfile:1
# Production image for the aweb UI (Next.js standalone output). The UI is the
# Better Auth JWT issuer; supply its runtime env at `docker run` / compose:
#   BETTER_AUTH_URL, BETTER_AUTH_SECRET, DATABASE_URL, AWEB_JWT_AUDIENCE,
#   AWEB_MEMBERSHIPS_URL, AWEB_MEMBERSHIPS_HINT_KEY (see docs/running-the-stack.md).
# Build needs no secrets — auth construction is deferred to first request.

# NOTE: build context is the REPO ROOT (Railway `railway up` uploads the linked
# project root), so all COPY paths are repo-root-relative (ui/...). Pair with
# the service variable RAILWAY_DOCKERFILE_PATH=ui/Dockerfile.
FROM node:22-alpine AS deps
WORKDIR /app
COPY ui/package.json ui/package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY ui/ ./
# NEXT_PUBLIC_* are inlined into the client bundle at build time, so the
# browser-facing aweb API origin + Better Auth URL must be present here (passed
# as build args; on Railway these come from the service variables of the same
# name). Runtime-only secrets (BETTER_AUTH_SECRET, DATABASE_URL) stay out of the build.
ARG NEXT_PUBLIC_AWEB_API_URL
ARG NEXT_PUBLIC_BETTER_AUTH_URL
ENV NEXT_PUBLIC_AWEB_API_URL=$NEXT_PUBLIC_AWEB_API_URL
ENV NEXT_PUBLIC_BETTER_AUTH_URL=$NEXT_PUBLIC_BETTER_AUTH_URL
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
USER node
# Self-contained server + static assets from the standalone build.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
