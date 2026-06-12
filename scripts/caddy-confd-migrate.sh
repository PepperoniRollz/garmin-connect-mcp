#!/usr/bin/env bash
#
# One-time migration: move this server's site block out of a SHARED
# /etc/caddy/Caddyfile into /etc/caddy/conf.d/<name>.caddy, and add an
# `import conf.d/*.caddy` line to the main Caddyfile. This makes the route
# survive a co-tenant deploy that rewrites the main Caddyfile, as long as
# that rewrite keeps the import line (add it to the co-tenant's source too).
#
# Safe + idempotent: backs up, writes the conf.d file FIRST (so the import
# glob always matches), removes any inline block for the domain, validates,
# and only reloads on success — otherwise restores the backup and aborts.
#
# Usage:
#   sudo ./caddy-confd-migrate.sh <domain> <upstream-port> [conf-name]
#
# Example:
#   sudo ./caddy-confd-migrate.sh garmin-mcp.example.com 8081 garmin-mcp

set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile
CONFD=/etc/caddy/conf.d

usage() {
  echo "Usage: sudo $0 <domain> <upstream-port> [conf-name]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
DOMAIN=$1
PORT=$2
CONF_NAME=${3:-$1}

[[ $EUID -eq 0 ]] || { echo "ERROR: must run as root (sudo)." >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "ERROR: upstream port must be numeric." >&2; exit 1; }
[[ -f "$CADDYFILE" ]] || { echo "ERROR: $CADDYFILE not found." >&2; exit 1; }

BACKUP="${CADDYFILE}.bak.confd.$(date +%Y%m%d%H%M%S)"
cp "$CADDYFILE" "$BACKUP"
echo "==> backup: $BACKUP"

echo "==> writing ${CONFD}/${CONF_NAME}.caddy"
mkdir -p "$CONFD"
cat > "${CONFD}/${CONF_NAME}.caddy" <<BLOCK
${DOMAIN} {
    reverse_proxy localhost:${PORT}
    encode gzip
}
BLOCK

echo "==> removing any inline ${DOMAIN} block from the main Caddyfile"
# Drop the block spanning the domain line through its closing brace at col 0.
awk -v open="${DOMAIN} {" '
  index($0, open) == 1 { skip = 1; next }
  skip && /^}/         { skip = 0; next }
  !skip                { print }
' "$BACKUP" > "${CADDYFILE}.tmp"
mv "${CADDYFILE}.tmp" "$CADDYFILE"

echo "==> ensuring import line is present"
if ! grep -qF 'import conf.d/*.caddy' "$CADDYFILE"; then
  printf 'import conf.d/*.caddy\n\n%s\n' "$(cat "$CADDYFILE")" > "${CADDYFILE}.tmp"
  mv "${CADDYFILE}.tmp" "$CADDYFILE"
fi

echo "==> caddy validate"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile; then
  echo "ERROR: validation failed — restoring backup, removing conf.d file, NOT reloading." >&2
  cp "$BACKUP" "$CADDYFILE"
  rm -f "${CONFD}/${CONF_NAME}.caddy"
  exit 1
fi

echo "==> systemctl reload caddy"
systemctl reload caddy
systemctl is-active caddy
echo "Done. Verify: curl -fsS https://${DOMAIN}/healthz"
