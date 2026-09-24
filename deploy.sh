#!/usr/bin/env bash
# Rollt Budget-Pal auf dem Server aus. Normalerweise ruft die GitHub Action es
# auf (bei jedem Push auf main), von Hand auf dem Server:
#   IMAGE_TAG=<7-stelliger Commit-Hash> ./deploy.sh   # bestimmten Stand, z. B. zurueckrollen
#   ./deploy.sh                                       # Tag "latest"
set -euo pipefail
cd "$(dirname "$0")"

TAG="${IMAGE_TAG:-latest}"
COMPOSE=(docker compose -f docker-compose.prod.yml)
LAST_GOOD_FILE=.last-good-tag
[ -f .env ] || { echo "FEHLER: .env fehlt (kommt aus dem GitHub-Secret STRATO_ENV_FILE)"; exit 1; }

# 1. Backup vor jedem Deploy. Das Backend migriert beim Start (alembic upgrade
#    head); ein aelteres Image macht eine Migration nicht rueckgaengig.
if [ -n "$(docker ps -q -f name='^budget-pal-db$')" ]; then
  echo "Backup: $(scripts/backup-db.sh "pre-deploy_${TAG}")"
fi

# 2. Neue Images holen und starten, warten bis alle Container healthy sind
echo "Starte Tag ${TAG}"
IMAGE_TAG="$TAG" "${COMPOSE[@]}" pull
if IMAGE_TAG="$TAG" "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 300; then
  echo "$TAG" > "$LAST_GOOD_FILE"
else
  echo "FEHLER: Tag ${TAG} wird nicht healthy"
  "${COMPOSE[@]}" logs --tail=50 budget-pal-backend || true
  last="$(cat "$LAST_GOOD_FILE" 2>/dev/null || true)"
  if [ -n "$last" ] && [ "$last" != "$TAG" ]; then
    echo "Rolle zurueck auf ${last}"
    IMAGE_TAG="$last" "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 300 \
      || echo "Auch ${last} startet nicht. Hat die neue Version die Datenbank migriert, das Backup aus backups/ einspielen (siehe README)."
  fi
  exit 1
fi

# 3. Alte Images aufraeumen, die letzten fuenf Staende bleiben fuers Zurueckrollen
for repo in backend frontend; do
  docker images "ghcr.io/doebele/budget-pal/${repo}" --format '{{.Tag}}' \
    | grep -vx -e latest -e "$TAG" | tail -n +6 \
    | xargs -r -I{} docker rmi "ghcr.io/doebele/budget-pal/${repo}:{}" >/dev/null || true
done

echo "Deploy ${TAG} fertig"
