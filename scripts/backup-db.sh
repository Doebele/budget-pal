#!/usr/bin/env bash
# Datenbank-Dump nach backups/, Dumps aelter als 14 Tage werden geloescht.
#   scripts/backup-db.sh [bezeichnung]
# Nachts per Cron auf dem Server:
#   0 3 * * * /opt/budgetpal/scripts/backup-db.sh nightly >/dev/null
# ponytail: Dumps liegen auf demselben Server. Faellt die Platte aus, sind sie
# mit weg — fuer eine Kopie ausser Haus per scp/rsync abholen.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups

out="backups/budgetpal_$(date +%F_%H%M)_${1:-manual}.sql.gz"
# Benutzer und Datenbank aus dem Container selbst — .env muss nicht geparst werden
docker exec budget-pal-db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$out"
find backups -name 'budgetpal_*.sql.gz' -mtime +14 -delete
echo "$out"
