FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/

# Install dependencies
RUN npm ci --workspace=@worldify/shared --workspace=@worldify/server

# Copy source
COPY shared ./shared
COPY server ./server
COPY tsconfig.base.json ./

# Build
RUN npm run build -w @worldify/shared
RUN npm run build -w @worldify/server

# Production image
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/

# Install production dependencies only
RUN npm ci --omit=dev --workspace=@worldify/shared --workspace=@worldify/server

# Copy built files
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "server/dist/index.js"]
