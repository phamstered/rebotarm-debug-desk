# CI base image for rebotarm-debug-desk (GitHub Actions container job).
#
# Image: ghcr.io/phamstered/rebotarm-debug-desk/ci-base
#
# Bakes Ubuntu 22.04 + Tauri Linux apt deps + Node 22 / npm 10 + Rust stable + git.
# Does NOT bake: node_modules, cargo target, ROS2/colcon.
#
# Rebuild when this Dockerfile or apt dependency list changes
# (see .github/workflows/ci-base-publish.yml).
#
# Sibling repos (stack / executor) own their own CI images; this one is desk-only.

FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
# Pin a concrete stable toolchain so rebuilds are reproducible.
# Bump deliberately when upgrading Rust (match rust-lang stable channel).
ARG RUST_TOOLCHAIN=1.99.1
ARG NODE_MAJOR=22

LABEL org.opencontainers.image.title="rebotarm-debug-desk ci-base" \
      org.opencontainers.image.description="CI base for desk Frontend/Rust/Bridge-core tests (no ROS2)" \
      org.opencontainers.image.source="https://github.com/phamstered/rebotarm-debug-desk"

# Tauri 2 Linux prerequisites (from .github/workflows/ci.yml historically) +
# g++ for `npm run test:bridge` (c++ -std=c++17). build-essential already pulls
# g++, but keep the intent explicit. cmake not required for that smoke binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      file \
      g++ \
      git \
      gnupg \
      libayatana-appindicator3-dev \
      libgtk-3-dev \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      patchelf \
      pkg-config \
      wget \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22.x (npm 10) — must match GitHub Actions setup-node@22 / package-lock.
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version \
    && npm --version | grep -qE '^10\.'

# Rust stable via rustup (pinned toolchain version).
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain "${RUST_TOOLCHAIN}" --profile minimal \
    && rustc --version \
    && cargo --version \
    && chmod -R a+rX /usr/local/rustup /usr/local/cargo

# Default workdir matches Actions checkout layout; jobs still set working-directory if needed.
WORKDIR /github/workspace

# Root is typical for GHA container jobs (cache dirs, npm ci, cargo).
# Override with `container.options: --user root` in the workflow if the runner
# injects a non-root default.
USER root
