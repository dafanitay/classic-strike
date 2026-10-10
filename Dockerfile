# CLASSIC STRIKE — one container serves the static client and the game server.
# syntax=docker/dockerfile:1
# NODE_IMAGE can point at a mirror (e.g. public.ecr.aws/docker/library/node:22-slim).
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Browser binaries are only needed for local e2e tests, never in the image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY . .
RUN npm run build

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/dist
# The server bundle has no runtime npm dependencies (ws is bundled).
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8080
CMD ["node", "dist-server/server.mjs"]
