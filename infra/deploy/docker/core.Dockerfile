# syntax=docker/dockerfile:1.7
# Unzeen core (unzeen-scanner + unzeen-api), release build. Context: core/.
# Migrations are embedded at compile time (core/ledger/src/migrate.rs), so a new migration
# needs a new image. Built on the VPS (x86_64) by `unzeenctl deploy` (RUNBOOK "Деплой на VPS").
FROM rust:1.93-bookworm AS build
WORKDIR /src
COPY . .
# Cache dirs keep rebuilds incremental (registry + target); the binaries are copied out of the cache.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p unzeen-scanner -p unzeen-api \
 && install -D -m 0755 -t /out target/release/unzeen-scanner target/release/unzeen-api

FROM debian:bookworm-slim
# curl: container healthcheck of the API (loopback only). tini: signal forwarding / zombie reaping.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 app \
 && useradd -u 10001 -g app -d /data/home -M -s /usr/sbin/nologin app
COPY --from=build /out/ /usr/local/bin/
# State and keys: UNZEEN_HOME on the encrypted volume (bind mount), age identities as read-only
# single-file mounts under /run/unzeen-keys (outside the volume, N2).
ENV UNZEEN_HOME=/data/home HOME=/data/home RUST_LOG=info
USER 10001:10001
WORKDIR /data/home
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["unzeen-api", "serve"]
