#!/bin/bash

# Worldify GitHub Actions Secrets Setup
# Outputs the secrets you need, or sets them directly via `gh` CLI.
# Usage: ./ops/setup-secrets.sh [--apply]

PROJECT_NAME="worldify"
SSH_KEY_PATH="$HOME/.ssh/${PROJECT_NAME}_vps"
REPO="$(git remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}>>>${NC} $1"; }

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║    GitHub Actions Secrets Setup           ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
echo ""

# Check if we have the SSH key
if [ ! -f "$SSH_KEY_PATH" ]; then
  echo "SSH key not found at $SSH_KEY_PATH"
  echo "Run ./ops/init-vps.sh first to generate it."
  exit 1
fi

# Try to detect VPS host from SSH config
VPS_HOST=$(grep -A1 "Host ${PROJECT_NAME}-vps" ~/.ssh/config 2>/dev/null | grep HostName | awk '{print $2}')
if [ -z "$VPS_HOST" ]; then
  VPS_HOST="<your-vps-hostname>"
fi

echo "Detected repo: $REPO"
echo "VPS host: $VPS_HOST"
echo ""

if [ "$1" == "--apply" ]; then
  # Check for gh CLI
  if ! command -v gh &> /dev/null; then
    echo "GitHub CLI (gh) not found. Install it with:"
    echo "  brew install gh  # macOS"
    echo "  sudo apt install gh  # Ubuntu"
    exit 1
  fi

  # Check if logged in
  if ! gh auth status &> /dev/null; then
    echo "Not logged into GitHub CLI. Run: gh auth login"
    exit 1
  fi

  log "Setting OVH_HOST..."
  echo "$VPS_HOST" | gh secret set OVH_HOST

  log "Setting OVH_SSH_KEY..."
  gh secret set OVH_SSH_KEY < "$SSH_KEY_PATH"

  log "Setting OVH_USER..."
  echo "deploy" | gh secret set OVH_USER

  echo ""
  echo -e "${GREEN}✓ Secrets configured!${NC}"
  echo ""
  echo "Verify with: gh secret list"

else
  # Just print what needs to be set
  echo "You need to set these secrets in GitHub Actions:"
  echo "  Repository → Settings → Secrets and variables → Actions"
  echo ""
  echo -e "${YELLOW}┌─────────────────────────────────────────────────────────┐${NC}"
  echo -e "${YELLOW}│ Secret Name    │ Value                                  │${NC}"
  echo -e "${YELLOW}├─────────────────────────────────────────────────────────┤${NC}"
  echo -e "${YELLOW}│${NC} OVH_HOST       ${YELLOW}│${NC} $VPS_HOST"
  echo -e "${YELLOW}│${NC} OVH_USER       ${YELLOW}│${NC} deploy"
  echo -e "${YELLOW}│${NC} OVH_SSH_KEY    ${YELLOW}│${NC} (contents of private key below)"
  echo -e "${YELLOW}└─────────────────────────────────────────────────────────┘${NC}"
  echo ""
  echo -e "${BLUE}=== OVH_SSH_KEY value (copy everything including BEGIN/END lines) ===${NC}"
  echo ""
  cat "$SSH_KEY_PATH"
  echo ""
  echo -e "${BLUE}=== End of private key ===${NC}"
  echo ""
  echo "Or run with --apply to set secrets automatically via gh CLI:"
  echo "  ./ops/setup-secrets.sh --apply"
  echo ""
fi
