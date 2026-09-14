#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="${PEERMATE_DIR:-/home/dayo/apps/peermate-whatsapp}"
backup_dir="${PEERMATE_BACKUP_DIR:-/home/dayo/backups/peermate}"
# Keep the recovery key outside the release directory so replacing or cleaning the
# application checkout cannot make otherwise healthy backups undecryptable.
passphrase_file="${PEERMATE_BACKUP_PASSPHRASE_FILE:-/home/dayo/.config/peermate/backup-passphrase}"
compose_file="${project_dir}/compose.prod.yml"
archive_image="busybox@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616"

umask 077
mkdir -p "$backup_dir"
test -s "$passphrase_file"
test -f "$compose_file"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work_dir="$(mktemp -d)"
app_was_running=false

restart_app() {
  if "$app_was_running"; then
    docker compose -f "$compose_file" --project-directory "$project_dir" up -d app >/dev/null
  fi
  rm -rf "$work_dir"
}
trap restart_app EXIT

if docker compose -f "$compose_file" --project-directory "$project_dir" ps \
  --status running --services | grep -qx app; then
  app_was_running=true
  docker compose -f "$compose_file" --project-directory "$project_dir" stop -t 90 app >/dev/null
fi

# Logical Mongo dump plus read-only snapshots of the other three persistent stores.
docker compose -f "$compose_file" --project-directory "$project_dir" exec -T mongo \
  mongodump --quiet --db peermate --archive --gzip >"${work_dir}/mongo.archive.gz"

for volume in whatsapp_auth chroma_data media_data; do
  docker run --rm \
    -v "peermate-whatsapp_${volume}:/source:ro" \
    -v "${work_dir}:/backup" \
    "$archive_image" \
    tar -C /source -czf "/backup/${volume}.tar.gz" .
done

(cd "$work_dir" && sha256sum ./* >SHA256SUMS)
tar -C "$work_dir" -czf - . | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -pass "file:${passphrase_file}" \
  -out "${backup_dir}/peermate-${stamp}.tar.gz.enc"

# Retain more than the one-month pilot while keeping disk growth bounded.
find "$backup_dir" -type f -name 'peermate-*.tar.gz.enc' -mtime +45 -delete
printf 'Encrypted backup created: %s\n' "${backup_dir}/peermate-${stamp}.tar.gz.enc"
