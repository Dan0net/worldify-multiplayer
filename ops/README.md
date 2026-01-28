# Worldify Ops Guide

This guide walks you through setting up a fresh VPS for Worldify from scratch.

## Overview

The deployment stack:
- **VPS**: OVH VPS (Ubuntu)
- **Reverse Proxy**: Caddy (automatic HTTPS)
- **Container Runtime**: Docker + Docker Compose
- **CI/CD**: GitHub Actions

```
┌─────────────────────────────────────────────────────┐
│  Your Machine                                       │
│  └── ops/init-vps.sh ──────────────────────────┐    │
└─────────────────────────────────────────────────│────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────┐
│  VPS (vps-95b38492.vps.ovh.net)                     │
│  ├── Caddy (ports 80/443)                           │
│  │   └── reverse proxy → game-server:3000           │
│  └── game-server (Docker container)                 │
└─────────────────────────────────────────────────────┘
                                                  ▲
                                                  │
┌─────────────────────────────────────────────────│────┐
│  GitHub Actions                                 │    │
│  └── Push to main → Build → Deploy ─────────────┘    │
└─────────────────────────────────────────────────────┘
```

---

## Quick Start (TL;DR)

```bash
# 1. Order a VPS from OVH, get the hostname
# 2. Run the init script
./ops/init-vps.sh vps-XXXXXXXX.vps.ovh.net

# 3. Set up GitHub secrets
./ops/setup-secrets.sh --apply   # or follow manual instructions

# 4. Push to main branch - deployment is automatic!
```

---

## Detailed Setup

### Step 1: Order a VPS

1. Go to [OVH](https://www.ovhcloud.com/en/vps/) and order a VPS
   - Recommended: VPS Starter or Essential (2GB+ RAM)
   - OS: Ubuntu 22.04 or 24.04
   - Add your SSH public key during setup (or we'll handle it in step 2)

2. Note your VPS hostname (e.g., `vps-95b38492.vps.ovh.net`)

### Step 2: Initialize the VPS

Run the init script from your local machine:

```bash
./ops/init-vps.sh vps-95b38492.vps.ovh.net
```

This script will:
- ✅ Generate an SSH key pair (`~/.ssh/worldify_vps`)
- ✅ Clear any old host keys (safe for reinstalled VPS)
- ✅ Add an SSH config entry for easy access
- ✅ Copy and run the bootstrap script on the VPS
- ✅ Set up the `deploy` user with Docker access
- ✅ Configure the firewall (SSH, HTTP, HTTPS only)
- ✅ Start Caddy and the game server

**If your VPS uses `root` instead of `ubuntu`:**
```bash
./ops/init-vps.sh vps-95b38492.vps.ovh.net root
```

### Step 3: Set Up GitHub Actions Secrets

For automated deployments, set up these secrets:

**Option A: Automatic (requires GitHub CLI)**
```bash
./ops/setup-secrets.sh --apply
```

**Option B: Manual**
```bash
./ops/setup-secrets.sh
```
Then copy the values to: Repository → Settings → Secrets → Actions

| Secret | Value |
|--------|-------|
| `OVH_HOST` | Your VPS hostname |
| `OVH_USER` | `deploy` |
| `OVH_SSH_KEY` | Contents of `~/.ssh/worldify_vps` (private key) |

### Step 4: Deploy!

Push to the `main` branch and GitHub Actions will:
1. Build the Docker image
2. Push to GitHub Container Registry
3. SSH to the VPS and pull the new image
4. Restart the container with zero downtime

```bash
git push origin main
```

---

## Manual Operations

### SSH to the VPS

```bash
# Using the SSH config alias
ssh worldify-vps

# Or explicitly
ssh -i ~/.ssh/worldify_vps deploy@vps-95b38492.vps.ovh.net
```

### View logs

```bash
ssh worldify-vps "cd /opt/worldify && docker compose logs -f"
```

### Restart services

```bash
ssh worldify-vps "cd /opt/worldify && docker compose restart"
```

### Manual deploy

```bash
ssh worldify-vps "cd /opt/worldify && ./deploy_server.sh"
```

### Check service health

```bash
curl https://api.worldify.xyz/healthz
```

---

## Files Reference

| File | Description |
|------|-------------|
| `init-vps.sh` | Run locally to set up a fresh VPS |
| `setup-secrets.sh` | Configure GitHub Actions secrets |
| `bootstrap_ovh.sh` | Runs on VPS to install Docker, create users, etc. |
| `docker-compose.yml` | Defines Caddy + game-server services |
| `Caddyfile` | Caddy reverse proxy configuration |
| `deploy_server.sh` | Pulls and restarts the game server |

---

## Troubleshooting

### "Host key verification failed"

The VPS was reinstalled and has a new host key. Fix:
```bash
ssh-keygen -R vps-95b38492.vps.ovh.net
```
Or just re-run `init-vps.sh`.

### "Permission denied (publickey)"

Your SSH key isn't on the VPS. Either:
- Add it via OVH control panel
- Or if you have root access another way, add it to `/home/deploy/.ssh/authorized_keys`

### Container won't start

Check logs:
```bash
ssh worldify-vps "cd /opt/worldify && docker compose logs game-server"
```

### Caddy certificate issues

Check Caddy logs:
```bash
ssh worldify-vps "cd /opt/worldify && docker compose logs caddy"
```

Make sure your domain DNS points to the VPS IP.

---

## Architecture Notes

### Why Caddy?

- Automatic HTTPS with Let's Encrypt
- Simple config
- Built-in reverse proxy
- Handles WebSocket upgrades automatically

### Why a `deploy` user?

- Principle of least privilege
- Can run Docker but limited sudo access
- Separate from root for security

### Why Docker?

- Consistent environment
- Easy rollbacks
- Simple deployment (just pull and restart)

---

## Updating This Setup

If you modify `docker-compose.yml` or `Caddyfile`:

```bash
scp ops/docker-compose.yml ops/Caddyfile worldify-vps:/opt/worldify/
ssh worldify-vps "cd /opt/worldify && docker compose up -d"
```
