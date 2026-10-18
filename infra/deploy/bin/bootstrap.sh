#!/usr/bin/env bash
# Unzeen VPS bootstrap (Ubuntu 24.04, run as root once; idempotent: safe to re-run).
#
#   scp -r infra/deploy root@<vps>:/root/unzeen-deploy
#   ssh root@<vps> 'ADMIN_USER=unzeen bash /root/unzeen-deploy/bin/bootstrap.sh'
#
# Does: admin user (sudo, docker) with root's SSH keys; SSH key-only, no root login; ufw 22/80/443;
# unattended security upgrades WITHOUT automatic reboot (a reboot locks the encrypted volume);
# Docker CE + compose plugin with log rotation and live-restore; fail2ban (sshd); journald
# retention; no core dumps; /etc/unzeen skeleton; unzeen-* tools in /usr/local/sbin; monitor timer.
# Does NOT create the encrypted volume (interactive: `unzeen-vault-init`) and prints no secrets.
set -euo pipefail

ADMIN_USER="${ADMIN_USER:-unzeen}"
# Two phases so nobody gets locked out: first run keeps root key login (prohibit-password);
# after a successful login as $ADMIN_USER re-run with DISABLE_ROOT_LOGIN=1.
DISABLE_ROOT_LOGIN="${DISABLE_ROOT_LOGIN:-0}"
APP_UID=10001
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(dirname "$HERE")"

log() { printf '[bootstrap] %s\n' "$*"; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu expected (found ${ID:-unknown})"
[ "${VERSION_ID:-}" = "24.04" ] || log "WARN: tested on Ubuntu 24.04, this is ${VERSION_ID:-?}"
[[ "$ADMIN_USER" =~ ^[a-z][a-z0-9_-]{1,30}$ ]] || die "bad ADMIN_USER"

export DEBIAN_FRONTEND=noninteractive

# ------------------------------------------------------------------ packages
log "apt packages"
apt-get update -qq
apt-get -y -qq upgrade
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg ufw fail2ban unattended-upgrades apt-listchanges \
  cryptsetup e2fsprogs jq git rsync python3 openssl age >/dev/null

# ------------------------------------------------------------------ Docker CE (official repo)
if ! command -v docker >/dev/null 2>&1; then
  log "docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
install -d -m 0755 /etc/docker
# Log rotation for every container; live-restore keeps containers up across dockerd restarts.
# No userland-proxy logs, no metrics endpoint.
cat > /etc/docker/daemon.json.new <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true,
  "userland-proxy": false
}
EOF
if ! cmp -s /etc/docker/daemon.json.new /etc/docker/daemon.json 2>/dev/null; then
  mv /etc/docker/daemon.json.new /etc/docker/daemon.json
  systemctl restart docker
else
  rm -f /etc/docker/daemon.json.new
fi
systemctl enable --now docker >/dev/null

# ------------------------------------------------------------------ admin user + SSH
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  log "user $ADMIN_USER"
  useradd -m -s /bin/bash "$ADMIN_USER"
fi
usermod -aG sudo,docker "$ADMIN_USER"
# Key-only login and no password set: sudo without a password for this user only.
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 0440 "/etc/sudoers.d/90-$ADMIN_USER"
visudo -cq

ADMIN_HOME="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
install -d -m 0700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$ADMIN_HOME/.ssh"
AK="$ADMIN_HOME/.ssh/authorized_keys"
touch "$AK"
if [ -n "${SSH_PUBKEY:-}" ]; then
  grep -qxF "$SSH_PUBKEY" "$AK" || echo "$SSH_PUBKEY" >> "$AK"
fi
if [ -s /root/.ssh/authorized_keys ]; then
  while IFS= read -r k; do
    [ -n "$k" ] && { grep -qxF "$k" "$AK" || echo "$k" >> "$AK"; }
  done < /root/.ssh/authorized_keys
fi
chown "$ADMIN_USER:$ADMIN_USER" "$AK"; chmod 0600 "$AK"

if [ -s "$AK" ]; then
  if [ "$DISABLE_ROOT_LOGIN" = 1 ]; then ROOT_MODE=no; ALLOW="$ADMIN_USER"; else ROOT_MODE=prohibit-password; ALLOW="$ADMIN_USER root"; fi
  log "sshd: key only, PermitRootLogin $ROOT_MODE, AllowUsers $ALLOW"
  cat > /etc/ssh/sshd_config.d/10-unzeen.conf <<EOF
PermitRootLogin $ROOT_MODE
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers $ALLOW
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
  # Ubuntu cloud images ship 50-cloud-init.conf with PasswordAuthentication yes; ours sorts first and wins.
  sshd -t
  systemctl reload ssh || systemctl reload sshd || true
else
  log "WARN: $AK is empty: SSH hardening skipped (would lock you out). Set SSH_PUBKEY and re-run."
fi

# ------------------------------------------------------------------ firewall
log "ufw"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw limit 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
# Docker publishes ports past ufw: compose.yml binds everything except Caddy 80/443 to 127.0.0.1.

# ------------------------------------------------------------------ unattended upgrades, never auto-reboot
log "unattended-upgrades (security only, no automatic reboot)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52unzeen-unattended <<'EOF'
// A reboot locks the encrypted volume (demo down until unzeen-unlock): never reboot automatically.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
// Docker comes from download.docker.com and is not in the allowed origins: upgraded by hand.
EOF
systemctl enable --now unattended-upgrades >/dev/null

# ------------------------------------------------------------------ fail2ban (sshd only)
cat > /etc/fail2ban/jail.d/unzeen.local <<'EOF'
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
EOF
systemctl enable fail2ban >/dev/null
systemctl restart fail2ban

# ------------------------------------------------------------------ logs, dumps, swap
log "journald retention, no core dumps"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/unzeen.conf <<'EOF'
[Journal]
SystemMaxUse=200M
MaxRetentionSec=7day
EOF
systemctl restart systemd-journald
cat > /etc/sysctl.d/60-unzeen.conf <<'EOF'
# Process memory (decrypted seeds, keys) must never land on the unencrypted disk.
kernel.core_pattern=|/bin/false
fs.suid_dumpable=0
vm.swappiness=1
EOF
sysctl -q --system
install -d /etc/systemd/coredump.conf.d
printf '[Coredump]\nStorage=none\nProcessSizeMax=0\n' > /etc/systemd/coredump.conf.d/unzeen.conf
if [ -n "$(swapon --noheadings 2>/dev/null)" ]; then
  log "WARN: swap is active on the unencrypted disk (memory of the services may be written there)."
  log "      Recommended: 'swapoff -a' and remove the swap line from /etc/fstab (16 GB RAM is enough)."
fi

# ------------------------------------------------------------------ Unzeen layout
log "/etc/unzeen, /opt/unzeen, mount point"
install -d -m 0750 -o root -g "$ADMIN_USER" /etc/unzeen
install -d -m 0750 -o root -g "$ADMIN_USER" /etc/unzeen/keys
for inst in devnet mainnet hood; do
  install -d -m 0700 -o "$APP_UID" -g "$APP_UID" "/etc/unzeen/keys/$inst"
done
for f in stack devnet mainnet hood; do
  if [ ! -e "/etc/unzeen/$f.env" ]; then
    install -m 0640 -o root -g "$ADMIN_USER" "$DEPLOY_DIR/env/$f.env.example" "/etc/unzeen/$f.env"
  fi
done
[ "$(stat -c %a /etc/unzeen/stack.env)" = 640 ] && chmod 0644 /etc/unzeen/stack.env
if [ ! -e /etc/unzeen/monitor.env ]; then
  install -m 0600 -o root -g root "$DEPLOY_DIR/env/monitor.env.example" /etc/unzeen/monitor.env
fi
install -d -m 0755 /opt/unzeen /opt/unzeen/releases
install -d -m 0700 /var/lib/unzeen
# Mount point of the encrypted volume. Immutable while unmounted: nothing (Docker included) can
# create directories in it, so a locked volume never turns into plaintext data on the root disk.
install -d -m 0755 /srv/unzeen
if ! mountpoint -q /srv/unzeen; then chattr +i /srv/unzeen 2>/dev/null || true; fi

# ------------------------------------------------------------------ tools + monitor timer
log "tools"
for t in unzeen-vault-init unzeen-unlock unzeen-lock unzeenctl unzeen-monitor; do
  install -m 0755 "$HERE/$t" "/usr/local/sbin/$t"
done
install -m 0644 "$DEPLOY_DIR/systemd/unzeen-monitor.service" /etc/systemd/system/
install -m 0644 "$DEPLOY_DIR/systemd/unzeen-monitor.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now unzeen-monitor.timer >/dev/null

if [ "$DISABLE_ROOT_LOGIN" = 1 ]; then
  log "done. Root SSH login is off. Next: 'ssh -t $ADMIN_USER@<vps> sudo unzeen-vault-init'."
else
  log "done. Check 'ssh $ADMIN_USER@<vps> sudo -n true' in a NEW terminal, then re-run with DISABLE_ROOT_LOGIN=1."
fi
