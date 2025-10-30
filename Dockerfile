# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

# Copy everything except node_modules first
COPY . .

# Install dependencies (including devDependencies)
RUN npm install

# Build TypeScript
RUN npx tsc

# Stage 2: Production image
FROM node:22-alpine
WORKDIR /app

# Copy only package.json & lockfile for production install
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled code & runtime dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

ENV PORT=3000

EXPOSE 3000
CMD ["node", "dist/index.js"]
