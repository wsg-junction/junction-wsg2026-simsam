#!/usr/bin/env bash
# Verda startup script for the simsam instance. Paste into the "Startup script"
# field when creating the instance. Runs as root on first boot; safe to re-run.
# Fill in the three values below. Do NOT put registry secrets here.
set -euo pipefail

DOMAIN="app.example.com"
DEPLOY_USER="ubuntu"
DEPLOY_PUBKEY="ssh-ed25519 AAAA... github-deploy"   # contents of simsam-deploy.pub

# Fall back to root if the image has no ubuntu user.
id "$DEPLOY_USER" >/dev/null 2>&1 || DEPLOY_USER=root
DEPLOY_HOME=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)

# Docker + compose plugin (skipped if the Docker image already has them)
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update && apt-get install -y docker-compose-plugin
fi
systemctl enable --now docker
[ "$DEPLOY_USER" = root ] || usermod -aG docker "$DEPLOY_USER"

# Deploy key for GitHub Actions
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
touch "$DEPLOY_HOME/.ssh/authorized_keys"
grep -qxF "$DEPLOY_PUBKEY" "$DEPLOY_HOME/.ssh/authorized_keys" \
  || echo "$DEPLOY_PUBKEY" >> "$DEPLOY_HOME/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"

# App directory + runtime config (passwords generated once, never overwritten)
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" /opt/simsam
if [ ! -f /opt/simsam/.env ]; then
  printf 'DOMAIN=%s\nDB_PASSWORD=%s\nDB_ROOT_PASSWORD=%s\n' \
    "$DOMAIN" "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" > /opt/simsam/.env
  chown "$DEPLOY_USER:$DEPLOY_USER" /opt/simsam/.env
  chmod 600 /opt/simsam/.env
fi

# Firewall: only SSH, HTTP, HTTPS (only if ufw is installed)
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443
  ufw --force enable
fi
