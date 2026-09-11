import { config } from "../config";
import { storage } from "./storage";
import { DATA_DIR } from "../db";
import { Server, ServerType, ServerAction } from "../types";
import {
  getServerPlans,
  getServerPricing,
  isValidServerType,
  getLocations as getCachedLocations,
  isValidLocation,
  locationsForType,
  isTypeAvailableInLocation,
  type LocationInfo,
} from "./hcloud-types";
import crypto from "crypto";

const HCLOUD_API = "https://api.hetzner.cloud/v1";

/**
 * Validate an OpenSSH public key string before splicing it into cloud-init.
 * Cloud-init runs as root on a fresh box — we MUST NOT let arbitrary input
 * land in the shell heredoc. Any invalid byte → throw, caller turns it into a
 * 400 before the Hetzner API is touched.
 *
 * Allowed key types match what `routes/compute.ts:setup-ssh` already accepts.
 * Stripped to single-line; comment field is allowed (alphanum + . _ - @).
 */
export function assertSshPublicKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length === 0 || trimmed.length > 16384) {
    throw new Error('sshPublicKey must be 1–16384 chars');
  }
  if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(\s+[\w.@-]+)?$/.test(trimmed)) {
    throw new Error("sshPublicKey must be an OpenSSH public key (e.g. 'ssh-ed25519 AAAA... [comment]')");
  }
  return trimmed;
}

/**
 * Bash blocks emitted into cloud-init for each named install recipe.
 *
 * Adding a new recipe is purely additive: pick a slug, drop a bash block here,
 * and the route layer's allowlist + the marker-file check (gate 4 of the CLI's
 * readiness chain) pick it up automatically.
 *
 * Recipe contracts:
 *   - Run as root, non-interactive. `set -euo pipefail` is in effect from the
 *     wrapping cloud-init script — recipes that have steps which can fail
 *     transiently must guard with `|| true` or restart the recipe explicitly.
 *   - DEBIAN_FRONTEND=noninteractive and NEEDRESTART_MODE=a are exported by
 *     the wrapping script.
 *   - Recipes should NOT exit non-zero on cosmetic failures (version probes
 *     etc.) — bubbling those up aborts the rest of cloud-init.
 *   - The wrapping script writes /etc/palmyr/install-status.json on success
 *     so the CLI's wait-for-install gate has a single sentinel to poll.
 *     Per-recipe debug logs are recipe-specific (see below).
 */
const INSTALL_RECIPES: Record<string, { description: string; bash: string }> = {
  // OpenClaw — the original Palmyr default. Installs Node 22 + the openclaw
  // and clawhub npm packages. Writes /etc/openclaw/provision.json for
  // historical compatibility with anything that already keys off it.
  //
  // Defensive choices:
  //   - Each curl|bash and npm install is wrapped in `set +e ... PIPESTATUS`
  //     so we surface the inner exit code rather than letting our outer
  //     `set -e` mask it with a generic abort.
  //   - Tee logs to /var/log/palmyr/openclaw-install.log so the CLI's
  //     diagnostic fetcher has a single known path to tail on failure.
  //   - Use absolute paths everywhere — cloud-init's bash doesn't source
  //     ~/.bashrc, so PATH may not pick up freshly-installed binaries.
  openclaw: {
    description: 'OpenClaw runtime + clawhub skill registry (Node 22)',
    bash: `# ─── Install OpenClaw ───
mkdir -p /var/log/palmyr /etc/openclaw

# Install Node 22. NodeSource's setup script must be allowed to fail loudly,
# but we want the actual install.sh exit code, not bash's pipe propagation.
set +e
curl -fsSL https://deb.nodesource.com/setup_22.x 2>&1 | bash - 2>&1 | tee /var/log/palmyr/openclaw-install.log
NODESOURCE_EXIT=\${PIPESTATUS[0]}
if [ "\${NODESOURCE_EXIT:-1}" -ne 0 ]; then
  echo "ERROR: NodeSource setup script failed (exit=\$NODESOURCE_EXIT)" >&2
  set -e
  exit 1
fi

apt-get install -y -qq nodejs 2>&1 | tee -a /var/log/palmyr/openclaw-install.log
APT_EXIT=\${PIPESTATUS[0]}
if [ "\${APT_EXIT:-1}" -ne 0 ]; then
  echo "ERROR: apt-get install nodejs failed (exit=\$APT_EXIT)" >&2
  set -e
  exit 1
fi

# npm install can take ~60s on a small box; tee the output so the CLI
# diagnostic fetcher can show what happened on failure.
npm install -g openclaw clawhub 2>&1 | tee -a /var/log/palmyr/openclaw-install.log
NPM_EXIT=\${PIPESTATUS[0]}
set -e
if [ "\${NPM_EXIT:-1}" -ne 0 ]; then
  echo "ERROR: npm install -g openclaw clawhub failed (exit=\$NPM_EXIT)" >&2
  exit 1
fi

cat > /etc/openclaw/provision.json << OPENCLAW_PROVISION_EOF
{
  "provisioned_by": "palmyr",
  "provisioned_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "openclaw_installed": true
}
OPENCLAW_PROVISION_EOF

echo "OpenClaw provisioning complete" >> /var/log/palmyr/openclaw-install.log
/usr/bin/openclaw --version >> /var/log/palmyr/openclaw-install.log 2>&1 || true
`,
  },

  // Hermes Agent (Nous Research) — the self-improving AI agent. The official
  // installer at scripts/install.sh handles all platform detection, deps
  // (Python 3.11+ via uv, build-essential, ripgrep, ffmpeg), and creates the
  // /usr/local/bin/hermes symlink when run as root. We pass --skip-setup so
  // the user can configure their model provider after deploy via
  //   palmyr compute exec <id> -- hermes setup
  // or inside an SSH session.
  //
  // Defensive choices (this recipe failed in practice on a fresh deploy):
  //   - Don't reference $HOME under `set -u` — cloud-init may not export it.
  //     The installer always lands at /usr/local/bin/hermes when run as
  //     root + Linux + non-Termux (the only path we hit in cloud-init).
  //   - Wrap the curl|bash in `set +e` and capture PIPESTATUS[0], so the
  //     real install.sh exit code is surfaced, not bash's pipe noise.
  //   - tee output (don't just redirect) so the install log is visible
  //     in /var/log/cloud-init-output.log too — easier post-mortem.
  //   - Probe with the absolute path (/usr/local/bin/hermes), not a PATH
  //     lookup. cloud-init bash doesn't have ~/.bashrc sourced, and even
  //     though /usr/local/bin is in the default PATH, being explicit
  //     removes one source of doubt.
  hermes: {
    description: 'Hermes Agent (Nous Research) — self-improving AI agent runtime',
    bash: `# ─── Install Hermes Agent ───
mkdir -p /var/log/palmyr

# install.sh sets its own \`set -e\` and handles platform detection internally.
# We disable our outer \`set -e\` only around the curl|bash + tee chain so
# PIPESTATUS gives us the real exit code instead of tee's success.
set +e
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh 2>&1 \\
  | bash -s -- --skip-setup 2>&1 \\
  | tee /var/log/palmyr/hermes-install.log
INSTALL_EXIT=\${PIPESTATUS[1]}
set -e

# Probe the canonical root-FHS path. The installer only uses ~/.local/bin
# when running as a non-root user; in cloud-init we're always root.
if [ ! -x /usr/local/bin/hermes ]; then
  echo "ERROR: hermes binary not at /usr/local/bin/hermes after install (install.sh exit=\$INSTALL_EXIT)" >&2
  echo "--- last 80 lines of /var/log/palmyr/hermes-install.log ---" >&2
  tail -80 /var/log/palmyr/hermes-install.log >&2 || true
  exit 1
fi

# --version is a sanity check, not load-bearing. If a future Hermes release
# changes its CLI, don't abort the whole install over it.
/usr/local/bin/hermes --version > /var/log/palmyr/hermes-version.log 2>&1 || true
`,
  },
};

export function listInstallRecipes(): Array<{ name: string; description: string }> {
  return Object.entries(INSTALL_RECIPES).map(([name, r]) => ({ name, description: r.description }));
}

export function isKnownRecipe(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(INSTALL_RECIPES, name);
}

/**
 * Build a cloud-init `user_data` script.
 *
 * Always emits the security-hardening preamble (sshd config, UFW, unattended
 * upgrades). Then runs each install recipe in `installs` in the order given.
 * Finally writes `/etc/palmyr/install-status.json` so the CLI's gate-4
 * readiness check has a single file to poll.
 *
 * Caller is responsible for validating that every entry in `installs` is in
 * `INSTALL_RECIPES` (the route layer does this so the 400 surfaces cleanly).
 */
function generateCloudInit(opts: { userPubkey?: string; installs: string[] }): string {
  const platformPubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAeOkVwRfQpLUemQ6HwbglAPjv1WioahHED/SXSaK7r+ palmyr-platform-temp';
  // userPubkey was already validated by the route layer via assertSshPublicKey;
  // it cannot contain shell metacharacters by construction. We still wrap it in
  // single quotes so the worst-case typo doesn't break the heredoc.
  const userKeyLine = opts.userPubkey
    ? `echo '${opts.userPubkey}' >> /root/.ssh/authorized_keys`
    : '# (no user public key provided at deploy time — call POST /compute/servers/:id/setup-ssh to inject one)';

  const recipeBlocks = opts.installs
    .map(name => INSTALL_RECIPES[name]?.bash ?? `# (unknown recipe '${name}' — skipping; route layer should have rejected this before generateCloudInit)`)
    .join('\n');

  const installsJsonArray = JSON.stringify(opts.installs);

  return `#!/bin/bash
# Deliberate: 'set -eo pipefail' (not -u). cloud-init doesn't always export
# HOME or other vars our recipes reference, and an unbound-variable abort
# masks the real failure with a confusing "HOME: unbound" message. Recipes
# that want stricter hygiene set their own 'set -u' locally.
set -eo pipefail

# Suppress apt's interactive prompts and the needrestart noise that would
# otherwise pause cloud-init for "which services should I restart?" dialogs.
# Also ensure HOME is set — some Hermes/installer code paths fall back to it
# even when running as root, and cloud-init's user_data shell sometimes
# inherits an empty HOME.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export HOME="\${HOME:-/root}"

# Make every step's stdout/stderr land in the cloud-init log AND a file we
# control so the CLI's diagnostic fetcher has a deterministic path to tail
# regardless of which Hetzner image variant we're on.
mkdir -p /var/log/palmyr
exec > >(tee -a /var/log/palmyr/cloud-init.log) 2>&1
echo "[palmyr] cloud-init user_data starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── Security Hardening ───
# Inject platform temp key for provisioning (removed during SSH handoff)
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo '${platformPubKey}' >> /root/.ssh/authorized_keys
${userKeyLine}
chmod 600 /root/.ssh/authorized_keys

# Clear Hetzner's forced password change (blocks SSH key auth otherwise)
chage -d "$(date +%Y-%m-%d)" root 2>/dev/null || true
passwd -u root 2>/dev/null || true

# Disable password auth but allow pubkey
sed -i 's/#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/#\\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true

# Firewall. apt update can fail transiently on a fresh box (mirror DNS races,
# dpkg locks) — try twice before giving up so we don't abort cloud-init over
# a one-shot transient.
apt-get update -qq || (sleep 5 && apt-get update -qq)
apt-get install -y -qq ufw unattended-upgrades
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo 'Unattended-Upgrade::Allowed-Origins { "\${distro_id}:\${distro_codename}-security"; };' > /etc/apt/apt.conf.d/50unattended-upgrades-local

echo "[palmyr] preamble done, starting recipes: ${JSON.stringify(opts.installs)}"

${recipeBlocks}

# ─── Palmyr install marker ───
# The CLI's deploy --wait readiness chain polls this file as gate 4 when the
# user requested any install. Single sentinel; absent → CLI surfaces a
# "install did not complete" timeout; present → CLI returns ready: true.
mkdir -p /etc/palmyr
cat > /etc/palmyr/install-status.json << PALMYR_INSTALL_EOF
{
  "installs": ${installsJsonArray},
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "ok"
}
PALMYR_INSTALL_EOF
echo "[palmyr] cloud-init complete"
`;
}

function headers() {
  return {
    Authorization: `Bearer ${config.hcloudToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Typed Hetzner API failure. `code` is Hetzner's machine-readable error code
 * (`resource_unavailable`, `resource_limit_exceeded`, `uniqueness_error`, ...)
 * so route handlers can map failures to the right HTTP status + agent-readable
 * guidance instead of forwarding a raw JSON blob inside a 502.
 */
export class HcloudApiError extends Error {
  status: number;
  code: string | null;
  hcloudMessage: string | null;

  constructor(method: string, path: string, status: number, bodyText: string) {
    let code: string | null = null;
    let msg: string | null = null;
    try {
      const parsed = JSON.parse(bodyText);
      code = parsed?.error?.code ?? null;
      msg = parsed?.error?.message ?? null;
    } catch {
      // non-JSON body — keep the raw text in the Error message below
    }
    super(`Hetzner API ${method} ${path} failed (${status}): ${msg || bodyText}`);
    this.status = status;
    this.code = code;
    this.hcloudMessage = msg;
  }
}

async function hcloud(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${HCLOUD_API}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HcloudApiError(method, path, res.status, text);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Platform-capacity circuit breaker ─────────────────────────
//
// `resource_limit_exceeded` (e.g. "Primary IP limit exceeded") is OUR Hetzner
// project hitting an account-wide quota — every deploy will fail identically
// until ops raises the limit or a server is deleted. Once we've seen it,
// fail deploys BEFORE payment for a cool-off window instead of charging each
// agent $6 just to refund them seconds later.

const CAPACITY_COOLOFF_MS = 10 * 60 * 1000;
let capacityErrorAt = 0;

export function notePlatformCapacityError(): void {
  capacityErrorAt = Date.now();
}

export function clearPlatformCapacityError(): void {
  capacityErrorAt = 0;
}

/** Seconds until deploys should be retried, or 0 when the breaker is closed. */
export function platformCapacityRetryAfterSeconds(): number {
  const remaining = capacityErrorAt + CAPACITY_COOLOFF_MS - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * Create a server on Hetzner Cloud.
 *
 * SSH access model:
 *   - `sshKeyIds`: numeric IDs of keys already uploaded via `POST /compute/ssh-keys`.
 *     Hetzner injects these into `authorized_keys` *before* cloud-init runs.
 *   - `sshPublicKey`: a raw OpenSSH public key string. Spliced into cloud-init so
 *     it lands in `authorized_keys` while we're already touching the file there.
 *     Validated by `assertSshPublicKey` at the route boundary; do not pass
 *     untrusted input straight to this argument.
 *   - `installs`: list of named install recipes from `INSTALL_RECIPES`. When
 *     non-empty, cloud-init runs and disables password auth — the password
 *     Hetzner returns is then useless after first boot. Caller must hand in
 *     a key (`sshKeyIds` or `sshPublicKey`), or use `setup-ssh` after the
 *     fact, or accept that they'll only access the box through the
 *     Palmyr-managed APIs.
 *
 * `passwordUsable` in the return payload is the source of truth for the route
 * layer: false → strip `rootPassword` from the API response, surface handoff
 * guidance instead.
 */
export async function createServer(
  name: string,
  serverType: ServerType,
  image: string,
  owner: string,
  sshKeyIds?: number[],
  installs?: string[],
  location?: string,
  sshPublicKey?: string
): Promise<Server & { passwordUsable: boolean; installs: string[] }> {
  if (!isValidServerType(serverType)) {
    const valid = getServerPlans().map(p => p.type).join(", ");
    throw new Error(`Unknown or deprecated server type '${serverType}'. Valid types right now: ${valid}`);
  }
  const pricing = getServerPricing()[serverType] ?? "0.00";

  // Sanitize and validate the install list. Dedup, drop empty strings, then
  // bail on anything outside the allowlist — we don't want shell snippets
  // we didn't author landing in cloud-init.
  const resolvedInstalls = Array.from(new Set((installs ?? []).filter(s => typeof s === 'string' && s.length > 0)));
  for (const r of resolvedInstalls) {
    if (!isKnownRecipe(r)) {
      const known = Object.keys(INSTALL_RECIPES).join(', ');
      throw new Error(`Unknown install recipe '${r}'. Known recipes: ${known}`);
    }
  }

  const payload: any = {
    name,
    server_type: serverType,
    // Hetzner takes either an image slug ("ubuntu-24.04") or a numeric image
    // id. Restoring a lapsed server passes the snapshot id, which arrives here
    // as a string, and the API rejects a numeric-looking slug — so coerce.
    image: /^\d+$/.test(image) ? Number(image) : image,
    location: location || config.hcloudLocation,
    labels: { managed_by: "palmyr" },
  };

  if (sshKeyIds?.length) {
    payload.ssh_keys = sshKeyIds;
  }

  // Validate before we touch any external API. assertSshPublicKey throws on
  // shell-metachar input — caller must turn that into a 400.
  const safeUserKey = sshPublicKey ? assertSshPublicKey(sshPublicKey) : undefined;

  if (resolvedInstalls.length > 0) {
    payload.user_data = generateCloudInit({ userPubkey: safeUserKey, installs: resolvedInstalls });
  }

  const data = await hcloud("POST", "/servers", payload);
  const s = data.server;

  // A successful create proves the account-wide quota has headroom again.
  clearPlatformCapacityError();

  // Cloud-init disables password auth — once it runs, the password Hetzner
  // returned is no good. Tell the caller so they don't ship it to the user.
  const passwordUsable = resolvedInstalls.length === 0;

  const server: Server = {
    id: String(s.id),
    name: s.name,
    serverType,
    image,
    status: s.status,
    ipv4: s.public_net?.ipv4?.ip ?? null,
    ipv6: s.public_net?.ipv6?.ip ?? null,
    owner,
    priceMonthly: pricing,
    createdAt: s.created,
    // We always store the password locally — `setup-ssh` uses its presence as
    // a "pre-handoff" sentinel. The route layer decides whether to expose it
    // to the API caller based on `passwordUsable`.
    rootPassword: data.root_password ?? null,
  };

  storage.setServer(server.id, server);
  return { ...server, passwordUsable, installs: resolvedInstalls };
}

/**
 * Snapshot a server's disk and return the new image id.
 *
 * Used by the lapse ladder before it destroys a server whose billing period
 * ran out: Hetzner keeps charging for a merely powered-off box, so stopping
 * the bleed means deleting it — and deleting it without a snapshot would turn
 * a missed renewal into permanent data loss. The snapshot costs ~EUR0.011/GB/mo
 * and is what `POST /compute/servers/:id/restore` rebuilds from.
 */
export async function createSnapshot(id: string, description: string): Promise<string> {
  const data = await hcloud("POST", `/servers/${id}/actions/create_image`, {
    type: "snapshot",
    description,
    labels: { managed_by: "palmyr", reason: "lapsed" },
  });
  const imageId = data?.image?.id;
  if (!imageId) throw new Error(`Hetzner returned no image id for snapshot of server ${id}`);
  return String(imageId);
}

/** Delete a snapshot/image by id. Used to GC retained snapshots. */
export async function deleteImage(imageId: string): Promise<void> {
  await hcloud("DELETE", `/images/${imageId}`);
}

/**
 * Delete / terminate a server.
 */
export async function deleteServer(id: string): Promise<void> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);

  await hcloud("DELETE", `/servers/${id}`);
  storage.deleteServer(id);
}

/**
 * Does this server still exist at Hetzner?
 *
 * Our `servers` table outlives the boxes in it — several rows point at servers
 * deleted directly in the Hetzner console, and one still reads "running" years
 * after the box went away. The lapse ladder consults this before it acts, so a
 * stale row is reconciled quietly instead of mailing its owner about a server
 * that no longer exists and then retrying a poweroff against a 404 forever.
 *
 * Only a definitive 404 answers false; any other failure (network, 5xx, auth)
 * rethrows, because treating an outage as "the server is gone" would strand
 * live servers.
 */
export async function serverExistsAtProvider(id: string): Promise<boolean> {
  try {
    await hcloud("GET", `/servers/${id}`);
    return true;
  } catch (err) {
    if (err instanceof HcloudApiError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Destroy the box at Hetzner but KEEP the local row.
 *
 * The lapse ladder needs the record to survive termination — it holds the
 * snapshot id the owner restores from, and the terminated_at that tells
 * `GET /compute/servers` to report the server as recoverable rather than
 * simply vanishing. `deleteServer` (the owner-initiated destroy) drops the row
 * because that one really is final.
 */
export async function destroyServerAtProvider(id: string): Promise<void> {
  await hcloud("DELETE", `/servers/${id}`);
}

/**
 * Get server status (refreshes from Hetzner API).
 */
export async function getServer(id: string): Promise<Server> {
  const local = storage.getServer(id);
  if (!local) throw new Error(`Server ${id} not found`);

  try {
    const data = await hcloud("GET", `/servers/${id}`);
    const s = data.server;
    local.status = s.status;
    local.ipv4 = s.public_net?.ipv4?.ip ?? local.ipv4;
    local.ipv6 = s.public_net?.ipv6?.ip ?? local.ipv6;
    storage.setServer(id, local);
  } catch {
    // Return cached data if API is unreachable
  }

  return local;
}

/**
 * List all servers for a given owner (or all if no owner specified).
 */
export async function listServers(owner?: string): Promise<Server[]> {
  return storage.listServers(owner);
}

// ── SSH Key Management ────────────────────────────────────────

export async function uploadSshKey(name: string, publicKey: string): Promise<number> {
  const data = await hcloud("POST", "/ssh_keys", { name, public_key: publicKey });
  return data.ssh_key.id;
}

export async function listSshKeys(): Promise<any[]> {
  const data = await hcloud("GET", "/ssh_keys");
  return data.ssh_keys;
}

export async function deleteSshKey(id: number): Promise<void> {
  await hcloud("DELETE", `/ssh_keys/${id}`);
}

// ── Server Actions ────────────────────────────────────────────

export async function serverAction(id: string, action: ServerAction, image?: string): Promise<any> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);

  const body: any = {};
  if (action === "rebuild") {
    body.image = image || server.image || "ubuntu-24.04";
  }

  const data = await hcloud("POST", `/servers/${id}/actions/${action}`, body);

  // reset_password is the only action besides create that hands back a usable
  // root password. Persist it so `compute setup-ssh`'s pre-handoff sentinel
  // (root_password != null in the DB) still works after a password rotation,
  // and so a follow-up `compute info` can show the current password.
  if (action === "reset_password" && data.root_password) {
    server.rootPassword = data.root_password;
    storage.setServer(id, server);
  }

  // Hetzner returns auxiliary fields alongside the action object on a couple
  // of action endpoints (root_password on reset_password, wss_url + password
  // on request_console). Forwarding the whole top-level response — instead
  // of just `data.action` — lets the route layer surface those fields
  // without us having to special-case here.
  return data;
}

/**
 * Run a single command on a freshly-deployed server via the platform's
 * temporary SSH key. Pre-handoff only: once `setup-ssh` has run, the platform
 * key is gone and `root_password` is NULL in the DB — caller gets 410 from
 * the route layer in that state.
 *
 * `command` and `args` are passed as separate argv elements through ssh's
 * remote-shell layer. We POSIX-quote each element on this side so the remote
 * shell sees them as distinct words; we never let user-supplied bytes
 * interpolate into our own shell.
 */
// Per-server known_hosts, mirroring routes/compute.ts `hostKeyFile()` EXACTLY so
// the pin is shared with the route-level sshCmd: DATA_DIR/server-known-hosts/
// <id>.known_hosts, StrictHostKeyChecking=yes once a key is pinned (reject
// mismatch), accept-new (TOFU) until then. NEVER StrictHostKeyChecking=no — this
// path runs commands on the box and must not blindly trust an impersonated host.
function serverKnownHosts(serverId: string): { file: string; strict: string } {
  const path = require("path");
  const fs = require("fs");
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(serverId))) throw new Error("Invalid server id");
  const dir = path.join(DATA_DIR, "server-known-hosts");
  const file = path.join(dir, `${serverId}.known_hosts`);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* created lazily by ssh */ }
  let pinned = false;
  try { pinned = fs.statSync(file).size > 0; } catch { pinned = false; }
  return { file, strict: pinned ? "yes" : "accept-new" };
}

export async function execOnServer(
  id: string,
  command: string,
  args: string[],
  opts: { timeoutSec?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);
  if (!server.ipv4) throw new Error(`Server ${id} has no public IPv4 yet`);

  const { spawnSync } = await import("child_process");
  const PLATFORM_KEY = "/root/.ssh/id_ed25519_platform";
  const timeoutSec = Math.max(1, Math.min(120, opts.timeoutSec ?? 30));

  // POSIX shell-quote every argv element. Single-quote-wrap and escape
  // embedded single quotes via the standard `'\''` trick. Anything that
  // matches our safe-char set is passed through bare — purely cosmetic, the
  // semantics are identical.
  const quote = (s: string): string => {
    if (/^[A-Za-z0-9._/:@%+=-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  };
  const remoteCmd = [command, ...args].map(quote).join(" ");

  // -q (quiet) + -T (no PTY): same defensive flags as the CLI's
  // sshProbe/sshRun. Without these, a remote login shell can leak
  // "tcsetattr: Inappropriate ioctl for device" + "logout" through stderr
  // (issue #85). Non-interactive ssh doesn't need a tty.
  const pin = serverKnownHosts(id);
  const r = spawnSync(
    "ssh",
    [
      "-i", PLATFORM_KEY,
      "-q",
      "-T",
      "-o", `StrictHostKeyChecking=${pin.strict}`,
      "-o", `UserKnownHostsFile=${pin.file}`,
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${Math.min(15, timeoutSec)}`,
      `root@${server.ipv4}`,
      remoteCmd,
    ],
    { timeout: timeoutSec * 1000, stdio: "pipe", maxBuffer: 1024 * 1024 },
  );

  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    // status === null when the process was killed by timeout; surface that as
    // 124 (the conventional `timeout(1)` exit code) rather than `null`.
    exitCode: r.status === null ? 124 : r.status,
    durationMs: 0, // route layer fills this from a wall-clock measurement
  };
}

export async function resizeServer(id: string, serverType: ServerType, upgradeDisk: boolean = false): Promise<any> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);

  // Server must be off to resize
  const data = await hcloud("POST", `/servers/${id}/actions/change_type`, {
    server_type: serverType,
    upgrade_disk: upgradeDisk,
  });

  // Update local record
  const pricing = getServerPricing()[serverType];
  if (pricing) {
    server.serverType = serverType;
    server.priceMonthly = pricing;
    storage.setServer(id, server);
  }

  return data.action;
}

// ── Deploy / renewal pricing ──────────────────────────────────
//
// Flat fallback when a type's live price can't be resolved (catalog in static
// fallback mode, or an unrecognized type slipped through). Matches the historic
// deploy price so we never charge $0 or throw at the paywall.
export const DEPLOY_PRICE_FALLBACK_USDC = 6.0;

/**
 * Resolve the current price for a server type from the live plan catalog.
 *
 * The single source of truth for what a box costs, used by the deploy paywall,
 * the renew/restore paywall, AND the expiry notice. They have to agree: the
 * catalog tracks Hetzner, so a type's price drifts over time (cpx32 went
 * $25 -> $63), and quoting a tenant the price they paid months ago while the
 * paywall charges today's would be its own bug.
 *
 * `plans` is injectable for tests.
 */
export function priceForServerType(
  serverType: string,
  plans: { type: string; priceUsdc: string | number }[] = getServerPlans(),
): number {
  const plan = plans.find(p => p.type === serverType);
  const n = plan ? Number(plan.priceUsdc) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEPLOY_PRICE_FALLBACK_USDC;
}

export function getPlans(opts: { location?: string } = {}) {
  const all = getServerPlans();
  const filtered = opts.location
    ? all.filter(p => isTypeAvailableInLocation(p.type, opts.location!))
    : all;
  return filtered.map(p => ({
    type: p.type,
    vcpu: p.vcpu,
    ramGb: p.ram,
    diskGb: p.disk,
    trafficTb: p.traffic,
    arch: p.arch,
    priceUsdc: p.priceUsdc,
    priceUsdcMonthly: p.priceUsdc,
    /** Where this type is currently deployable. Pulled live from /v1/datacenters. */
    availableLocations: locationsForType(p.type),
  }));
}

/** Public list of Hetzner locations + per-location server-type availability. */
export function getLocations(): LocationInfo[] {
  return getCachedLocations();
}

// Re-exports so route code can stay on the `computeService.*` namespace
// instead of pulling from two different services.
export {
  isValidLocation,
  isTypeAvailableInLocation,
  isTypeSupportedInLocation,
  locationsForType,
  pickAvailableSubstitute,
  ensureFreshAvailability,
  hasLocationData,
  isValidServerType,
  getServerPlans,
} from "./hcloud-types";

/**
 * Hetzner's hostname rules per their docs: lowercase RFC 1123 hostname, up
 * to 253 chars, only letters / digits / hyphens / dots, must start and end
 * with an alphanumeric. Lowercase-only is enforced at the API layer (Hetzner
 * forbids uppercase to prevent ambiguous DNS resolution between Server1 and
 * server1). We validate before the API call so a bad name fails pre-payment
 * with a clear message instead of bouncing off Hetzner's 422 — saves $6.
 */
export function assertServerName(name: unknown, field: string = 'name'): string {
  if (typeof name !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name)) {
    throw new Error(
      `${field} must be lowercase RFC 1123: 1–253 chars of [a-z0-9.-], starting and ending alphanumeric, no uppercase or underscores. Got: ${JSON.stringify(name)}`
    );
  }
  return name;
}

/**
 * Rename a server via Hetzner's PUT /servers/:id. Metadata-only; doesn't
 * cycle the box. Local DB record is updated on success so the cached name
 * stays consistent with Hetzner.
 */
export async function renameServer(id: string, newName: string): Promise<Server> {
  const server = storage.getServer(id);
  if (!server) throw new Error(`Server ${id} not found`);
  assertServerName(newName);

  const data = await hcloud("PUT", `/servers/${id}`, { name: newName });
  const updated: Server = {
    ...server,
    name: data.server?.name ?? newName,
  };
  storage.setServer(id, updated);
  return updated;
}
