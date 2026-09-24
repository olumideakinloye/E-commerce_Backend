# syntax=docker/dockerfile:1

# Stage 1: Build stage
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev) for building
RUN npm ci

COPY src ./src

# Compile TypeScript and resolve path aliases
RUN npm run build

# Stage 2: Production runner
FROM node:22-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /usr/src/app/dist ./dist

# Run as non-root user for security
USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]
