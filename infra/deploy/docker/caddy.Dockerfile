# syntax=docker/dockerfile:1.7
# Caddy + mholt/caddy-ratelimit (per-client limits kept in memory only; no distributed mode,
# so client addresses are never written to storage). Plugin pinned via CADDY_RATELIMIT_VERSION.
ARG CADDY_VERSION=2.10
FROM caddy:${CADDY_VERSION}-builder AS build
ARG CADDY_RATELIMIT_VERSION=latest
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@${CADDY_RATELIMIT_VERSION}

FROM caddy:${CADDY_VERSION}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
