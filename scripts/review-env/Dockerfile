FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f

# Build tools are private to this image. No host runtime or package cache enters it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ procps file xz-utils \
    libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2 libgtk-3-0 xvfb xauth \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.34.5 \
    && mkdir -p /review/home /review/config /review/data /review/state \
      /review/cache /review/logs /review/repositories /review/runtime \
      /review/tmp /review/workspace \
    && chown -R node:node /review

RUN chmod 700 /review/*
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# X11 and other native libraries use /tmp directly. Keep those mutable paths
# inside the same private temporary volume instead of the read-only image.
RUN rm -rf /tmp && ln -s /review/tmp /tmp

USER node
WORKDIR /review/workspace
ENV HOME=/review/home \
    XDG_CONFIG_HOME=/review/config \
    XDG_DATA_HOME=/review/data \
    XDG_STATE_HOME=/review/state \
    XDG_CACHE_HOME=/review/cache \
    XDG_RUNTIME_DIR=/review/runtime \
    TMPDIR=/review/tmp \
    npm_config_cache=/review/cache/npm \
    npm_config_userconfig=/review/config/npmrc \
    PNPM_HOME=/review/cache/pnpm \
    ELECTRON_CACHE=/review/cache/electron \
    ELECTRON_BUILDER_CACHE=/review/cache/electron-builder \
    PLAYWRIGHT_BROWSERS_PATH=/review/cache/browsers \
    GIT_CONFIG_GLOBAL=/review/config/gitconfig \
    GIT_CONFIG_NOSYSTEM=1

CMD ["node", "/source/scripts/review-env/container.mjs", "serve"]
