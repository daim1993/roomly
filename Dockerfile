FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js index.html styles.css refinement.css ui-system.css taste-v1.css app.js admin.html admin.css admin-refinement.css admin-ui-system.css admin-taste-v1.css admin-console.js ./
COPY lib ./lib
COPY js ./js

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
ENV PORT=3000 DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
