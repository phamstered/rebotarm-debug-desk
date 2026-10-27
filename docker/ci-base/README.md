# Desk CI base image

`ghcr.io/phamstered/rebotarm-debug-desk/ci-base`

Ubuntu 22.04 image used by `.github/workflows/ci.yml` for Frontend + Rust + Bridge-core tests.

## Contents

- Tauri Linux apt deps (`libwebkit2gtk-4.1-dev`, GTK, etc.)
- Node.js 22.x / npm 10
- Rust stable (pinned in `Dockerfile` `ARG RUST_TOOLCHAIN`)
- `git`, `g++`, `cmake` (bridge smoke test uses `c++`)

**Not** included: `node_modules`, cargo `target`, ROS 2 / colcon.

Stack and executor repos have (or will have) their own CI images — this is desk-only.

## Tags

Published by `.github/workflows/ci-base-publish.yml`:

- `node22-<YYYYMMDD>` — calendar day of the build
- `node22-<sha>` — short git SHA of the commit that built the image
- `node22` — floating latest for Node 22 line (optional convenience)

CI should **pin by digest** after the first successful publish.

## Local build

```bash
docker build -t rebotarm-debug-desk/ci-base:local -f docker/ci-base/Dockerfile .
```

Smoke `npm ci` against a checkout:

```bash
docker run --rm -v "$PWD":/src -w /src rebotarm-debug-desk/ci-base:local npm ci
```
