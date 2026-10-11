#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

if [ ! -f .env ]; then
  echo "Missing $project_dir/.env; production credentials are never created by this script." >&2
  exit 1
fi

compose_file=compose.prod.yml

docker compose -f "$compose_file" config --quiet
docker compose -f "$compose_file" build

# Never use `down -v` here: whatsapp_auth is the live linked-device credential and
# the other named volumes contain application data.
docker compose -f "$compose_file" up -d --remove-orphans

attempt=1
max_attempts=36
while [ "$attempt" -le "$max_attempts" ]; do
  if curl -fsS http://127.0.0.1:3011/ready 2>/dev/null; then
    printf '\nPeerMate is ready.\n'
    exit 0
  fi
  sleep 5
  attempt=$((attempt + 1))
done

echo "PeerMate did not become ready within 3 minutes." >&2
docker compose -f "$compose_file" ps >&2
echo "Inspect logs on the server; they can contain a one-time WhatsApp pairing code." >&2
exit 1
