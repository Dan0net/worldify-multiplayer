#!/bin/bash
set -e

# Worldify Server Deploy Script
# Called from GitHub Actions after pushing new image

echo "=== Deploying Worldify Server ==="

cd /opt/worldify

# Pull latest images
docker compose pull

# Restart with new images
docker compose up -d

# Wait for server to be ready
sleep 5

# Health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:80/healthz || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  echo "=== Deploy successful! ==="
  docker compose ps
else
  echo "=== Health check failed (HTTP $HTTP_CODE) ==="
  docker compose logs --tail=50
  exit 1
fi
