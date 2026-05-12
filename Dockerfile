# better-sqlite3 はネイティブモジュールなので build stage を分けてイメージを小さくする
FROM node:20-alpine AS builder

# better-sqlite3 のネイティブビルド用ツール
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ──────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# ビルド済み node_modules をコピー
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/attendance.db

EXPOSE 8080

CMD ["node", "server.js"]
