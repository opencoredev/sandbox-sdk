ARG SANDBOX_VERSION=latest
FROM ghcr.io/blaxel-ai/sandbox:${SANDBOX_VERSION} AS sandbox-api

# Every bench scenario needs Node, Python 3, git and GNU sed: the SDK carries
# background-process logs through sed, and BusyBox sed on Alpine images breaks them.
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  git \
  procps \
  python3 \
  python3-pip \
  python3-venv \
  python-is-python3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace

WORKDIR /workspace

COPY --from=sandbox-api /sandbox-api /usr/local/bin/sandbox-api

EXPOSE 8080 3000

ENTRYPOINT ["/usr/local/bin/sandbox-api"]
