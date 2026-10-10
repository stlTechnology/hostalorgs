# One container image: gate + FTE dedicated server + the served web snapshot.
#
#   docker build -t qwtf .
#   docker run -e GATE_SECRET=... -p 8080:8080 qwtf
#
# PLAN.md M6: "one container image (Dockerfile: gate + FTE + web snapshot) that
# runs locally with `docker run -p 8080:8080`. The secret comes from an
# environment variable."
#
# What each piece is:
#   build stage   clones fteqw at the SAME PIN scripts/fetch_third_party.sh
#                 pins (single source of the commit: the pin list is not
#                 duplicated here) and compiles the native dedicated server.
#   runtime       node for the gate, the compiled build/fteqw-sv, and web/ --
#                 the served tree is frozen at build time, which is the
#                 container analogue of scripts/deploy_snapshot.sh: the gate
#                 and the server read the same immutable directory, so a
#                 rebuild cannot desync a running play-test (reviewer 0054).
#
# Ports inside the container: the gate on $GATE_PORT (published) and the game
# server on $FTE_PORT (NOT published -- FTE binds 0.0.0.0 with the plain-port
# form, and the container boundary is what keeps it private; the same shape the
# systemd units get from the source-based firewall rule). Publish only 8080.
#
# The secret: GATE_SECRET, required -- the entrypoint refuses to start without
# it (the gate's dev-secret fallback is a dev convenience, not a default).
#
# Licence note: fteqw is GPL v2 and this image builds and ships it; the served
# web tree carries the GPL v2 source offer at web/SOURCE.md (checked by
# tests/run_fte.js), which the running image continues to serve.

# ---------------------------------------------------------------------------
# Stage 1: build the native dedicated server.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git make gcc g++ pkg-config zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY scripts/fetch_third_party.sh scripts/fetch_third_party.sh
COPY scripts/build_fte_server.sh scripts/build_fte_server.sh

# Only fteqw: ericw-tools and LibreQuake are map-compiler and assets, and the
# server image needs neither. QWTF_FETCH_ONLY keeps one pin list.
RUN QWTF_FETCH_ONLY=fteqw bash scripts/fetch_third_party.sh \
 && bash scripts/build_fte_server.sh

# ---------------------------------------------------------------------------
# Stage 2: runtime.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

WORKDIR /app

COPY --from=build /src/build/fteqw-sv build/fteqw-sv
COPY server/gate.js server/gate.js
COPY scripts/run_server.sh scripts/run_server.sh
COPY web/ web/
COPY docker/entrypoint.sh docker/entrypoint.sh

# The served tree is complete only with the precompressed .gz siblings the gate
# serves when the client accepts gzip (0484): they are ordinary files in web/,
# copied above, nothing to do here.
#
# Build stamp: the menu fetches web/build.json and degrades to "build unknown"
# without it. The image build writes one from build args so the owner's menu
# shows what the container is; --build-arg QWTF_SHA=$(git rev-parse --short HEAD)
# makes it exact, and the default is honest about not knowing.
ARG QWTF_SHA=unknown
RUN printf '{"built":"container","sha":"%s"}' "$QWTF_SHA" > web/build.json

ENV FTE_PORT=27500 \
    GATE_PORT=8080 \
    QWTF_MAP=forts

EXPOSE 8080

# The gate's own landing page is the cheap readiness probe; node is guaranteed
# present, curl is not (slim image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.GATE_PORT||8080)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["bash", "/app/docker/entrypoint.sh"]
