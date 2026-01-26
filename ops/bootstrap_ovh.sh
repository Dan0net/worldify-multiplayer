#!/bin/bash
set -e

# Worldify OVH VPS Bootstrap Script
# Run this once on a fresh Ubuntu VPS

echo "=== Worldify VPS Bootstrap ==="

# Update system
apt-get update
apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install docker compose plugin
apt-get install -y docker-compose-plugin

# Create deploy user
if ! id "deploy" &>/dev/null; then
  useradd -m -s /bin/bash deploy
  usermod -aG docker deploy
  mkdir -p /home/deploy/.ssh
  cp ~/.ssh/authorized_keys /home/deploy/.ssh/ 2>/dev/null || true
  chown -R deploy:deploy /home/deploy/.ssh
  chmod 700 /home/deploy/.ssh
  chmod 600 /home/deploy/.ssh/authorized_keys 2>/dev/null || true
  echo "deploy ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker-compose" >> /etc/sudoers.d/deploy
fi

# Setup firewall
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Create app directory
mkdir -p /opt/worldify
chown deploy:deploy /opt/worldify

# Copy ops files
cp docker-compose.yml /opt/worldify/
cp Caddyfile /opt/worldify/
chown -R deploy:deploy /opt/worldify

echo "=== Bootstrap complete ==="
echo "Now run: cd /opt/worldify && docker compose up -d"
