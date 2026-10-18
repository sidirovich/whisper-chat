# syntax=docker/dockerfile:1

# ---------- Сборка: next build ----------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---------- Рантайм ----------
FROM node:20-alpine AS runner
# Cloud Run подставляет PORT, но зафиксируем дефолты; наружу слушаем осознанно
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
RUN mkdir -p /app && chown node:node /app
USER node
WORKDIR /app

# prod-зависимости отдельным слоем — кэшируется между сборками кода
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# исходники/конфиги + готовая сборка из builder (.dockerignore исключает node_modules и .next)
COPY --chown=node:node . .
COPY --from=builder --chown=node:node /app/.next ./.next

EXPOSE 8080
# Cloud Run использует собственные пробы; этот healthcheck — для локального docker run
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "server.js"]
