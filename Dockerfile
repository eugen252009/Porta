FROM node:22.19.0-bookworm-slim AS build
ARG PORTA_VERSION=0.1.0
ARG GIT_COMMIT=unknown
ARG BUILD_ID=development
ARG BUILD_DIRTY=
ARG BUILT_AT=
WORKDIR /src
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY web ./web
COPY README.md docs ./
RUN npm run build && npm prune --omit=dev

FROM node:22.19.0-bookworm-slim
ARG PORTA_VERSION
ARG GIT_COMMIT
ARG BUILD_ID
ARG BUILD_DIRTY
ARG BUILT_AT
ENV PORTA_CONFIG=/config/porta.json PORTA_DATA_DIR=/data PORTA_WEB_PORT=4173 PORTA_VERSION=$PORTA_VERSION PORTA_GIT_COMMIT=$GIT_COMMIT PORTA_BUILD_ID=$BUILD_ID PORTA_BUILD_DIRTY=$BUILD_DIRTY PORTA_BUILT_AT=$BUILT_AT
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/web ./web
RUN useradd --create-home --uid 10001 porta && mkdir -p /config /data /workspaces && chown -R porta:porta /app /config /data /workspaces
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4173/ready').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["--network"]
