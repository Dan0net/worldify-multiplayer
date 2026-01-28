#!/bin/bash
set -e

# Worldify VPS Initialization Script
# Run this locally to set up a fresh VPS from scratch.
# Usage: ./ops/init-vps.sh <hostname> [ubuntu|root]
#
# Example:
#   ./ops/init-vps.sh vps-95b38492.vps.ovh.net
#   ./ops/init-vps.sh 51.178.42.123 root

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="worldify"
SSH_KEY_NAME="${PROJECT_NAME}_vps"
SSH_KEY_PATH="$HOME/.ssh/$SSH_KEY_NAME"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
error() { echo -e "${RED}✗${NC}  $1"; exit 1; }

# Validate arguments
if [ -z "$1" ]; then
  echo "Usage: $0 <hostname> [initial-user]"
  echo ""
  echo "Arguments:"
  echo "  hostname      VPS hostname or IP address"
  echo "  initial-user  User for initial SSH (default: ubuntu)"
  echo ""
  echo "Example:"
  echo "  $0 vps-95b38492.vps.ovh.net"
  echo "  $0 51.178.42.123 root"
  exit 1
fi

VPS_HOST="$1"
INITIAL_USER="${2:-ubuntu}"

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      Worldify VPS Initialization          ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
echo ""
echo "  Host: $VPS_HOST"
echo "  User: $INITIAL_USER → deploy"
echo ""

# Step 1: Generate SSH key if needed
log "Checking SSH key..."
if [ -f "$SSH_KEY_PATH" ]; then
  echo "    Key exists: $SSH_KEY_PATH"
else
  log "Generating new SSH key..."
  ssh-keygen -t ed25519 -C "$PROJECT_NAME-vps" -f "$SSH_KEY_PATH" -N ""
  echo ""
  echo -e "${YELLOW}Public key (add to VPS authorized_keys or OVH panel):${NC}"
  echo ""
  cat "${SSH_KEY_PATH}.pub"
  echo ""
  read -p "Press Enter after adding the key to the VPS, or Ctrl+C to abort..."
fi

# Step 2: Clear old host keys
log "Clearing old host keys for $VPS_HOST..."
ssh-keygen -f "$HOME/.ssh/known_hosts" -R "$VPS_HOST" 2>/dev/null || true

# Step 3: Add SSH config entry
log "Updating SSH config..."
SSH_CONFIG="$HOME/.ssh/config"
if ! grep -q "Host ${PROJECT_NAME}-vps" "$SSH_CONFIG" 2>/dev/null; then
  cat >> "$SSH_CONFIG" << EOF

# Added by ${PROJECT_NAME} init-vps.sh
Host ${PROJECT_NAME}-vps
  HostName $VPS_HOST
  User deploy
  IdentityFile $SSH_KEY_PATH
  StrictHostKeyChecking accept-new
EOF
  echo "    Added '${PROJECT_NAME}-vps' to ~/.ssh/config"
else
  echo "    SSH config entry already exists"
fi

# Step 4: Copy bootstrap script and run it
log "Copying bootstrap script to VPS..."
scp -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new \
  "$SCRIPT_DIR/bootstrap_ovh.sh" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/Caddyfile" \
  "$SCRIPT_DIR/deploy_server.sh" \
  "${INITIAL_USER}@${VPS_HOST}:/tmp/"

log "Running bootstrap on VPS (this may take a few minutes)..."
ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new \
  "${INITIAL_USER}@${VPS_HOST}" \
  "sudo bash /tmp/bootstrap_ovh.sh"

# Step 5: Copy deploy key to the deploy user
log "Setting up deploy user SSH access..."
ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new \
  "${INITIAL_USER}@${VPS_HOST}" \
  "sudo mkdir -p /home/deploy/.ssh && \
   sudo cp /tmp/*.sh /tmp/*.yml /tmp/Caddyfile /opt/worldify/ 2>/dev/null || true && \
   echo '$(cat ${SSH_KEY_PATH}.pub)' | sudo tee -a /home/deploy/.ssh/authorized_keys > /dev/null && \
   sudo chown -R deploy:deploy /home/deploy/.ssh /opt/worldify && \
   sudo chmod 700 /home/deploy/.ssh && \
   sudo chmod 600 /home/deploy/.ssh/authorized_keys"

# Step 6: Test deploy user connection
log "Testing deploy user connection..."
if ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new \
  "deploy@${VPS_HOST}" "echo 'Connection successful!'" 2>/dev/null; then
  echo -e "    ${GREEN}✓${NC} Can SSH as deploy user"
else
  warn "Could not connect as deploy user - you may need to add the key manually"
fi

# Step 7: Start services
log "Starting services on VPS..."
ssh -i "$SSH_KEY_PATH" "deploy@${VPS_HOST}" \
  "cd /opt/worldify && docker compose pull && docker compose up -d" || \
  warn "Could not start services - you may need to do this manually"

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         VPS Initialization Complete!      ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════╝${NC}"
echo ""
echo "You can now connect with:"
echo "  ssh ${PROJECT_NAME}-vps"
echo ""
echo "Or explicitly:"
echo "  ssh -i $SSH_KEY_PATH deploy@$VPS_HOST"
echo ""
echo "Next step: Set up GitHub Actions secrets"
echo "  ./ops/setup-secrets.sh"
echo ""
