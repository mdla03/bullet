# Deliverable 1 (shielded-amount circuit) build box.
#
# Scope: circuit tooling only. node 20 + circom + snarkjs + circomlib +
# Claude Code CLI (for running the D1 task unattended inside this sandbox).
# Deliberately absent: stellar/soroban CLI, rust toolchain in the final image,
# freighter/wallet SDKs, supabase/vercel/gcloud/aws CLIs, git remotes, curl.
# Nothing here can sign a transaction or reach a chain.
#
# Build:  docker build -t bullet-d1 circuits/
# Run:    see README note / the docker run commands in this file's footer.

# ---- stage 1: circom -------------------------------------------------------
# iden3 publishes no arm64 release binary, so compile from source and keep the
# rust toolchain out of the runtime image.
FROM rust:1-slim-bookworm AS circom-build
ARG CIRCOM_VERSION=v2.2.3
RUN apt-get update \
      && apt-get install -y --no-install-recommends git ca-certificates \
      && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${CIRCOM_VERSION}" https://github.com/iden3/circom.git /src
WORKDIR /src
RUN cargo build --release && strip target/release/circom

# ---- stage 2: runtime ------------------------------------------------------
FROM node:20-bookworm-slim

COPY --from=circom-build /src/target/release/circom /usr/local/bin/circom

# Pinned to circuits/package.json so an offline container matches a local run.
ARG SNARKJS_VERSION=0.7.5
ARG CIRCOMLIB_VERSION=2.0.5
RUN npm install -g --no-fund --no-audit \
      "snarkjs@${SNARKJS_VERSION}" \
      "circomlib@${CIRCOMLIB_VERSION}" \
      && npm cache clean --force

# Claude Code CLI — installed so Deliverable 1 can be run unattended inside
# this sandbox. Auth is via subscription login (claude), not an API key —
# no ANTHROPIC_API_KEY is baked into or expected in this image.
RUN npm install -g @anthropic-ai/claude-code \
      && npm cache clean --force

# build-claim.sh reads $CIRCOM; point it at the container binary, not ~/.local.
ENV CIRCOM=/usr/local/bin/circom
# snarkjs phase-2 setup on a ~2^15 circuit will OOM on the default heap.
ENV NODE_OPTIONS=--max-old-space-size=8192

WORKDIR /work

RUN circom --version && snarkjs --version | head -1 && claude --version

CMD ["bash"]
