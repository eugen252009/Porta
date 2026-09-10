# syntax=docker/dockerfile:1.7
FROM golang:1.26-bookworm AS mema-build
ARG MEMA_REPOSITORY=https://github.com/coffeemakerstudio/mema.git
ARG MEMA_REVISION=b6fa105668695ca5b03f201886bc998aa9b28797
ARG TARGETARCH
WORKDIR /src
RUN git clone --filter=blob:none "$MEMA_REPOSITORY" . \
 && git checkout "$MEMA_REVISION" \
 && cd mema-go \
 && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -o /out/mema . \
 && cd /src \
 && mkdir -p /out/recipes /out/helpers \
 && cp core/mema_download core/mema_find_recipes core/mema_list core/mema_verify /out/helpers/ \
 && find recipes/recipes -type f -name '*.sh' -exec cp {} /out/recipes/ \;

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
ARG GO_VERSION=1.26.5
ARG RUST_VERSION=1.97.1
ENV PORTA_CONFIG=/config/porta.json \
    PORTA_DATA_DIR=/data \
    PORTA_WEB_PORT=4173 \
    PORTA_VERSION=$PORTA_VERSION \
    PORTA_GIT_COMMIT=$GIT_COMMIT \
    PORTA_BUILD_ID=$BUILD_ID \
    PORTA_BUILD_DIRTY=$BUILD_DIRTY \
    PORTA_BUILT_AT=$BUILT_AT \
    HOME=/home/porta \
    PATH=/home/porta/.local/bin:$PATH

# OS dependencies are intentionally installed by APT at image-build time.
# Go and Rust are installed below by Mema in the non-root local scope.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      openssh-client \
      bash \
      jq \
      tar \
      xz-utils \
      unzip \
      fzf \
      build-essential \
      pkg-config \
      python3 \
      python3-pip \
      bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /bin/sh porta \
 && mkdir -p /app /config /data /workspace /opt/mema/recipes \
 && chown -R porta:porta /app /config /data /workspace

COPY --from=mema-build /out/mema /usr/local/bin/mema
COPY --from=mema-build /out/helpers/ /usr/local/bin/
COPY --from=mema-build /out/recipes/ /opt/mema/recipes/

# The pinned upstream Rust recipe extracts the standalone installer but does not
# invoke it. Apply the smallest environment-local fix so the advertised Rust
# toolchain is actually installed; the recipe remains checksum-verified.
RUN sed -i \
      's/local arch archive target/local arch archive target workdir/' \
      /opt/mema/recipes/rust.sh \
 && sed -i \
      's|    $MEMA_SUDO tar -xJf "$archive" -C "$MEMA_INSTALL_DIR" --strip-components=1|    workdir=$(mktemp -d); tar -xJf "$archive" -C "$workdir" --strip-components=1; cd "$workdir"; ./install.sh --prefix="$MEMA_INSTALL_DIR" --disable-ldconfig --without=rust-docs; cd - >/dev/null; rm -rf "$workdir"|' \
      /opt/mema/recipes/rust.sh

# Bake the declared standard toolchains into the image, rather than mounting
# Mema state. An old volume therefore cannot hide a newer image definition.
USER porta
RUN --mount=type=cache,target=/tmp/mema/cache,uid=10001,gid=10001 \
    mkdir -p /home/porta/.local/share/mema/recipe /home/porta/.local/bin \
 && cp /opt/mema/recipes/*.sh /home/porta/.local/share/mema/recipe/ \
 && mkdir -p /tmp/mema/cache \
 && mema init --local \
 && mema install --local go "$GO_VERSION" \
 && mema install --local rust "$RUST_VERSION"
USER root

WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/web ./web
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4173/ready').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["--network"]
