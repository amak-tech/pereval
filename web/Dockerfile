# syntax=docker/dockerfile:1.7
# Перевал — control plane (Next.js app + фоновые jobs). Один образ, две команды.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat && npm install -g pnpm@12 --silent
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM deps AS build
COPY . .
ENV NODE_ENV=production
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
# Next standalone (server.js + минимальные node_modules)
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# jobs / admin / migrate — бандлы esbuild с внешними зависимостями из prod node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/src/lib/db/migrations ./migrations
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app deploy/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
USER app
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["app"]
