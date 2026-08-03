FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Kyiv
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data /app/backups && chown -R node:node /app
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
