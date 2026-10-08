# --- STAGE 1: Builder ---
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency files first to cache npm install layer
COPY package*.json ./
RUN npm install

# Copy source code and run build
COPY . .

# VITE_BASE_PATH — public path the app is served under (e.g. "/3dpanel/")
# VITE_API_URL   — public API base without the /api suffix (e.g. "/3dpanel")
ARG VITE_BASE_PATH=/
ARG VITE_API_URL=
ENV VITE_BASE_PATH=$VITE_BASE_PATH \
    VITE_API_URL=$VITE_API_URL

RUN npm run build


# --- STAGE 2: Production Runtime ---
FROM node:22-alpine AS runner

WORKDIR /app

RUN npm install -g serve

# Copy only the built assets from the builder stage
COPY --from=builder /app/dist ./dist

EXPOSE 5173

CMD ["serve", "-s", "dist", "-l", "5173"]
