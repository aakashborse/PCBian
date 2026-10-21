#!/bin/sh
# Snapshot PCBian's data directory: a dated tarball in /backups, old ones pruned, and a copy to
# S3-compatible storage when BACKUP_S3_BUCKET is set. The server writes files atomically
# (write + rename), so a snapshot never holds a half-written project.
set -eu
DATA=${DATA_DIR:-/data}
OUT=${BACKUP_DIR:-/backups}
KEEP=${BACKUP_KEEP_DAYS:-14}
stamp=$(date -u +%Y%m%d-%H%M%S)
file="$OUT/pcbian-$stamp.tar.gz"
mkdir -p "$OUT"
tar -czf "$file.partial" -C "$DATA" --exclude='*.tmp-*' .
mv "$file.partial" "$file"
echo "backup: wrote $file ($(du -h "$file" | cut -f1))"
find "$OUT" -name 'pcbian-*.tar.gz' -mtime +"$KEEP" -print -delete | sed 's/^/backup: pruned /'

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  export RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=Other RCLONE_CONFIG_S3_ENV_AUTH=true
  export RCLONE_CONFIG_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && export RCLONE_CONFIG_S3_ENDPOINT="$BACKUP_S3_ENDPOINT"
  rclone copy "$file" "s3:$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-pcbian}/"
  echo "backup: uploaded to s3:$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-pcbian}/"
fi
