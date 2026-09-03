FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=8788

COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev --ignore-scripts \
  && npm rebuild better-sqlite3

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.server-build/server ./server
COPY --from=builder /app/server/db/schema.sql ./server/db/schema.sql

EXPOSE 8788
CMD ["sh", "-c", "node server/db/migrate.js && node server/index.js"]
