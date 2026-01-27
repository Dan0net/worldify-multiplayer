#!/bin/bash
set -e

# Worldify Server Deploy Script
# Called from GitHub Actions after pushing new image

echo "=== Deploying Worldify Server ==="
echo "Date: $(date)"
echo "Host: $(hostname)"

cd /opt/worldify

# Login to GHCR if token provided
if [ -n "$GHCR_TOKEN" ]; then
  echo ">>> Logging in to GHCR..."
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

# Pull latest images
echo ">>> Pulling latest images..."
docker compose pull

# Restart with new images
echo ">>> Starting containers..."
docker compose up -d --remove-orphans

# Wait for server to be ready
echo ">>> Waiting for server to start..."
sleep 5

# Health check with retries
MAX_RETRIES=6
RETRY_DELAY=5

for i in $(seq 1 $MAX_RETRIES); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:80/healthz 2>/dev/null || echo "000")
  
  if [ "$HTTP_CODE" = "200" ]; then
    echo "=== Deploy successful! ==="
    docker compose ps
    exit 0
  fi
  
  echo "Health check attempt $i/$MAX_RETRIES: HTTP $HTTP_CODE"
  
  if [ $i -lt $MAX_RETRIES ]; then
    sleep $RETRY_DELAY
  fi
done

echo "=== Health check failed after $MAX_RETRIES attempts ==="
echo ">>> Container status:"
docker compose ps
echo ">>> Recent logs:"
docker compose logs --tail=100
exit 1
