import { Router, Request, Response, NextFunction } from "express";
import { join as joinPath } from "path";
import * as nodeFs from "fs";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { AuthenticatedRequest, ServerAction } from "../types";
import * as computeService from "../services/compute";
import { HcloudApiError, priceForServerType } from "../services/compute";
import { refundAndRespond } from "../services/refund";
import {
  extendPaidThrough,
  clearLapseState,
  lifecycleView,
} from "../services/compute-lifecycle";
import { storage } from "../services/storage";
import { config } from "../config";
import { db, DATA_DIR, SERVER_BILLING_DAYS } from "../db";

const router = Router();

/**
 * Ownership guard for /servers/:id routes. Runs AFTER requireAuth so the
 * caller's identity (req.agentId / req.payment.payer) is resolved exactly as it
 * was at create time (POST /servers stores that same expression as `owner`).
 * 404s — not 403s — on mismatch so we don't leak that a server ID exists.
 * Without this any paying wallet could exec on / read root passwords of /
 * push wallet keys to / delete another tenant's server by guessing its ID.
 */
function requireServerOwner(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const caller = req.agentId || req.payment?.payer || "unknown";
  const serverId = String(req.params.id);
  const row = db.prepare("SELECT owner FROM servers WHERE id = ?").get(serverId) as { owner?: string } | undefined;
  if (!row || row.owner !== caller) {
    res.status(404).json({ error: "Server Not Found", message: `No server with ID ${serverId}` });
    return;
  }
  next();
}

const PLATFORM_KEY = '/root/.ssh/id_ed25519_platform';

// ── Per-server SSH host-key pinning ───────────────────────────
//
// Every platform→VPS SSH/SCP call in this file ships secrets to the box:
// wallet signing keys (configure-wallet), the model API key (configure-openclaw),
// the user's authorized_keys (setup-ssh). sshCmd() previously used
// `StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`, i.e. it blindly
// trusted whatever host answered on the recorded IPv4 and pinned nothing — so an
// on-path attacker, or someone who raced/acquired a recycled Hetzner IP, could
// impersonate the server and harvest those secrets (audit finding #21).
//
// Fix: pin the host key PER SERVER, keyed by the Hetzner SERVER ID (never the
// IP — Hetzner recycles IPv4s, so an IP-keyed pin would either falsely reject a
// reused IP or silently inherit a previous tenant's entry). The pin lives in a
// per-server known_hosts file under DATA_DIR (persists across reboots/redeploys,
// gitignored). Connection policy:
//   • pin present → StrictHostKeyChecking=yes        (reject any non-matching key)
//   • pin absent  → StrictHostKeyChecking=accept-new (TOFU: record the key now,
//                    reject on any later change)
// The pin is cleared on create, rebuild and delete (clearHostKeyPin) so a fresh
// OS install or a recycled IP re-establishes a fresh pin instead of being
// wrongly rejected — and a stale entry can never accept the wrong host.
//
// RESIDUAL RISK (documented per the audit's accepted fallback): when the
// create-time capture (captureHostKeyPin via ssh-keyscan) can't reach the
// still-booting box, the FIRST platform→VPS connection is trust-on-first-use,
// so an attacker positioned at exactly that instant could be pinned. Every
// connection AFTER the pin exists is strict-rejected on mismatch. Hetzner Cloud
// does not expose the host key over its authenticated API, so a fully
// authenticated create-time capture is not achievable here.
const HOST_KEY_DIR = joinPath(DATA_DIR, 'server-known-hosts');

/** Per-server known_hosts path. The server id is sanitized to a safe filename. */
export function hostKeyFile(serverId: string): string {
  const id = String(serverId);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw new Error('Invalid server id');
  return joinPath(HOST_KEY_DIR, `${id}.known_hosts`);
}

/** Reject anything that isn't a bare IPv4/IPv6 literal before it reaches a shell. */
function assertIpAddr(ip: unknown): string {
  if (typeof ip !== 'string' || !/^[0-9A-Fa-f:.]{3,45}$/.test(ip)) {
    throw new Error('Invalid server IP address');
  }
  return ip;
}

/** Drop a server's pin so the next connect re-establishes one (create/rebuild/delete). */
export function clearHostKeyPin(serverId: string): void {
  try { nodeFs.rmSync(hostKeyFile(serverId), { force: true }); } catch { /* best effort */ }
}

/**
 * Best-effort capture of the box's host key into its pin file via ssh-keyscan.
 * Returns true if a key was pinned. Called (non-blocking) at create time to
 * shrink the TOFU window; the box is usually still booting (~60s) so this is
 * allowed to fail — the first real connect then pins via accept-new.
 */
function captureHostKeyPin(serverId: string, ip: string): boolean {
  try {
    assertIpAddr(ip);
    const file = hostKeyFile(serverId);
    nodeFs.mkdirSync(HOST_KEY_DIR, { recursive: true });
    const { execSync } = require('child_process');
    const out = String(execSync(`ssh-keyscan -T 8 -t ed25519,rsa,ecdsa ${ip}`, {
      timeout: 12000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }) || '');
    const lines = out.split('\n').filter((l: string) => l.trim() && !l.startsWith('#'));
    if (lines.length === 0) return false;
    nodeFs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** Build SSH command — platform-key auth with a per-server PINNED host key.
 *
 * `-q` (quiet) suppresses ssh's MOTD/banner chatter; `-T` refuses pseudo-tty
 * allocation so the remote bash never tries to set terminal modes (issue #85
 * symptom: "tcsetattr: Inappropriate ioctl for device" + "logout" leaking
 * through stderr from a remote login shell).
 *
 * Host identity is pinned per server id (see the host-key pinning note above)
 * — NEVER `StrictHostKeyChecking=no`. `serverId` is required so every call site
 * is forced through the pin.
 */
export function sshCmd(ip: string, serverId: string): string {
  assertIpAddr(ip);
  const file = hostKeyFile(serverId);
  try { nodeFs.mkdirSync(HOST_KEY_DIR, { recursive: true }); } catch { /* created lazily by ssh */ }
  let pinned = false;
  try { pinned = nodeFs.statSync(file).size > 0; } catch { pinned = false; }
  const strict = pinned ? 'yes' : 'accept-new';
  return `ssh -i ${PLATFORM_KEY} -q -T -o StrictHostKeyChecking=${strict} -o UserKnownHostsFile=${file} -o ConnectTimeout=15 -o PasswordAuthentication=no root@${ip}`;
}

/**
 * Reject any user-provided string that isn't a simple identifier-like token.
 * Anything that will be interpolated into a remote shell command must pass this.
 * Pattern: alphanum, dot, underscore, hyphen — no slashes, no quotes, no `$`, no spaces.
 */
function assertIdent(s: unknown, field: string): string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(s)) {
    throw new Error(`Invalid ${field}: must be 1-128 chars of [A-Za-z0-9._-]`);
  }
  return s;
}

/** Reject git URLs that aren't a plain https URL of host/path-safe characters.
 *
 * The validated value is interpolated UNQUOTED into a remote `git clone`
 * command that ssh hands to the VPS's shell, so the allowlist must exclude
 * EVERY shell metacharacter — including ones (`;`, `&`, `'`, `(`, `)`, `*`,
 * `!`) that sit harmlessly inside our LOCAL double quotes but are re-interpreted
 * by the REMOTE shell (audit finding #46: the old class permitted `; & ' ( ) *`
 * etc., so `https://a.com/r.git;reboot` slipped through). Restrict to the
 * characters actually legal in a git https host/path: alphanumerics and
 * `. _ ~ : / @ % -`. No spaces, no quotes, no `$`/backtick/backslash.
 */
export function assertGitUrl(s: unknown): string {
  if (typeof s !== 'string' || !/^https:\/\/[A-Za-z0-9._~:/@%-]{1,512}$/.test(s)) {
    throw new Error('Invalid git URL: must be a plain https URL with no shell metacharacters');
  }
  return s;
}

/**
 * Write arbitrary bytes to a remote path via base64 — safe because base64 output
 * is [A-Za-z0-9+/=] only, which cannot contain shell metacharacters.
 */
function sshWriteFile(ssh: string, remotePath: string, content: string, opts: { chmod?: string; append?: boolean; timeout?: number } = {}): void {
  const { execSync } = require('child_process');
  assertIdent(remotePath.split('/').pop() || '', 'remotePath basename');
  // Path itself must not contain shell metachars. We assert a restrictive allowlist.
  if (!/^\/[A-Za-z0-9._\/-]{1,512}$/.test(remotePath)) {
    throw new Error('Invalid remote path');
  }
  const b64 = Buffer.from(content).toString('base64');
  const op = opts.append ? '>>' : '>';
  const chmod = opts.chmod ? ` && chmod ${assertIdent(opts.chmod, 'chmod').toString()} ${remotePath}` : '';
  execSync(`${ssh} "echo '${b64}' | base64 -d ${op} ${remotePath}${chmod}"`, { timeout: opts.timeout ?? 15000 });
}

// ── Deploy pricing ────────────────────────────────────────────

// The canonical resolver lives in the service layer — the lapse ladder needs it
// too, and a second copy could drift from the one the paywall charges.
// Re-exported here because it has always been part of this module's surface
// (compute-hardening.test.ts imports it from the route).
export { priceForServerType };

/**
 * x402 pricer for POST /compute/servers. Reads the RESOLVED serverType from the
 * body — validateCreateServerBody runs first and may have substituted a
 * different/larger type, so this automatically re-prices the substitute: the
 * 402 the caller is quoted (and pays) reflects the box they will actually get.
 */
export function deployPriceForRequest(req: Request): number {
  return priceForServerType(String((req as AuthenticatedRequest).body?.serverType || ''));
}

// ── Plans (free, no auth) ─────────────────────────────────────

/**
 * GET /compute/plans — List available server types with specs and pricing.
 * Free — no auth required.
 *
 * Optional `?location=fsn1` filters to types deployable in that location.
 * Each plan entry also carries an `availableLocations` array so callers
 * without a location preference can still see where each type runs.
 */
router.get("/plans", (req: any, res: Response) => {
  const locationParam = typeof req.query?.location === 'string' ? req.query.location : undefined;
  const plans = computeService.getPlans({ location: locationParam });
  res.json({
    plans,
    currency: "USDC",
    billingPeriod: "monthly",
    ...(locationParam ? { filteredBy: { location: locationParam } } : {}),
    note: "Pay via x402 protocol (Solana or Base USDC). Price includes setup.",
  });
});

/**
 * GET /compute/locations — List Hetzner Cloud locations + per-location
 * server-type availability. Free, no auth.
 *
 * Each entry has the location slug, city, country, network zone, and the
 * list of server-type names currently deployable there. Use this to pick
 * a `--location` for `compute deploy` when the default location doesn't
 * carry the type you want, OR when one location is capacity-constrained
 * and you want to retry elsewhere.
 */
router.get("/locations", (_req, res: Response) => {
  const locations = computeService.getLocations();
  res.json({
    locations,
    note: "Pass `location` in POST /compute/servers (or `--location` on the CLI) to override the default. `availableTypes` is the live deployable list pulled from Hetzner's /v1/datacenters.",
  });
});

/**
 * GET /compute/install-recipes — List available agent install recipes
 *
 * Free — no auth required. Tells agents what they can pass to `--install` /
 * the `install` field on POST /compute/servers. Each recipe runs as part of
 * cloud-init and writes /etc/palmyr/install-status.json on completion.
 */
router.get("/install-recipes", (_req, res: Response) => {
  res.json({
    recipes: computeService.listInstallRecipes(),
    usage: {
      api: "POST /compute/servers with body { install: \"hermes\" } or { install: [\"hermes\", \"openclaw\"] }",
      cli: "palmyr compute deploy --type cx23 --install hermes",
      marker: "Cloud-init writes /etc/palmyr/install-status.json when all requested recipes finish. The CLI's deploy --wait polls this as gate 4.",
    },
  });
});

// ── SSH Keys ──────────────────────────────────────────────────

/**
 * POST /compute/ssh-keys — Upload an SSH public key
 * Cost: 0.10 USDC
 */
router.post("/ssh-keys", rateLimit(10, 60_000), requireAuth(0.10, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, publicKey } = req.body as { name: string; publicKey: string };

    if (!name || !publicKey) {
      res.status(400).json({
        error: "Missing Required Fields",
        message: "Both 'name' and 'publicKey' are required",
        hint: "Include 'name' (key label) and 'publicKey' (your SSH public key, e.g. ssh-ed25519 AAAA...)"
      });
      return;
    }

    if (!publicKey.startsWith("ssh-") && !publicKey.startsWith("ecdsa-")) {
      res.status(400).json({
        error: "Invalid SSH Key",
        message: "publicKey must be a valid SSH public key",
        hint: "Format: ssh-ed25519 AAAA... or ssh-rsa AAAA..."
      });
      return;
    }

    const id = await computeService.uploadSshKey(name, publicKey);
    res.status(201).json({ id, name, message: "SSH key uploaded. Use this ID when creating servers." });
  } catch (err: any) {
    await refundAndRespond(req, res, {
      reason: `SSH key upload failed: ${err?.message || String(err)}`,
      userMessage: "Could not upload SSH key — your payment is being refunded.",
    });
  }
});

/**
 * GET /compute/ssh-keys — List SSH keys
 * Cost: 0.01 USDC
 */
router.get("/ssh-keys", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const keys = await computeService.listSshKeys();
    res.json({ sshKeys: keys.map((k: any) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint })) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list SSH keys", message: err.message });
  }
});

/**
 * DELETE /compute/ssh-keys/:id — Delete an SSH key
 * Cost: 0.01 USDC
 */
router.delete("/ssh-keys/:id", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    await computeService.deleteSshKey(Number(String(req.params.id)));
    res.json({ deleted: true, id: String(req.params.id) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete SSH key", message: err.message });
  }
});

// ── Servers ───────────────────────────────────────────────────

/**
 * POST /compute/servers — Create a server
 * Cost: varies by plan (6-50 USDC)
 */
/**
 * Pre-payment validation for POST /compute/servers. Runs BEFORE requireAuth
 * so a request that cannot possibly deploy fails WITHOUT the caller paying the
 * deploy fee: missing/typo'd fields, deprecated server types (Hetzner retires
 * them — 'cx22' burned real agents a deploy fee each), sold-out capacity, and
 * our own Hetzner account quota being maxed out.
 *
 * Availability is checked against a ≤60s-fresh capacity snapshot (deploys
 * are worth one blocking refresh; the 6h browse TTL is not deploy-grade).
 * When Hetzner is unreachable the checks degrade open — the post-payment
 * handler still refunds on failure, so a stale answer can't pocket money.
 */
export async function validateCreateServerBody(req: AuthenticatedRequest, res: Response, next: any): Promise<void> {
  const { name, serverType, install, sshPublicKey, location } = req.body as {
    name?: string;
    serverType?: string;
    install?: string | string[];
    sshPublicKey?: string;
    location?: string;
  };

  // Required fields — was previously checked in the post-payment handler,
  // meaning a missing serverType cost $6 to discover.
  if (!name || !serverType) {
    res.status(400).json({
      error: "Missing Required Fields",
      message: "Both 'name' and 'serverType' are required. You have not been charged.",
      hint: "GET /compute/plans for available types. Include sshPublicKey or sshKeyIds for SSH access.",
    });
    return;
  }

  // Validate hostname BEFORE Hetzner so a typo (uppercase, underscores,
  // leading hyphen) doesn't burn $6 USDC just to bounce off a 422.
  try {
    computeService.assertServerName(name);
  } catch (e: any) {
    res.status(400).json({ error: 'Invalid server name', message: e.message });
    return;
  }

  // Our Hetzner project hit an account-wide quota (e.g. primary IP limit)
  // moments ago — every deploy fails identically until it clears. Reject
  // up-front instead of charging + refunding each attempt.
  const retryAfter = computeService.platformCapacityRetryAfterSeconds();
  if (retryAfter > 0) {
    res.set("Retry-After", String(retryAfter));
    res.status(503).json({
      error: 'Platform at capacity',
      message: 'Our hosting capacity is temporarily maxed out. You have not been charged.',
      retryAfterSeconds: retryAfter,
      hint: 'Retry after the indicated delay. GET /compute/locations (free) to monitor availability.',
    });
    return;
  }

  // Capacity data fresh enough to bet a deploy charge on. Failure degrades to stale data.
  await computeService.ensureFreshAvailability();

  // Reject unknown/deprecated server types pre-payment. Only enforced when
  // the live catalog is loaded — the static fallback list is too small to
  // treat as authoritative.
  if (computeService.hasLocationData() && !computeService.isValidServerType(serverType)) {
    const valid = computeService.getServerPlans().map(p => p.type);
    res.status(400).json({
      error: 'Unknown server type',
      message: `'${serverType}' is not a current Hetzner server type (it may have been retired). You have not been charged.`,
      validTypes: valid,
      hint: 'GET /compute/plans (free) for live specs + pricing.',
    });
    return;
  }

  if (location !== undefined && !computeService.isValidLocation(location)) {
    res.status(400).json({
      error: 'Invalid location',
      message: `Unknown location '${location}'.`,
      hint: 'GET /compute/locations (free) for the live list.',
    });
    return;
  }

  // Type availability in the EFFECTIVE location — the default location
  // counts too (previously this check only ran when `location` was given
  // explicitly, so default-location deploys skipped it entirely).
  // "Sold out where it's normally offered" is a 409 with retry guidance;
  // "never offered there" is a 400 with the right locations.
  const effectiveLocation = location || config.hcloudLocation;
  if (!computeService.isTypeAvailableInLocation(serverType, effectiveLocation)) {
    const where = computeService.locationsForType(serverType);
    if (location === undefined) {
      // Caller is flexible on placement — auto-resolve to what Hetzner actually
      // has stock of, instead of failing the request (and any i402 plan it's
      // part of). Same type, different datacenter → identical per-type price, so
      // the paywall quote is unchanged.
      if (where.length > 0) {
        // Same type, just a different datacenter.
        (req.body as any).location = where[0];
        res.set('X-Compute-Location-Reselected', where[0]);
      } else {
        // Sold out everywhere → substitute the cheapest no-downgrade type Hetzner
        // actually has stock of. Prefer the same architecture (keeps the image /
        // install recipe valid); cross architectures only when no same-arch box
        // has stock anywhere — a working box beats a failed launch. Never random.
        // If the substitute is a pricier type, deployPriceForRequest re-prices it
        // from the resolved serverType, so the caller is quoted the substitute's
        // price in the 402 before paying (not silently up-charged).
        const sub = computeService.pickAvailableSubstitute(serverType);
        if (sub) {
          (req.body as any).serverType = sub.type;
          (req.body as any).location = sub.location;
          res.set('X-Compute-Type-Reselected', sub.type);
          res.set('X-Compute-Location-Reselected', sub.location);
          if (sub.crossArch) res.set('X-Compute-Arch-Changed', 'true');
        } else {
          // Nothing deployable meets the request — surface a clear, actionable
          // error that lists exactly what IS available right now.
          const availableTypes = computeService
            .getServerPlans()
            .filter((p: any) => computeService.locationsForType(p.type).length > 0)
            .map((p: any) => p.type);
          res.status(409).json({
            error: 'Server type sold out',
            message: `Server type '${serverType}' is sold out across all Hetzner datacenters, and no larger type has stock to substitute right now. You have not been charged.`,
            requestedType: serverType,
            availableTypes,
            hint: availableTypes.length
              ? `Currently deployable: ${availableTypes.join(', ')}. Pick one (GET /compute/plans is free), or retry shortly.`
              : 'No server types are deployable right now — retry shortly.',
          });
          return;
        }
      }
    } else if (computeService.isTypeSupportedInLocation(serverType, effectiveLocation)) {
      // Caller explicitly pinned this location — respect it; point at alternatives.
      const availableTypes = computeService
        .getServerPlans()
        .filter((p: any) => computeService.locationsForType(p.type).length > 0)
        .map((p: any) => p.type);
      res.status(409).json({
        error: 'Out of capacity',
        message: `Server type '${serverType}' is sold out in '${effectiveLocation}'. You have not been charged.`,
        availableIn: where,
        availableTypes,
        hint: where.length > 0
          ? `This type is live in: ${where.join(', ')} — retry with \`location\` set to one of those. Or pick another type (GET /compute/plans is free).`
          : `This type is sold out everywhere. Currently deployable types: ${availableTypes.join(', ') || '(none right now)'}.`,
      });
      return;
    } else {
      res.status(400).json({
        error: 'Type not available in location',
        message: `Server type '${serverType}' is not deployable in location '${effectiveLocation}'. You have not been charged.`,
        availableIn: where,
        hint: where.length > 0
          ? `Try one of: ${where.join(', ')}.`
          : 'GET /compute/locations (free) to see per-location availability.',
      });
      return;
    }
  }

  if (install !== undefined) {
    const list = Array.isArray(install)
      ? install
      : typeof install === 'string'
        ? install.split(',').map(s => s.trim())
        : null;
    if (list === null) {
      res.status(400).json({ error: 'Invalid install field', message: '`install` must be a string or string[]' });
      return;
    }
    for (const r of list) {
      if (r.length === 0) continue;
      if (!computeService.isKnownRecipe(r)) {
        const known = computeService.listInstallRecipes().map(x => x.name).join(', ');
        res.status(400).json({
          error: 'Invalid install recipe',
          message: `Unknown install recipe '${r}'. Known recipes: ${known}`,
          hint: 'GET /compute/install-recipes (free) for the live list.',
        });
        return;
      }
    }
  }

  if (sshPublicKey !== undefined && typeof sshPublicKey === 'string') {
    try {
      computeService.assertSshPublicKey(sshPublicKey);
    } catch (e: any) {
      res.status(400).json({ error: 'Invalid SSH Public Key', message: e.message });
      return;
    }
  }

  next();
}

router.post("/servers", validateCreateServerBody, requireAuth(deployPriceForRequest, 'server'), rateLimit(5, 60_000), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, serverType, image, sshKeyIds, sshPublicKey, location, installOpenClaw, install } = req.body as {
      name: string;
      serverType: string;
      image?: string;
      sshKeyIds?: number[];
      sshPublicKey?: string;
      location?: string;
      installOpenClaw?: boolean;
      install?: string | string[];
    };

    // name/serverType presence + validity were checked pre-payment by
    // validateCreateServerBody — by the time we're here the caller has paid
    // and the request is structurally sound.

    // Resolve the install list. `install` (new, explicit) wins over the legacy
    // `installOpenClaw` boolean. Either format normalizes to a string[] of
    // recipe names that the service layer validates against the allowlist.
    //
    //   install: ["hermes"]                  → installs: ["hermes"]
    //   install: "hermes,openclaw"           → installs: ["hermes","openclaw"]
    //   install: undefined, installOpenClaw  → preserve legacy behavior
    let installs: string[];
    if (install !== undefined) {
      const raw = Array.isArray(install)
        ? install
        : typeof install === 'string'
          ? install.split(',').map(s => s.trim())
          : [];
      installs = raw.filter(s => s.length > 0);
    } else if (installOpenClaw === false) {
      installs = [];
    } else {
      // No install field, no explicit opt-out → keep the existing default of
      // OpenClaw. Backwards compatible with every CLI version shipped before
      // 0.7.17.
      installs = ['openclaw'];
    }

    const owner = req.agentId || req.payment?.payer || "unknown";

    let result: Awaited<ReturnType<typeof computeService.createServer>>;
    try {
      result = await computeService.createServer(
        name,
        serverType as any,
        image ?? "ubuntu-24.04",
        owner,
        sshKeyIds,
        installs,
        location,
        sshPublicKey
      );
    } catch (createErr: any) {
      const msg = createErr?.message || '';
      // sshPublicKey validation errors → 400, not 500.
      if (/sshPublicKey/.test(msg)) {
        res.status(400).json({ error: 'Invalid SSH Public Key', message: msg });
        return;
      }
      // Unknown install recipe → 400 with the allowlist so the caller can fix.
      if (/Unknown install recipe/.test(msg)) {
        res.status(400).json({ error: 'Invalid install recipe', message: msg });
        return;
      }
      throw createErr;
    }
    const { passwordUsable, installs: resolvedInstalls, ...server } = result;

    // Build an explicit `sshAccess` block so the caller can branch
    // deterministically — agents shouldn't have to interpret presence/absence
    // of a `rootPassword` field to know how to connect.
    const ip = server.ipv4 || "<ip>";
    const userKeyAttached = !!sshPublicKey || (sshKeyIds && sshKeyIds.length > 0);
    let sshAccess: Record<string, any>;
    let response: Record<string, any>;

    if (passwordUsable && server.rootPassword) {
      // No cloud-init ran. Hetzner's default sshd allows password root login.
      sshAccess = {
        method: 'password',
        command: `ssh root@${ip}`,
        rootPassword: server.rootPassword,
        note: 'Save this password — we do not store a recoverable copy. Switch to SSH key auth on first login.',
      };
      response = { ...server, sshAccess };
    } else if (userKeyAttached) {
      // Cloud-init disables password auth, but the user provided a key — they
      // can SSH in as soon as the box finishes provisioning.
      sshAccess = {
        method: 'ssh-key',
        command: `ssh root@${ip}`,
        note: 'Your public key was injected at boot. Cloud-init takes ~60s to finish; SSH may be reachable a bit before that.',
      };
      // Strip the dead-on-arrival password from the response so callers don't
      // try to use it.
      const { rootPassword: _drop, ...visible } = server;
      response = { ...visible, sshAccess };
    } else {
      // Cloud-init ran but no user key was provided. Server is reachable only
      // via the platform's temporary key during provisioning. User must
      // either inject their key via setup-ssh or drive the box entirely
      // through the Palmyr-managed APIs (configure-openclaw etc.).
      sshAccess = {
        method: 'platform-provisioning',
        note: "We hold a temporary key during provisioning; you don't have direct SSH access yet.",
        howToGetSsh: {
          endpoint: `POST /compute/servers/${server.id}/setup-ssh`,
          body: { publicKey: 'ssh-ed25519 AAAA... [comment]' },
          cli: `palmyr compute setup-ssh --id ${server.id} --pubkey "ssh-ed25519 AAAA..."`,
          effect: 'Injects your public key, removes our temporary key, locks the root password. After this, only you can SSH in.',
        },
        alternatives: [
          'Pass `sshPublicKey` next time you call POST /compute/servers — it will land in authorized_keys at first boot, no second round-trip.',
          'If you only need API access (not SSH), call POST /compute/servers/{id}/configure-openclaw to drive the box through the OpenClaw gateway.',
        ],
      };
      const { rootPassword: _drop, ...visible } = server;
      response = { ...visible, sshAccess };
    }

    // Surface the resolved install list so callers know what got requested
    // (independent of whether it actually finished — the readiness chain's
    // gate-4 marker file confirms completion).
    if (resolvedInstalls.length > 0) {
      response.installs = resolvedInstalls;
      response.installStatus = {
        marker: '/etc/palmyr/install-status.json',
        note: `Cloud-init runs ${resolvedInstalls.length} install recipe(s) in sequence. The CLI's deploy --wait gate 4 polls the marker file via SSH; if you skipped --wait, you can check it yourself with: palmyr compute exec ${server.id} -- cat /etc/palmyr/install-status.json`,
      };
    }

    const installSummary = resolvedInstalls.length > 0
      ? ` Installing: ${resolvedInstalls.join(', ')}.`
      : '';

    // Host-key pinning: drop any stale pin for this server id (covers Hetzner
    // IP reuse — a recycled IP must never inherit a previous tenant's pin) and
    // kick off a best-effort capture so the first secrets-bearing call lands on
    // a pinned, strict-checked host where possible. Non-blocking and run after
    // the response is queued: the box is still booting (~60s), so capture
    // usually fails here and the first connect pins via TOFU (see sshCmd note).
    clearHostKeyPin(String(server.id));
    if (server.ipv4) {
      const pinId = String(server.id), pinIp = server.ipv4;
      setImmediate(() => { captureHostKeyPin(pinId, pinIp); });
    }

    // The deploy payment buys one billing period. Stamping it here is what
    // makes the lapse ladder able to tell a paid server from a squatting one —
    // before this existed, a single deploy fee ran a box indefinitely.
    const paidThrough = extendPaidThrough(String(server.id));

    res.status(201).json({
      ...response,
      billing: {
        periodDays: SERVER_BILLING_DAYS,
        paidThrough,
        priceUsdc: server.priceMonthly,
        renew: `POST /compute/servers/${server.id}/renew`,
        note: `This deploy covers ${SERVER_BILLING_DAYS} days. Renew before ${paidThrough} to keep the server running.`,
      },
      // Async-operation envelope (see /.well-known guidance): provisioning isn't
      // complete at response time — cloud-init runs ~60s. Poll the status URL
      // until `status` is terminal. `status` is already present from the server
      // record above; these add the standard operation_id + poll_url.
      operation_id: server.id,
      poll_url: `/compute/servers/${server.id}`,
      poll_after_seconds: 60,
      message: passwordUsable
        ? `Server created at ${ip}.${installSummary}`
        : userKeyAttached
          ? `Server created at ${ip}. SSH ready once cloud-init finishes (~60s).${installSummary}`
          : `Server created at ${ip}. Run setup-ssh to get SSH access.${installSummary}`,
    });
  } catch (err: any) {
    console.error("[compute] Create error:", err);
    // The $6 was already settled on-chain by requireAuth before this handler
    // ran, but Hetzner never provisioned the box — refund the payer instead of
    // pocketing the payment, and translate Hetzner's error code into guidance
    // the agent can act on (retry where? with what type?).
    const reason = `Hetzner provision failed: ${err?.message || String(err)}`;
    const requestedType = String(req.body?.serverType || '');
    const requestedLocation = String(req.body?.location || config.hcloudLocation);

    if (err instanceof HcloudApiError && err.code === 'resource_unavailable') {
      // Type sold out between our preflight snapshot and Hetzner's allocator.
      // Re-pull availability so the NEXT caller is rejected pre-payment.
      void computeService.ensureFreshAvailability(0);
      await refundAndRespond(req, res, {
        reason,
        userMessage: `Server type '${requestedType}' just ran out of capacity in '${requestedLocation}' — your payment is being refunded.`,
        errorLabel: 'Out of capacity',
        httpStatus: 409,
        extra: {
          availableIn: computeService.locationsForType(requestedType),
          retryHint: 'Retry with a different `location`, or pick another type via GET /compute/plans.',
        },
      });
      return;
    }

    if (err instanceof HcloudApiError && err.code === 'resource_limit_exceeded') {
      // OUR account quota (primary IPs, servers, ...) — every deploy fails
      // until ops intervenes. Open the breaker so further deploys are
      // rejected pre-payment instead of charge-then-refund.
      computeService.notePlatformCapacityError();
      console.error(`[compute] [CAPACITY] Hetzner account limit hit: ${err.hcloudMessage || err.message} — deploys paused pre-payment for 10min`);
      await refundAndRespond(req, res, {
        reason,
        userMessage: 'Our hosting capacity is temporarily maxed out — your payment is being refunded.',
        errorLabel: 'Platform at capacity',
        httpStatus: 503,
        extra: { retryAfterSeconds: computeService.platformCapacityRetryAfterSeconds() },
      });
      return;
    }

    if (err instanceof HcloudApiError && err.code === 'uniqueness_error') {
      await refundAndRespond(req, res, {
        reason,
        userMessage: `A server named '${String(req.body?.name || '')}' already exists in our Hetzner project — your payment is being refunded. Retry with a different name.`,
        errorLabel: 'Name already taken',
        httpStatus: 409,
      });
      return;
    }

    await refundAndRespond(req, res, {
      reason,
      userMessage: "Could not provision server — your payment is being refunded.",
    });
  }
});

/**
 * GET /compute/servers — List your servers
 * Cost: 0.01 USDC
 */
router.get("/servers", requireAuth(0.01, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const owner = req.agentId || req.payment?.payer || "unknown";
    const servers = await computeService.listServers(owner);
    // `billing` is the channel that actually reaches an agent — webhooks need a
    // registered URL, but anything polling this route sees the lapse state.
    res.json({
      servers: servers.map(srv => ({ ...srv, billing: lifecycleView(srv) })),
      count: servers.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list servers", message: err.message });
  }
});

/**
 * GET /compute/servers/:id — Get server details + live status
 * Cost: 0.01 USDC
 */
router.get("/servers/:id", requireAuth(0.01, 'general'), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await computeService.getServer(String(req.params.id));
    res.json({ ...server, billing: lifecycleView(server) });
  } catch (err: any) {
    res.status(404).json({ error: "Server Not Found", message: err.message });
  }
});

/**
 * x402 pricer for renew/restore. Both buy one more billing period at the same
 * per-type price as the original deploy, read from the live plan catalog so a
 * renewal never drifts from what `GET /compute/plans` quotes. Unknown id falls
 * back to the flat deploy price — the handler refunds anything it can't honour.
 */
export function renewPriceForRequest(req: Request): number {
  const row = db
    .prepare("SELECT server_type FROM servers WHERE id = ?")
    .get(String(req.params.id)) as { server_type?: string } | undefined;
  return priceForServerType(String(row?.server_type || ''));
}

/**
 * POST /compute/servers/:id/renew — Buy one more billing period.
 * Cost: the server type's monthly price (same as deploy).
 *
 * Extends `paid_through`, clears the lapse ladder, and powers the box back on
 * if it had already been idled. Renewing early stacks on the remaining time
 * rather than discarding it.
 *
 * Ownership is checked INSIDE the handler rather than via requireServerOwner
 * so a non-owner (or a bad id) gets refunded — at $7–$50 a call, silently
 * eating the payment behind a 404 the way the cheap read routes do isn't ok.
 */
router.post("/servers/:id/renew", requireAuth(renewPriceForRequest, 'server', {
  description: "Renew a server for another billing period. Extends paid_through and powers the server back on if it was idled for non-payment. Owner-only.",
  category: "compute",
  tags: ["compute", "billing", "renew"],
}), async (req: AuthenticatedRequest, res: Response) => {
  const serverId = String(req.params.id);
  const caller = req.agentId || req.payment?.payer || "unknown";

  const row = db
    .prepare("SELECT owner, name, terminated_at, idled_at FROM servers WHERE id = ?")
    .get(serverId) as { owner: string; name: string; terminated_at: string | null; idled_at: string | null } | undefined;

  if (!row || row.owner !== caller) {
    // Same 404-don't-confirm-existence posture as requireServerOwner, but with
    // the money returned.
    await refundAndRespond(req, res, {
      reason: `renew rejected: ${caller} is not the owner of ${serverId}`,
      errorLabel: "Server Not Found",
      userMessage: `No server with ID ${serverId} — your payment is being refunded.`,
      httpStatus: 404,
    });
    return;
  }

  if (row.terminated_at) {
    await refundAndRespond(req, res, {
      reason: `renew rejected: ${serverId} already terminated`,
      errorLabel: "Server Terminated",
      userMessage: "This server was already destroyed — renewing can't bring it back. Use restore to rebuild it from its snapshot; your payment is being refunded.",
      httpStatus: 409,
      extra: { restore: `POST /compute/servers/${serverId}/restore` },
    });
    return;
  }

  try {
    const paidThrough = extendPaidThrough(serverId);
    const wasIdled = !!row.idled_at;
    clearLapseState(serverId);

    // Powering back on is what the owner actually paid for — do it before
    // replying so the response reflects the real state.
    let poweredOn = false;
    if (wasIdled) {
      try {
        await computeService.serverAction(serverId, "poweron");
        poweredOn = true;
      } catch (err: any) {
        console.warn(`[compute] renew power-on failed for ${serverId}:`, err?.message ?? err);
      }
    }

    const server = await computeService.getServer(serverId);
    res.json({
      ...server,
      billing: lifecycleView(server),
      renewed: true,
      poweredOn,
      message: wasIdled
        ? poweredOn
          ? `Renewed until ${paidThrough} and powered back on.`
          : `Renewed until ${paidThrough}. The power-on call failed — retry with POST /compute/servers/${serverId}/actions {"action":"poweron"}.`
        : `Renewed until ${paidThrough}.`,
    });
  } catch (err: any) {
    await refundAndRespond(req, res, {
      reason: `renew failed for ${serverId}: ${err?.message || String(err)}`,
      userMessage: "Could not renew the server — your payment is being refunded.",
    });
  }
});

/**
 * POST /compute/servers/:id/restore — Rebuild a lapsed server from its snapshot.
 * Cost: the server type's monthly price (buys the first billing period back).
 *
 * A server destroyed by the lapse ladder keeps a snapshot for
 * PALMYR_VPS_SNAPSHOT_RETAIN_DAYS. This builds a fresh box from it, so the new
 * server gets a NEW id and a NEW IP — the response carries both.
 */
router.post("/servers/:id/restore", requireAuth(renewPriceForRequest, 'server', {
  description: "Rebuild a server that was destroyed for non-payment, from the snapshot taken at termination. Returns a NEW server id and IP. Owner-only, and only while the snapshot is retained.",
  category: "compute",
  tags: ["compute", "billing", "restore"],
}), async (req: AuthenticatedRequest, res: Response) => {
  const oldId = String(req.params.id);
  const caller = req.agentId || req.payment?.payer || "unknown";

  const row = db
    .prepare("SELECT owner, name, server_type, terminated_at, snapshot_id, snapshot_expires_at FROM servers WHERE id = ?")
    .get(oldId) as {
      owner: string; name: string; server_type: string;
      terminated_at: string | null; snapshot_id: string | null; snapshot_expires_at: string | null;
    } | undefined;

  if (!row || row.owner !== caller) {
    await refundAndRespond(req, res, {
      reason: `restore rejected: ${caller} is not the owner of ${oldId}`,
      errorLabel: "Server Not Found",
      userMessage: `No server with ID ${oldId} — your payment is being refunded.`,
      httpStatus: 404,
    });
    return;
  }

  if (!row.terminated_at || !row.snapshot_id) {
    await refundAndRespond(req, res, {
      reason: `restore rejected: ${oldId} has no snapshot to restore from`,
      errorLabel: "Nothing To Restore",
      userMessage: row.terminated_at
        ? "This server's snapshot has already been deleted — there is nothing left to restore. Your payment is being refunded."
        : "This server is still running; there is nothing to restore. Use renew to extend its billing period. Your payment is being refunded.",
      httpStatus: 409,
      extra: row.terminated_at ? {} : { renew: `POST /compute/servers/${oldId}/renew` },
    });
    return;
  }

  try {
    // Build from the snapshot image id. No install recipes — the disk is
    // already provisioned; re-running cloud-init would overwrite it.
    const result = await computeService.createServer(
      row.name,
      row.server_type as any,
      row.snapshot_id,
      caller,
      undefined,
      [],
    );
    const { passwordUsable: _pw, installs: _in, ...server } = result;

    const paidThrough = extendPaidThrough(String(server.id));

    // Carry the snapshot pointer onto the new row so its retention clock keeps
    // running and the GC still reaps it — restoring shouldn't strand an image
    // nobody is tracking, nor delete the only copy before the rebuild is proven.
    db.prepare(
      "UPDATE servers SET snapshot_id = ?, snapshot_expires_at = ? WHERE id = ?",
    ).run(row.snapshot_id, row.snapshot_expires_at, String(server.id));

    // The terminated record has been superseded.
    storage.deleteServer(oldId);
    clearHostKeyPin(oldId);

    const { rootPassword: _drop, ...visible } = server;
    res.status(201).json({
      ...visible,
      billing: lifecycleView({ ...server, paidThrough }),
      restoredFrom: { serverId: oldId, snapshotId: row.snapshot_id },
      operation_id: server.id,
      poll_url: `/compute/servers/${server.id}`,
      poll_after_seconds: 60,
      message: `Restored "${row.name}" from snapshot as a new server (${server.id}) at ${server.ipv4 || '<ip>'}. Paid through ${paidThrough}. Note the new id and IP — the old ones are gone.`,
    });
  } catch (err: any) {
    await refundAndRespond(req, res, {
      reason: `restore failed for ${oldId}: ${err?.message || String(err)}`,
      userMessage: "Could not restore the server from its snapshot — your payment is being refunded. The snapshot is untouched, so you can retry.",
    });
  }
});

/**
 * POST /compute/servers/:id/actions — Perform server action.
 *
 * Supported actions:
 *   - reboot          graceful restart
 *   - poweron         power on a stopped server
 *   - poweroff        graceful shutdown (data preserved)
 *   - reset           hard restart (no graceful shutdown)
 *   - rebuild         reinstall OS — wipes disk, runs cloud-init, keeps IP
 *   - reset_password  rotate root password (Hetzner-side); useless for SSH
 *                     unless sshd_config has PasswordAuthentication=on
 *   - request_console short-lived noVNC console URL — break-glass when SSH
 *                     is broken (cloud-init failed, sshd misconfigured, etc.)
 *
 * Cost: 0.10 USDC
 */
router.post("/servers/:id/actions", requireAuth(0.10, 'general'), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, image } = req.body as { action: string; image?: string };
    const validActions: ServerAction[] = ["reboot", "poweron", "poweroff", "rebuild", "reset", "reset_password", "request_console"];

    if (!action || !validActions.includes(action as ServerAction)) {
      res.status(400).json({
        error: "Invalid Action",
        message: `Action must be one of: ${validActions.join(", ")}`,
        hint: "reboot/reset = restart, rebuild = reinstall (data lost!), reset_password = rotate root password, request_console = noVNC break-glass URL",
      });
      return;
    }

    const result = await computeService.serverAction(String(req.params.id), action as ServerAction, image);
    const serverId = String(req.params.id);

    // A rebuild reinstalls the OS → the VPS regenerates its SSH host keys, so a
    // previously pinned key is now stale. Drop the pin; the next platform→VPS
    // connect re-pins the fresh host key via accept-new (otherwise
    // StrictHostKeyChecking=yes would correctly — but unhelpfully — reject the
    // legitimately rebuilt box).
    if (action === "rebuild") clearHostKeyPin(serverId);

    // reset_password and request_console need bespoke response shapes — they
    // hand back data that isn't relevant for the lifecycle actions and we
    // want callers to not have to dig through `result.action` for it.
    if (action === "reset_password") {
      res.json({
        action,
        serverId,
        rootPassword: result?.root_password ?? null,
        note: "Root password rotated. SSH login by password will only work if sshd is configured to accept it — Palmyr-deployed boxes (installOpenClaw=true) disable password auth at first boot, so this password is for console use or after manually re-enabling password auth. Use POST /compute/servers/:id/setup-ssh to inject an SSH key for SSH access.",
      });
      return;
    }
    if (action === "request_console") {
      res.json({
        action,
        serverId,
        wssUrl: result?.wss_url ?? null,
        password: result?.password ?? null,
        expiresAt: result?.expires ?? null,
        note: "Open wssUrl in a browser within ~1 minute. Authenticate with the password above. This is the host-VM console (noVNC) — works even when SSH is unreachable.",
      });
      return;
    }

    // Lifecycle actions — pass through Hetzner's action status.
    res.json({
      action,
      serverId,
      status: result?.action?.status || result?.status || "running",
      message: action === "rebuild"
        ? "Server is being rebuilt. All data will be lost."
        : `Server ${action} initiated.`,
    });
  } catch (err: any) {
    await refundAndRespond(req, res, {
      reason: `Server action failed: ${err?.message || String(err)}`,
      userMessage: "Could not perform the server action — your payment is being refunded.",
      errorLabel: "Action Failed",
    });
  }
});

/**
 * POST /compute/servers/:id/exec — Run a single command on the server via the
 * platform's temporary SSH key.
 *
 * Pre-handoff only: returns 410 once `setup-ssh` has run (the platform key
 * was removed from authorized_keys, so we no longer have a way in). After
 * handoff, the user is the only entity that can reach the server, which is
 * the whole point of the handoff — `run_command` from our side would be a
 * back door, so we honour the contract and refuse.
 *
 * Cost: 0.05 USDC. Validate inputs strictly: command + args[] are POSIX-quoted
 * service-side before being passed to ssh as a single remote-shell argument,
 * so user input never interpolates into our own shell.
 */
router.post("/servers/:id/exec", rateLimit(20, 60_000), requireAuth(0.05, 'general'), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { command, args, timeoutSec } = req.body as { command?: unknown; args?: unknown; timeoutSec?: unknown };

    if (typeof command !== 'string' || command.length === 0 || command.length > 256) {
      return res.status(400).json({
        error: "Invalid command",
        hint: "command must be a non-empty string up to 256 chars (e.g. 'systemctl', 'bash')",
      });
    }
    const argList: string[] = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [];
    if (Array.isArray(args) && argList.length !== args.length) {
      return res.status(400).json({ error: "Invalid args", hint: "args must be a string[]" });
    }
    // Total payload guard. ssh's `argv[N]` becomes the remote shell command;
    // a 64KiB cap is plenty for any sensible operation and prevents abuse.
    const totalLen = command.length + argList.reduce((n, a) => n + a.length, 0);
    if (totalLen > 65536) {
      return res.status(400).json({ error: "Command too long", hint: "Total of command + args must fit in 64KiB" });
    }

    const row = db.prepare("SELECT ipv4, root_password FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });
    if (!row.root_password) {
      return res.status(410).json({
        error: "Server is past SSH handoff — platform no longer has SSH access",
        hint: "Once you call POST /compute/servers/:id/setup-ssh, only your key works. Use your own SSH session to run commands.",
      });
    }

    const startedAt = Date.now();
    const result = await computeService.execOnServer(serverId, command, argList, {
      timeoutSec: typeof timeoutSec === 'number' ? timeoutSec : undefined,
    });
    res.json({
      action: 'exec',
      serverId,
      command,
      args: argList,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
    });
  } catch (err: any) {
    console.error("[compute] Exec error:", err);
    res.status(500).json({ error: "Exec failed", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/setup-ssh — Inject user's public key, disable password auth, delete root password from DB
 * This is the "zero access" handoff: after this, only the user can SSH in.
 */
router.post("/servers/:id/setup-ssh", requireAuth(0.01, 'general', { description: "Inject your SSH public key, disable password auth, and delete the root password from our DB — the zero-access handoff. Owner-only.", category: "compute", tags: ["compute", "ssh", "handoff"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { publicKey } = req.body as { publicKey: string };

    // Strict format check — OpenSSH public keys: "<type> <base64-key>[ <comment>]"
    // Reject any input with shell metacharacters or newlines.
    if (typeof publicKey !== 'string' || publicKey.length > 16384 ||
        !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(\s+[\w.@-]+)?$/.test(publicKey.trim())) {
      return res.status(400).json({ error: "Invalid SSH public key", hint: "Must be an OpenSSH-format public key: '<type> <base64> [comment]'" });
    }

    const row = db.prepare("SELECT ipv4, root_password FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });
    if (!row.root_password) return res.status(400).json({ error: "SSH already configured — root password was already deleted" });

    const ip = row.ipv4;
    const { execSync } = require("child_process");
    const ssh = sshCmd(ip, serverId);

    // 1. Inject user's public key via base64 (never interpolate user input into shell)
    execSync(`${ssh} "mkdir -p ~/.ssh && chmod 700 ~/.ssh"`, { timeout: 20000 });
    sshWriteFile(ssh, '/root/.ssh/authorized_keys', publicKey.trim() + '\n', { append: true, chmod: '600', timeout: 20000 });

    // 2. Remove platform temp key from authorized_keys
    execSync(`${ssh} "sed -i '/palmyr-platform-temp/d' ~/.ssh/authorized_keys"`, { timeout: 10000 });

    // 3. Lock root password
    execSync(`${ssh} "passwd -l root"`, { timeout: 10000 });

    // 4. Delete root password from our database — we can never access again
    db.prepare("UPDATE servers SET root_password = NULL WHERE id = ?").run(serverId);

    res.json({
      success: true,
      message: "SSH key injected, password auth disabled, root password deleted from platform. Only your key can access this server now.",
      ip,
      ssh: `ssh -i <your-key> root@${ip}`,
    });
  } catch (err: any) {
    console.error("[compute] SSH setup error:", err);
    res.status(500).json({ error: "SSH setup failed", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * GET /compute/servers/:id/verify — Verify OpenClaw installation on server
 */
router.get("/servers/:id/verify", requireAuth(0.01, 'general', { description: "Verify the OpenClaw installation on a server you own.", category: "compute", tags: ["compute", "openclaw", "verify"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const row = db.prepare("SELECT ipv4, root_password FROM servers WHERE id = ?").get(serverId) as any;
    if (!row || !row.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ip = row.ipv4;

    // Try SSH with platform key
    let result: any = { ip, reachable: false, openclaw_installed: false, openclaw_version: null, hardened: false, provision_log: null };

    try {
      const ssh = sshCmd(ip, serverId);

      // Check reachability + OpenClaw version
      const versionOut = execSync(`${ssh} "openclaw --version 2>/dev/null || echo NOT_INSTALLED"`, { timeout: 15000, encoding: "utf-8" }).trim();
      result.reachable = true;

      if (versionOut && !versionOut.includes("NOT_INSTALLED")) {
        result.openclaw_installed = true;
        result.openclaw_version = versionOut;
      }

      // Check provision metadata
      try {
        const provisionJson = execSync(`${ssh} "cat /etc/openclaw/provision.json 2>/dev/null || echo {}"`, { timeout: 10000, encoding: "utf-8" }).trim();
        result.provision_log = JSON.parse(provisionJson);
        result.hardened = result.provision_log?.hardened || false;
      } catch (e) {}

      // Check firewall
      try {
        const ufwStatus = execSync(`${ssh} "ufw status 2>/dev/null | head -1 || echo inactive"`, { timeout: 10000, encoding: "utf-8" }).trim();
        result.firewall = ufwStatus.includes("active") ? "active" : "inactive";
      } catch (e) { result.firewall = "unknown"; }

    } catch (e: any) {
      if (e.message?.includes("timed out") || e.message?.includes("Connection refused")) {
        result.reachable = false;
      } else {
        result.error = e.message?.split("\n")[0] || "SSH failed";
      }
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: "Verification failed", message: err.message });
  }
});

/**
 * POST /compute/servers/:id/configure-openclaw — Configure OpenClaw on the VPS
 * Writes openclaw.json config and sets up the Anthropic API key
 */
router.post("/servers/:id/configure-openclaw", requireAuth(0.01, 'general', { description: "Configure OpenClaw on a server you own (writes openclaw.json and sets the model API key). Owner-only.", category: "compute", tags: ["compute", "openclaw", "configure"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const {
      anthropicKey,
      authMode,      // 'token' | 'oauth'
      provider,      // 'anthropic' | 'openrouter' | 'openai'
      model,
      channel,       // 'telegram' | 'discord' | 'none'
      botToken,      // telegram bot token or discord token
      allowFrom,     // array of allowed user IDs
      gatewayPort,
      agentName,
    } = req.body;

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const ip = row.ipv4;
    const { execSync } = require("child_process");
    const ssh = sshCmd(ip, serverId);

    // 1. Ensure directory exists
    execSync(`${ssh} "mkdir -p /root/.openclaw/workspace"`, { timeout: 10000 });

    // 2. Read existing config (or start fresh)
    let config: any = {};
    try {
      const existing = execSync(`${ssh} "cat /root/.openclaw/openclaw.json 2>/dev/null || echo '{}'"`, { timeout: 10000, encoding: "utf-8" }).trim();
      config = JSON.parse(existing);
    } catch (e) { config = {}; }

    // Ensure base structure
    if (!config.auth) config.auth = { profiles: {} };
    if (!config.agents) config.agents = { defaults: { workspace: "/root/.openclaw/workspace", compaction: { mode: "safeguard" }, maxConcurrent: 4, subagents: { maxConcurrent: 8 } } };
    if (!config.commands) config.commands = { native: "auto", nativeSkills: "auto", restart: true };
    if (!config.gateway) config.gateway = { port: gatewayPort || 18789, mode: "local", bind: "loopback", auth: { mode: "token" } };
    if (!config.plugins) config.plugins = { entries: {} };
    if (!config.channels) config.channels = {};

    // 3. Apply model config if provided
    let envVar = '';
    let envValue = '';
    if (anthropicKey) {
      const effectiveProvider = provider || "anthropic";
      const effectiveAuthMode = authMode === 'setup-token' ? 'oauth' : (authMode || "token");
      const profileKey = effectiveProvider + ":default";
      config.auth.profiles[profileKey] = { provider: effectiveProvider, mode: effectiveAuthMode };

      if (model) {
        config.agents.defaults.subagents = { ...(config.agents.defaults.subagents || {}), model };
      }

      if (effectiveAuthMode === 'oauth') {
        // Write auth-profiles.json directly (paste-token is interactive)
        const authProfile = {
          version: 1,
          profiles: {
            [`${effectiveProvider}:default`]: {
              type: "token",
              provider: effectiveProvider,
              token: anthropicKey,
            }
          }
        };
        execSync(`${ssh} "mkdir -p /root/.openclaw/agents/main/agent"`, { timeout: 10000 });
        sshWriteFile(ssh, '/root/.openclaw/agents/main/agent/auth-profiles.json', JSON.stringify(authProfile, null, 2));
      } else {
        const envVarMap: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
        envVar = envVarMap[effectiveProvider] || 'ANTHROPIC_API_KEY';
        envValue = anthropicKey;
        // Idempotent: remove old line, then write user-provided key via base64 stdin
        // (never interpolate anthropicKey into the shell string).
        execSync(`${ssh} "grep -v '^${envVar}=' /etc/environment > /tmp/env.tmp 2>/dev/null || true"`, { timeout: 10000 });
        sshWriteFile(ssh, '/tmp/env.tmp', `${envVar}=${anthropicKey}\n`, { append: true });
        execSync(`${ssh} "mv /tmp/env.tmp /etc/environment"`, { timeout: 10000 });
      }
    }

    // 4. Apply channel config if provided
    if (channel === "telegram" && botToken) {
      const isPairing = allowFrom?.includes?.('__PAIRING__') || (!allowFrom?.length);
      const telegramConfig: any = {
        enabled: true,
        dmPolicy: isPairing ? "pairing" : (allowFrom?.[0] === "*" ? "open" : "allowlist"),
        botToken,
        groupPolicy: "allowlist",
        streaming: "partial"
      };
      // Only set allowFrom for allowlist mode (pairing manages its own)
      if (!isPairing && allowFrom?.[0] !== "*") {
        telegramConfig.allowFrom = allowFrom.filter((a: string) => a !== '__PAIRING__');
      } else if (allowFrom?.[0] === "*") {
        telegramConfig.allowFrom = ["*"];
      }
      config.channels.telegram = telegramConfig;
      config.plugins.entries.telegram = { enabled: true };
    } else if (channel === "discord" && botToken) {
      config.channels.discord = {
        enabled: true,
        token: botToken,
        dmPolicy: "open",
        allowFrom: allowFrom || ["*"],
        groupPolicy: "allowlist",
        streaming: "off"
      };
      config.plugins.entries.discord = { enabled: true };
    }

    // 5. Write merged config
    const configJson = JSON.stringify(config, null, 2);
    const configB64 = Buffer.from(configJson).toString('base64');
    execSync(`${ssh} "echo '${configB64}' | base64 -d > /root/.openclaw/openclaw.json"`, { timeout: 10000 });

    // 6. Create workspace files if agent name provided
    if (agentName) {
      if (typeof agentName !== 'string' || agentName.length > 256) {
        return res.status(400).json({ error: "agentName must be a string up to 256 chars" });
      }
      const born = new Date().toISOString().split('T')[0];
      const identityMd = `# IDENTITY.md\n\n- **Name:** ${agentName}\n- **Born:** ${born}\n`;
      sshWriteFile(ssh, '/root/.openclaw/workspace/IDENTITY.md', identityMd);
    }

    // 7. Create/update systemd service + restart
    const envLine = envVar && envValue ? `Environment=${envVar}=${envValue}` : '';
    const serviceFile = `[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=root
${envLine}
ExecStart=/usr/bin/env openclaw gateway run --allow-unconfigured
WorkingDirectory=/root
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`;

    const svcB64 = Buffer.from(serviceFile).toString('base64');
    execSync(`${ssh} "echo '${svcB64}' | base64 -d > /etc/systemd/system/openclaw.service"`, { timeout: 10000 });
    execSync(`${ssh} "systemctl daemon-reload && systemctl enable openclaw && systemctl restart openclaw"`, { timeout: 20000 });

    // 6. Verify it started
    let running = false;
    try {
      const status = execSync(`${ssh} "systemctl is-active openclaw 2>/dev/null || echo inactive"`, { timeout: 10000, encoding: "utf-8" }).trim();
      running = status === "active";
    } catch (e) {}

    // Update server record with openclaw configured flag
    db.prepare("UPDATE servers SET openclaw_configured = 1 WHERE id = ?").run(serverId);

    res.json({
      success: true,
      running,
      message: running
        ? "OpenClaw configured and running!"
        : "OpenClaw configured but may still be starting. Check with: systemctl status openclaw",
      config: {
        model: model || "anthropic/claude-sonnet-4-20250514",
        channel: channel || "none",
        gateway_port: gatewayPort || 18789,
      }
    });
  } catch (err: any) {
    console.error("[compute] OpenClaw config error:", err);
    res.status(500).json({ error: "Configuration failed", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/remove-openclaw-config — Remove channel or model config
 */
router.post("/servers/:id/remove-openclaw-config", requireAuth(0.01, 'general', { description: "Remove a channel or model config entry from OpenClaw on a server you own. Owner-only.", category: "compute", tags: ["compute", "openclaw", "configure"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { remove } = req.body; // 'channel' or 'model'

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4, serverId);

    // Read existing config
    let config: any = {};
    try {
      const existing = execSync(`${ssh} "cat /root/.openclaw/openclaw.json 2>/dev/null || echo '{}'"`, { timeout: 10000, encoding: "utf-8" }).trim();
      config = JSON.parse(existing);
    } catch (e) { config = {}; }

    if (remove === 'channel') {
      // Remove all channel configs
      delete config.channels;
      config.channels = {};
      if (config.plugins?.entries) {
        delete config.plugins.entries.telegram;
        delete config.plugins.entries.discord;
      }
    } else if (remove === 'model') {
      // Remove auth profiles and env vars
      if (config.auth) config.auth.profiles = {};
      // Clear auth-profiles.json
      try {
        execSync(`${ssh} "rm -f /root/.openclaw/agents/main/agent/auth-profiles.json"`, { timeout: 10000 });
      } catch (e) {}
      // Clear env var on server
      try {
        execSync(`${ssh} "grep -v '_API_KEY' /etc/environment > /tmp/env.tmp 2>/dev/null; mv /tmp/env.tmp /etc/environment"`, { timeout: 10000 });
      } catch (e) {}
    }

    // Write updated config
    const configJson = JSON.stringify(config, null, 2);
    const configB64 = Buffer.from(configJson).toString('base64');
    execSync(`${ssh} "echo '${configB64}' | base64 -d > /root/.openclaw/openclaw.json"`, { timeout: 10000 });

    // Restart OpenClaw
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, removed: remove });
  } catch (err: any) {
    console.error("[compute] Remove config error:", err);
    res.status(500).json({ error: "Failed to remove config", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/install-skill — Install a skill on the VPS
 */
router.post("/servers/:id/install-skill", requireAuth(0.01, 'general', { description: "Install a single skill on a server you own. Owner-only.", category: "compute", tags: ["compute", "openclaw", "skill", "install"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { skillName, skillUrl } = req.body; // skillUrl = clawhub URL or git repo

    // Validate inputs before ANY shell interpolation.
    try {
      assertIdent(skillName, 'skillName');
      if (skillUrl !== undefined) assertGitUrl(skillUrl);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4, serverId);

    // Create skills directory
    execSync(`${ssh} "mkdir -p /root/.openclaw/workspace/skills"`, { timeout: 10000 });

    // Install skill via git clone or copy from clawhub
    const skillDir = `/root/.openclaw/workspace/skills/${skillName}`;

    // Try clawhub first (openclaw install), fallback to direct copy from our VPS
    try {
      // Check if skill exists locally on our server, copy it
      const { existsSync } = require("fs");
      const localSkillPath = `/root/.openclaw/workspace/skills/${skillName}`;
      const builtinSkillPath = `/usr/lib/node_modules/openclaw/skills/${skillName}`;
      const sourcePath = existsSync(localSkillPath) ? localSkillPath : existsSync(builtinSkillPath) ? builtinSkillPath : null;
      if (sourcePath) {
        // Tar + pipe to remote (skillName is validated ident)
        const parentDir = require("path").dirname(sourcePath);
        execSync(`tar -C ${parentDir} -cf - ${skillName} | ${ssh} "tar -C /root/.openclaw/workspace/skills -xf -"`, { timeout: 30000 });
      } else if (skillUrl) {
        // Git clone — skillUrl and skillName are validated above
        execSync(`${ssh} "git clone --depth 1 ${skillUrl} ${skillDir} 2>/dev/null || echo 'clone failed'"`, { timeout: 30000 });
      } else {
        return res.status(400).json({ error: `Skill '${skillName}' not found locally and no URL provided` });
      }
    } catch (e: any) {
      return res.status(500).json({ error: "Failed to install skill", message: e.message?.split("\n")[0] });
    }

    // Verify it installed — skillDir is safe because skillName is validated
    let installed = false;
    try {
      const check = execSync(`${ssh} "test -f ${skillDir}/SKILL.md && echo yes || echo no"`, { timeout: 10000, encoding: "utf-8" }).trim();
      installed = check === "yes";
    } catch (e) {}

    // Restart OpenClaw to pick up the new skill
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, skill: skillName, installed, message: installed ? `Skill '${skillName}' installed and OpenClaw restarted` : `Skill directory created but SKILL.md not found` });
  } catch (err: any) {
    console.error("[compute] Skill install error:", err);
    res.status(500).json({ error: "Failed to install skill", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/install-skills-bulk — Install multiple skills at once
 */
router.post("/servers/:id/install-skills-bulk", requireAuth(0.01, 'general', { description: "Install multiple skills at once on a server you own. Owner-only.", category: "compute", tags: ["compute", "openclaw", "skill", "install"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { skills } = req.body as { skills: string[] };

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const { existsSync, readdirSync } = require("fs");
    const path = require("path");
    const ssh = sshCmd(row.ipv4, serverId);

    // Create skills directory
    execSync(`${ssh} "mkdir -p /root/.openclaw/workspace/skills"`, { timeout: 10000 });

    // If __ALL__, discover all available skills
    let skillList = skills || [];
    if (skillList.includes('__ALL__')) {
      const wsDir = '/root/.openclaw/workspace/skills';
      const builtinDir = '/usr/lib/node_modules/openclaw/skills';
      const allSkills = new Set<string>();
      try { readdirSync(wsDir).forEach((s: string) => allSkills.add(s)); } catch (e) {}
      try { readdirSync(builtinDir).forEach((s: string) => allSkills.add(s)); } catch (e) {}
      skillList = [...allSkills];
    }

    if (!skillList.length) return res.status(400).json({ error: "No skills found" });

    let installed = 0, failed = 0;
    const results: any[] = [];

    // Collect all skills that exist locally, tar them together for one transfer
    const localSkills: { name: string; dir: string }[] = [];
    const notFound: string[] = [];

    for (const skillName of skillList) {
      const wsPath = `/root/.openclaw/workspace/skills/${skillName}`;
      const builtinPath = `/usr/lib/node_modules/openclaw/skills/${skillName}`;
      if (existsSync(wsPath)) {
        localSkills.push({ name: skillName, dir: path.dirname(wsPath) });
      } else if (existsSync(builtinPath)) {
        localSkills.push({ name: skillName, dir: path.dirname(builtinPath) });
      } else {
        notFound.push(skillName);
        failed++;
      }
    }

    // Group by parent directory for efficient tar
    const byDir = new Map<string, string[]>();
    for (const s of localSkills) {
      const arr = byDir.get(s.dir) || [];
      arr.push(s.name);
      byDir.set(s.dir, arr);
    }

    for (const [dir, names] of byDir) {
      try {
        const tarList = names.join(' ');
        execSync(`tar -C ${dir} -cf - ${tarList} | ${ssh} "tar -C /root/.openclaw/workspace/skills -xf -"`, { timeout: 60000 });
        installed += names.length;
        names.forEach(n => results.push({ skill: n, status: 'installed' }));
      } catch (e: any) {
        failed += names.length;
        names.forEach(n => results.push({ skill: n, status: 'failed', error: e.message?.split("\n")[0] }));
      }
    }

    notFound.forEach(n => results.push({ skill: n, status: 'not_found' }));

    // Restart OpenClaw once after all installs
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, installed, failed, total: skillList.length, results });
  } catch (err: any) {
    console.error("[compute] Bulk skill install error:", err);
    res.status(500).json({ error: "Bulk install failed", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/remove-skill — Remove a skill from the VPS
 */
router.post("/servers/:id/remove-skill", requireAuth(0.01, 'general', { description: "Remove a skill from a server you own. Owner-only.", category: "compute", tags: ["compute", "openclaw", "skill", "remove"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { skillName } = req.body;
    try {
      assertIdent(skillName, 'skillName');
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4, serverId);

    // skillName is now a safe identifier (no `..`, no `/`, no shell metachars)
    execSync(`${ssh} "rm -rf /root/.openclaw/workspace/skills/${skillName}"`, { timeout: 10000 });
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, skill: skillName, message: `Skill '${skillName}' removed` });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to remove skill", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * GET /compute/skills/catalog — Proxy to ClawHub API with pagination + caching
 */
let _skillCache: { items: any[]; fetchedAt: number } | null = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 min

router.get("/skills/catalog", async (_req: AuthenticatedRequest, res: Response) => {
  try {
    // Return cache if fresh
    if (_skillCache && _skillCache.items.length > 0 && Date.now() - _skillCache.fetchedAt < CACHE_TTL) {
      return res.json({ items: _skillCache.items, cached: true });
    }

    // Phase 1: Search diverse queries, take top 5 per query to get variety
    const allItems: any[] = [];
    const seen = new Set<string>();
    const queries = [
      'self-improving', 'summarize', 'memory', 'calendar', 'email',
      'github', 'git', 'docker', 'database', 'postgres', 'redis',
      'weather', 'finance', 'crypto', 'solana', 'ethereum', 'trading',
      'notion', 'obsidian', 'slack', 'discord', 'telegram', 'whatsapp',
      'home assistant', 'smart home', 'music', 'spotify',
      'image', 'video', 'voice', 'tts', 'whisper',
      'security', 'monitor', 'backup', 'deploy', 'ci cd',
      'skill', 'agent', 'api', 'tool', 'code', 'web', 'ai',
      'file', 'search', 'dev', 'chat', 'write', 'read', 'build', 'test',
      'browser', 'scrape', 'pdf', 'csv', 'json', 'markdown',
    ];
    
    // Fetch all queries in parallel (faster)
    const searchResults = await Promise.allSettled(
      queries.map(async (q) => {
        const r = await fetch(`https://clawhub.ai/api/v1/search?q=${encodeURIComponent(q)}&limit=100`);
        if (!r.ok) return [];
        const data = await r.json() as any;
        return data.results || [];
      })
    );
    
    for (const result of searchResults) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value) {
        if (!seen.has(item.slug)) {
          seen.add(item.slug);
          allItems.push(item);
        }
      }
    }

    // Ensure known popular skills are included
    const knownPopular = ['self-improving-agent','find-skills','summarize','github-pr','taskmaster-ai','context7'];
    for (const slug of knownPopular) {
      if (!seen.has(slug)) { seen.add(slug); allItems.unshift({ slug, displayName: slug }); }
    }

    // Phase 2: Enrich items with stats in batches of 20 (parallel)
    const batchSize = 20;
    for (let i = 0; i < allItems.length; i += batchSize) {
      const batch = allItems.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map(async (item: any) => {
          try {
            const r = await fetch(`https://clawhub.ai/api/v1/skills/${encodeURIComponent(item.slug)}`);
            if (!r.ok) return;
            const d = await r.json() as any;
            if (d.skill?.stats) {
              item.stats = d.skill.stats;
              item.displayName = d.skill.displayName || item.displayName;
              item.summary = d.skill.summary || item.summary;
            }
            if (d.latestVersion) item.latestVersion = d.latestVersion;
          } catch (e) {}
        })
      );
      // Stop enriching after 200 skills to keep load time reasonable
      if (i + batchSize >= 200) break;
    }

    // Sort by downloads (enriched first, then by score)
    allItems.sort((a: any, b: any) => {
      const aDl = a.stats?.downloads || 0;
      const bDl = b.stats?.downloads || 0;
      if (aDl || bDl) return bDl - aDl;
      return (b.score || 0) - (a.score || 0);
    });

    if (allItems.length > 0) _skillCache = { items: allItems, fetchedAt: Date.now() };
    res.json({ items: allItems, total: allItems.length });
  } catch (err: any) {
    // Return stale cache on error
    if (_skillCache) return res.json({ items: _skillCache.items, cached: true, stale: true });
    res.status(502).json({ error: "Failed to fetch skill catalog", message: err.message });
  }
});

/**
 * POST /compute/servers/:id/configure-wallet — Push wallet addresses to VPS
 */
router.post("/servers/:id/configure-wallet", requireAuth(0.01, 'general', { description: "Push wallet addresses to OpenClaw on a server you own. Owner-only.", category: "compute", tags: ["compute", "openclaw", "wallet"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { baseWallet, solanaWallet, baseAgent, solanaAgent, basePrivateKey, solanaPrivateKey } = req.body;

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4, serverId);

    // Write wallet config to TOOLS.md so the agent knows its wallets
    const toolsContent = `# Wallet Configuration

## Your Wallets
You have two wallets — one on Base (EVM) and one on Solana. Each has a **smart wallet** (holds funds, enforces limits) and a **signing key** (you use to authorize transactions).

### Base (EVM)
- **Smart Wallet (deposit here):** ${baseWallet || 'not configured'}
- **Your Signing Key:** ${baseAgent || 'not configured'}
- **Chain:** Base Mainnet
- To receive funds, give people the smart wallet address above.

### Solana
- **Smart Wallet (deposit here):** ${solanaWallet || 'not configured'}
- **Your Signing Key:** ${solanaAgent || 'not configured'}
- **Chain:** Solana (devnet)

## Private Keys
- **Base key:** ${basePrivateKey ? '/root/.agentwallet/base.key (also in AGENTWALLET_KEY env)' : 'not configured'}
- **Solana key:** ${solanaPrivateKey ? '/root/.agentwallet/solana.key (also in AGENTWALLET_SOL_KEY env)' : 'not configured'}

## How It Works
- Your signing key authorizes transactions. The smart contract wallet enforces spending limits.
- You sign with your key → smart wallet executes → on-chain limits prevent overspending.
- Your human owner set the limits via passkey (FaceID/fingerprint). You cannot change them.

## Sending Transactions
\`\`\`bash
# Send USDC on Base
agentwallet send --wallet $AGENT_BASE_WALLET --to <recipient> --amount <amount> --key $AGENTWALLET_KEY --token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# Send ETH on Base
agentwallet send --wallet $AGENT_BASE_WALLET --to <recipient> --amount <amount> --key $AGENTWALLET_KEY
\`\`\`

## API
- **Endpoint:** https://palmyr.ai/wallet
- **CLI:** npx @agntos/agentwallet
- **Docs:** See the agentwallet skill for full API reference
`;
    const b64 = Buffer.from(toolsContent).toString('base64');
    execSync(`${ssh} "echo '${b64}' | base64 -d > /root/.openclaw/workspace/TOOLS.md"`, { timeout: 10000 });

    // Store private keys securely (chmod 600)
    if (basePrivateKey) {
      const keyB64 = Buffer.from(basePrivateKey).toString('base64');
      execSync(`${ssh} "mkdir -p /root/.agentwallet && echo '${keyB64}' | base64 -d > /root/.agentwallet/base.key && chmod 600 /root/.agentwallet/base.key"`, { timeout: 10000 });
    }
    if (solanaPrivateKey) {
      const keyB64 = Buffer.from(solanaPrivateKey).toString('base64');
      execSync(`${ssh} "mkdir -p /root/.agentwallet && echo '${keyB64}' | base64 -d > /root/.agentwallet/solana.key && chmod 600 /root/.agentwallet/solana.key"`, { timeout: 10000 });
    }

    // Set wallet addresses + keys as env vars
    const envLines: string[] = [];
    if (baseWallet) envLines.push(`AGENT_BASE_WALLET=${baseWallet}`);
    if (solanaWallet) envLines.push(`AGENT_SOLANA_WALLET=${solanaWallet}`);
    if (baseAgent) envLines.push(`AGENT_BASE_ADDRESS=${baseAgent}`);
    if (solanaAgent) envLines.push(`AGENT_SOLANA_ADDRESS=${solanaAgent}`);
    if (basePrivateKey) envLines.push(`AGENTWALLET_KEY=${basePrivateKey}`);
    if (solanaPrivateKey) envLines.push(`AGENTWALLET_SOL_KEY=${solanaPrivateKey}`);

    if (envLines.length) {
      // Remove old wallet env vars, add new ones
      const keys = envLines.map(l => l.split('=')[0]);
      const grepPattern = keys.join('\\|');
      const envContent = envLines.join('\n');
      const envB64 = Buffer.from(envContent).toString('base64');
      execSync(`${ssh} "grep -v '${grepPattern}' /etc/environment > /tmp/env.tmp 2>/dev/null || cp /etc/environment /tmp/env.tmp; echo '${envB64}' | base64 -d >> /tmp/env.tmp; mv /tmp/env.tmp /etc/environment"`, { timeout: 10000 });
    }

    // Restart OpenClaw to pick up new TOOLS.md + env
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, message: "Wallet config pushed to VPS" });
  } catch (err: any) {
    console.error("[compute] Wallet config error:", err);
    res.status(500).json({ error: "Failed to configure wallet", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/pairing-approve — Approve a pairing code on the VPS
 */
router.post("/servers/:id/pairing-approve", requireAuth(0.01, 'general', { description: "Approve a pairing code on a server you own. Owner-only.", category: "compute", tags: ["compute", "openclaw", "pairing"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { code, channel: chan } = req.body;
    const channel = chan || 'telegram';
    try {
      assertIdent(code, 'code');
      assertIdent(channel, 'channel');
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4, serverId);

    const result = execSync(`${ssh} "openclaw pairing approve ${channel} ${code} 2>&1"`, { timeout: 15000, encoding: "utf-8" }).trim();

    res.json({ success: true, message: result || "Pairing approved" });
  } catch (err: any) {
    console.error("[compute] Pairing approve error:", err);
    const msg = err.stderr?.toString() || err.message?.split("\n")[0] || "Failed";
    res.status(400).json({ error: "Pairing approval failed", message: msg });
  }
});

/**
 * GET /compute/skills/featured — Get community-submitted featured skills
 */
router.get("/skills/featured", async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = db.prepare("SELECT * FROM featured_skills ORDER BY created_at DESC").all();
    res.json({ skills: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /compute/skills/featured — Submit a ClawHub skill to the featured list
 */
router.post("/skills/featured", requireAuth(0, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: "slug is required" });

    // Verify it exists on ClawHub
    const r = await fetch(`https://clawhub.ai/api/v1/skills/${slug}`);
    if (!r.ok) return res.status(404).json({ error: `Skill '${slug}' not found on ClawHub` });
    const data = await r.json() as any;

    const displayName = data.skill?.displayName || slug;
    const description = data.skill?.summary || '';
    // Attribute to the VERIFIED identity, never the raw (spoofable) header.
    // Curation is authenticated so the featured list can't be anonymously
    // poisoned (pointing agents at a malicious ClawHub slug they then install).
    const submittedBy = req.agentId || req.payment?.payer || 'unknown';

    db.prepare("INSERT OR IGNORE INTO featured_skills (slug, submitted_by, display_name, description, clawhub_url) VALUES (?, ?, ?, ?, ?)")
      .run(slug, submittedBy, displayName, description, `https://clawhub.ai/skills/${slug}`);

    res.json({ success: true, slug, displayName });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /compute/skills/featured/:slug — Remove a featured skill (submitter only)
 */
router.delete("/skills/featured/:slug", requireAuth(0, 'general'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const me = req.agentId || req.payment?.payer;
    // Only the original submitter may remove their entry — prevents anyone
    // wiping the curated list. (Admin cleanup can be done out-of-band in the DB.)
    const row = db.prepare("SELECT submitted_by FROM featured_skills WHERE slug = ?").get(req.params.slug) as { submitted_by: string } | undefined;
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.submitted_by !== me) return res.status(403).json({ error: "Only the submitter can remove this entry" });
    db.prepare("DELETE FROM featured_skills WHERE slug = ?").run(req.params.slug);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /compute/skills/:slug/security — Get security scan for a skill from ClawHub
 */
router.get("/skills/:slug/security", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { slug } = req.params;
    const r = await fetch(`https://clawhub.ai/api/v1/skills/${slug}`);
    if (!r.ok) throw new Error(`Skill not found: ${slug}`);
    const skillData = await r.json() as any;
    const version = skillData.latestVersion?.version;
    if (!version) return res.json({ slug, security: null, message: "No version found" });

    const vr = await fetch(`https://clawhub.ai/api/v1/skills/${slug}/versions/${version}`);
    if (!vr.ok) return res.json({ slug, security: null });
    const vData = await vr.json() as any;

    res.json({
      slug,
      version,
      security: vData.version?.security || null,
      files: vData.version?.files?.length || 0,
      license: vData.version?.license || null,
      owner: skillData.owner || null,
      stats: skillData.skill?.stats || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /compute/servers/:id/install-clawhub-skills — Install skills from ClawHub via clawhub CLI
 */
router.post("/servers/:id/install-clawhub-skills", requireAuth(0.01, 'general', { description: "Install skills from ClawHub on a server you own via the clawhub CLI. Owner-only.", category: "compute", tags: ["compute", "openclaw", "skill", "clawhub"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const { slugs } = req.body as { slugs: string[] };
    if (!slugs?.length) return res.status(400).json({ error: "slugs array is required" });

    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4, serverId);

    // Ensure clawhub is installed
    execSync(`${ssh} "which clawhub >/dev/null 2>&1 || npm i -g clawhub"`, { timeout: 30000 });

    let installed = 0, failed = 0;
    const results: any[] = [];

    // Install each skill via clawhub CLI (batched)
    for (const slug of slugs) {
      try {
        assertIdent(slug, 'slug');
        execSync(`${ssh} "cd /root/.openclaw/workspace && clawhub install ${slug} --force --no-input 2>&1"`, { timeout: 30000, encoding: "utf-8" });
        installed++;
        results.push({ slug, status: 'installed' });
      } catch (e: any) {
        failed++;
        results.push({ slug, status: 'failed', error: e.message?.split("\n")[0] });
      }
    }

    // Restart OpenClaw
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, installed, failed, total: slugs.length, results });
  } catch (err: any) {
    console.error("[compute] ClawHub skill install error:", err);
    res.status(500).json({ error: "Failed to install skills", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/remove-all-skills — Remove all skills from the VPS
 */
router.post("/servers/:id/remove-all-skills", requireAuth(0.01, 'general', { description: "Remove all skills from a server you own. Owner-only.", category: "compute", tags: ["compute", "openclaw", "skill", "remove"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const serverId = String(req.params.id);
    const row = db.prepare("SELECT ipv4 FROM servers WHERE id = ?").get(serverId) as any;
    if (!row?.ipv4) return res.status(404).json({ error: "Server not found" });

    const { execSync } = require("child_process");
    const ssh = sshCmd(row.ipv4, serverId);

    execSync(`${ssh} "rm -rf /root/.openclaw/workspace/skills/*"`, { timeout: 15000 });
    execSync(`${ssh} "systemctl restart openclaw 2>/dev/null || true"`, { timeout: 15000 });

    res.json({ success: true, message: "All skills removed from VPS" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to remove skills", message: err.message?.split("\n")[0] || "Failed" });
  }
});

/**
 * POST /compute/servers/:id/resize — Resize server (change plan)
 * Cost: 0.10 USDC (+ price difference on next billing)
 */
router.post("/servers/:id/resize", requireAuth(0.10, 'general', { description: "Resize a server you own (change plan; price difference applies on next billing). Owner-only.", category: "compute", tags: ["compute", "resize", "plan"] }), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { serverType, upgradeDisk } = req.body as { serverType: string; upgradeDisk?: boolean };

    if (!serverType) {
      res.status(400).json({
        error: "Missing serverType",
        message: "Specify the target server type",
        hint: "GET /compute/plans for available types. Server must be powered off to resize."
      });
      return;
    }

    const result = await computeService.resizeServer(String(req.params.id), serverType as any, upgradeDisk ?? false);
    res.json({
      action: "resize",
      serverId: String(req.params.id),
      newType: serverType,
      status: result?.status || "running",
      message: "Server resize initiated. Server must be off first.",
    });
  } catch (err: any) {
    await refundAndRespond(req, res, {
      reason: `Server resize failed: ${err?.message || String(err)}`,
      userMessage: "Could not resize the server — your payment is being refunded. Note: the server must be powered off to resize.",
      errorLabel: "Resize Failed",
    });
  }
});

/**
 * PUT /compute/servers/:id — Rename a server.
 *
 * Metadata-only operation; doesn't reboot or otherwise affect the running
 * box. Validates the new name pre-payment so a typo (uppercase, leading
 * hyphen, etc.) bounces as 400 before we charge or call Hetzner.
 *
 * Cost: 0.01 USDC.
 */
function validateRenameBody(req: AuthenticatedRequest, res: Response, next: any): void {
  const { name } = req.body as { name?: string };
  try {
    computeService.assertServerName(name);
  } catch (e: any) {
    res.status(400).json({ error: 'Invalid server name', message: e.message });
    return;
  }
  next();
}

router.put("/servers/:id", validateRenameBody, requireAuth(0.01, 'general'), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.body as { name: string };
    const updated = await computeService.renameServer(String(req.params.id), name);
    res.json({
      success: true,
      id: updated.id,
      name: updated.name,
      ipv4: updated.ipv4,
      message: `Server renamed to '${updated.name}'.`,
    });
  } catch (err: any) {
    const msg = err?.message || "Rename failed";
    if (/not found/i.test(msg)) {
      res.status(404).json({ error: "Server not found", message: msg });
      return;
    }
    await refundAndRespond(req, res, {
      reason: `Server rename failed: ${msg}`,
      userMessage: "Could not rename the server — your payment is being refunded.",
      errorLabel: "Rename failed",
    });
  }
});

/**
 * DELETE /compute/servers/:id — Destroy server permanently
 * Cost: 0.05 USDC
 */
router.delete("/servers/:id", requireAuth(0.10, 'general'), requireServerOwner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await computeService.deleteServer(String(req.params.id));
    // Drop the host-key pin so its IPv4, if Hetzner recycles it to another
    // tenant, can't carry a stale pin forward.
    clearHostKeyPin(String(req.params.id));
    res.json({ deleted: true, id: String(req.params.id), message: "Server permanently destroyed." });
  } catch (err: any) {
    await refundAndRespond(req, res, {
      reason: `Server deletion failed: ${err?.message || String(err)}`,
      userMessage: "Could not destroy the server — your payment is being refunded.",
      errorLabel: "Deletion Failed",
    });
  }
});

export default router;
