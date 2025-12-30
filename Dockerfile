FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/*.ts ./
COPY --from=builder /app/*.json ./

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "index.ts"]