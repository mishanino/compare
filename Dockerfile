# syntax=docker/dockerfile:1

# Debian (glibc) base: sharp ships prebuilt binaries for it, no compiler needed.
ARG NODE_IMAGE=node:24-bookworm-slim

# 1. All dependencies, for the build.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2. Production build. next/font downloads the Google fonts here, so the build
#    needs network access; the running container does not.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# 3. Runtime: production dependencies and the build output only. Not using
#    output: "standalone", because file tracing can miss sharp's platform
#    binaries and heic-convert's WASM.
FROM ${NODE_IMAGE} AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY package.json package-lock.json next.config.ts ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/.next ./.next
# runs/ holds log.jsonl; mount it as a volume to keep the measurements.
RUN mkdir -p runs && chown node:node runs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/next", "start"]
