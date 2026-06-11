#!/usr/bin/env bash
#
# One-time root setup for hosting garmin-connect-mcp behind a host-level
# Caddy. Reviewed by the owner before it runs. Idempotent: safe to re-run.
#
# Usage:
#   sudo ./phase4-root-setup.sh <domain> <upstream-port> [--disable-cups] [--skip-compose-plugin]
#
# Example:
#   sudo ./phase4-root-setup.sh garmin-mcp.example.com 8081 --disable-cups
#
# Steps:
#   1. Install the docker compose v2 plugin (apt), unless --skip-compose-plugin.
#   2. Back up /etc/caddy/Caddyfile, then append the site block below if the
#      domain is not already present.
#   3. caddy validate against the new config; on failure, RESTORE the backup
#      and abort WITHOUT reloading.
#   4. systemctl reload caddy (reload — never restart — so live sites are
#      not interrupted).
#   5. Optionally disable the stray CUPS service (--disable-cups).

set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile

usage() {
  echo "Usage: sudo $0 <domain> <upstream-port> [--disable-cups] [--skip-compose-plugin]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
DOMAIN=$1
UPSTREAM_PORT=$2
shift 2

DISABLE_CUPS=false
SKIP_COMPOSE_PLUGIN=false
for arg in "$@"; do
  case "$arg" in
    --disable-cups) DISABLE_CUPS=true ;;
    --skip-compose-plugin) SKIP_COMPOSE_PLUGIN=true ;;
    *) usage ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "ERROR: must run as root (sudo)." >&2; exit 1; }
[[ "$UPSTREAM_PORT" =~ ^[0-9]+$ ]] || { echo "ERROR: upstream port must be numeric." >&2; exit 1; }
[[ -f "$CADDYFILE" ]] || { echo "ERROR: $CADDYFILE not found." >&2; exit 1; }

echo "==> 1/5 docker compose v2 plugin"
if $SKIP_COMPOSE_PLUGIN; then
  echo "    skipped (--skip-compose-plugin)"
elif docker compose version >/dev/null 2>&1; then
  echo "    already installed: $(docker compose version)"
else
  apt-get update -qq
  apt-get install -y -qq docker-compose-plugin
  docker compose version
fi

echo "==> 2/5 Caddyfile site block for ${DOMAIN}"
BACKUP="${CADDYFILE}.bak.$(date +%Y%m%d%H%M%S)"
cp "$CADDYFILE" "$BACKUP"
echo "    backup: $BACKUP"
if grep -q "^${DOMAIN}\b" "$CADDYFILE"; then
  echo "    site block already present; leaving Caddyfile unchanged"
else
  cat >> "$CADDYFILE" <<BLOCK

${DOMAIN} {
    reverse_proxy localhost:${UPSTREAM_PORT}
    encode gzip
}
BLOCK
  echo "    appended reverse_proxy localhost:${UPSTREAM_PORT}"
fi

echo "==> 3/5 caddy validate"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile; then
  echo "ERROR: validation failed — restoring backup, NOT reloading." >&2
  cp "$BACKUP" "$CADDYFILE"
  exit 1
fi

echo "==> 4/5 systemctl reload caddy"
systemctl reload caddy
systemctl is-active caddy

echo "==> 5/5 CUPS"
if $DISABLE_CUPS; then
  systemctl disable --now cups.service cups.socket cups-browsed.service 2>/dev/null || true
  echo "    CUPS disabled"
else
  echo "    skipped (pass --disable-cups to disable)"
fi

echo "Done. Verify: curl -fsS https://${DOMAIN}/healthz"
