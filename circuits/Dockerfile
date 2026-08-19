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

# Create a non-root user — --dangerously-skip-permissions refuses to run as root.
RUN useradd -m -s /bin/bash claude \
 && chown -R claude:claude /home/claude
USER claude
WORKDIR /home/claude

ENV CIRCOM=/usr/local/bin/circom
ENV NODE_OPTIONS=--max-old-space-size=8192

RUN circom --version && snarkjs --version | head -1 && claude --version

CMD ["bash"]
