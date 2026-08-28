FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY backend ./backend

EXPOSE 3001
CMD ["node", "backend/src/server.mjs"]
