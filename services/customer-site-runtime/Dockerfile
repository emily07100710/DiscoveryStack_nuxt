FROM node:22.23.1-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3002 SITE_CONFIG_PATH=/app/site.config.json SITE_DATABASE_PATH=/data/site.sqlite SITE_UPLOADS_PATH=/data/uploads
WORKDIR /app
COPY --chown=node:node server.mjs package.json ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node site.config.json ./site.config.json
USER node
EXPOSE 3002
CMD ["node", "server.mjs"]
