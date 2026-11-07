# --- build web + server bundle
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

# --- runtime
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data WEB_DIST=/app/web/dist PORT=4000
COPY package*.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
VOLUME /data
EXPOSE 4000
USER node
CMD ["node", "server/dist/index.js"]
