#!/bin/bash
set -e

# Worldify OVH VPS Bootstrap Script
# Run this on a fresh Ubuntu VPS. Idempotent - safe to re-run.
# Usage: curl -sL <url>/bootstrap_ovh.sh | sudo bash
#    or: sudo ./bootstrap_ovh.sh

echo "=== Worldify VPS Bootstrap ==="
echo "Host: $(hostname)"
echo "Date: $(date)"

# Must run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo)"
  exit 1
fi

# Update system
echo ">>> Updating system packages..."
apt-get update
apt-get upgrade -y
apt-get install -y curl ufw

# Install Docker if not present
if ! command -v docker &> /dev/null; then
  echo ">>> Installing Docker..."
  curl -fsSL https://get.docker.com | sh
else
  echo ">>> Docker already installed"
fi

# Install docker compose plugin if not present
if ! docker compose version &> /dev/null; then
  echo ">>> Installing docker-compose-plugin..."
  apt-get install -y docker-compose-plugin
else
  echo ">>> Docker Compose already installed"
fi

# Create deploy user if not exists
if ! id "deploy" &>/dev/null; then
  echo ">>> Creating deploy user..."
  useradd -m -s /bin/bash deploy
  usermod -aG docker deploy
  
  # Setup SSH for deploy user
  mkdir -p /home/deploy/.ssh
  if [ -f ~/.ssh/authorized_keys ]; then
    cp ~/.ssh/authorized_keys /home/deploy/.ssh/
  fi
  chown -R deploy:deploy /home/deploy/.ssh
  chmod 700 /home/deploy/.ssh
  chmod 600 /home/deploy/.ssh/authorized_keys 2>/dev/null || true
  
  # Allow deploy user to run docker without password
  echo "deploy ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker compose" > /etc/sudoers.d/deploy
  chmod 440 /etc/sudoers.d/deploy
else
  echo ">>> Deploy user already exists"
  # Ensure deploy user is in docker group
  usermod -aG docker deploy
fi

# Setup firewall (idempotent)
echo ">>> Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
ufw status

# Create app directory
echo ">>> Setting up /opt/worldify..."
mkdir -p /opt/worldify
chown deploy:deploy /opt/worldify

# Copy ops files if running from ops directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  echo ">>> Copying docker-compose.yml..."
  cp "$SCRIPT_DIR/docker-compose.yml" /opt/worldify/
fi
if [ -f "$SCRIPT_DIR/Caddyfile" ]; then
  echo ">>> Copying Caddyfile..."
  cp "$SCRIPT_DIR/Caddyfile" /opt/worldify/
fi
if [ -f "$SCRIPT_DIR/deploy_server.sh" ]; then
  echo ">>> Copying deploy_server.sh..."
  cp "$SCRIPT_DIR/deploy_server.sh" /opt/worldify/
  chmod +x /opt/worldify/deploy_server.sh
fi

chown -R deploy:deploy /opt/worldify

# Enable docker to start on boot
systemctl enable docker

echo ""
echo "=== Bootstrap complete ==="
echo ""
echo "Next steps:"
echo "1. Ensure GitHub Actions secrets are set:"
echo "   - OVH_HOST=vps-95b38492.vps.ovh.net"
echo "   - OVH_SSH_KEY=<private key for deploy user>"
echo "   - GHCR_TOKEN (or use GITHUB_TOKEN)"
echo ""
echo "2. SSH as deploy user and start services:"
echo "   ssh deploy@vps-95b38492.vps.ovh.net"
echo "   cd /opt/worldify"
echo "   docker compose up -d"
echo ""
echo "3. Check health:"
echo "   curl https://api.worldify.xyz/healthz"
