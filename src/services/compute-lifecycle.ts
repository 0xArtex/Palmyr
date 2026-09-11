/**
 * VPS billing-period enforcement — the "lapse ladder".
 *
 * `GET /compute/plans` has always advertised `billingPeriod: "monthly"`, but
 * nothing ever recorded when a period ended. A single deploy payment therefore
 * bought an indefinitely-running box: by the time this shipped, three tenants
 * had been running 79–102 days on one month's fee.
 *
 * Every server now carries `paid_through`. When it passes, the server walks
 * down four rungs, each one recorded on the row so a restart can't replay a
 * step or skip one:
 *
 *   notify     paid_through elapsed          → webhook + inbox + API flag
 *   idle       NOTIFY_TO_IDLE_DAYS later     → poweroff (disk intact)
 *   terminate  NOTIFY_TO_TERMINATE_DAYS later→ snapshot, then destroy the box
 *   gc         SNAPSHOT_RETAIN_DAYS later    → delete the snapshot
 *
 * Two deliberate properties:
 *
 *   • The grace clock runs from `expiry_notified_at`, not `paid_through`. A
 *     server that has been overdue for months therefore gets the full grace
 *     window starting the day we first tell its owner — nobody is powered off
 *     or destroyed over a bill they were never sent.
 *
 *   • Termination snapshots before it destroys. Hetzner keeps charging for a
 *     merely powered-off server, so stopping the bleed means deleting the box;
 *     without a snapshot that would turn a missed renewal into permanent data
 *     loss. The snapshot costs cents per month and is what
 *     `POST /compute/servers/:id/restore` rebuilds from.
 *
 * Renewal (`POST /compute/servers/:id/renew`) extends `paid_through` and
 * clears the notify/idle timestamps, so the ladder resets from the top.
 *
 * Kill switch: PALMYR_VPS_LIFECYCLE_DISABLED=1 stops the sweep entirely.
 */
import { db, SERVER_BILLING_DAYS } from "../db";
import { storage } from "./storage";
import * as computeService from "./compute";
import { notifyAgent } from "./notifications";

function envDays(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Days from the expiry notice to powering the box off. */
const NOTIFY_TO_IDLE_DAYS = envDays("PALMYR_VPS_IDLE_GRACE_DAYS", 3);
/** Days from the expiry notice to snapshot + destroy. */
const NOTIFY_TO_TERMINATE_DAYS = envDays("PALMYR_VPS_TERMINATE_GRACE_DAYS", 7);
/** How long a lapsed server's snapshot is kept before it is GC'd for good. */
const SNAPSHOT_RETAIN_DAYS = envDays("PALMYR_VPS_SNAPSHOT_RETAIN_DAYS", 30);

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DOCS = "https://docs.palmyr.ai/services/compute#renewals";

interface LapsedRow {
  id: string;
  name: string;
  owner: string;
  server_type: string;
  price_monthly: string;
  paid_through: string;
  expiry_notified_at: string | null;
  idled_at: string | null;
  terminated_at: string | null;
  snapshot_id: string | null;
  snapshot_expires_at: string | null;
}

const nowIso = () => new Date().toISOString();

/** SQLite modifier string, e.g. "+3 days". */
const days = (n: number) => `+${n} days`;

// ── Billing period ────────────────────────────────────────────

/**
 * Extend a server's paid-through by one billing period.
 *
 * Renewing early stacks on the time that's left rather than discarding it, so
 * an agent that renews a week ahead of expiry keeps that week. Renewing late
 * starts the new period now — we don't bill for the lapsed stretch, since the
 * box was idle or gone for it.
 */
export function extendPaidThrough(serverId: string): string {
  const row = db
    .prepare("SELECT paid_through FROM servers WHERE id = ?")
    .get(serverId) as { paid_through: string | null } | undefined;

  const base =
    row?.paid_through && new Date(row.paid_through).getTime() > Date.now()
      ? new Date(row.paid_through)
      : new Date();

  const next = new Date(base.getTime() + SERVER_BILLING_DAYS * 86_400_000).toISOString();
  storage.setServerPaidThrough(serverId, next);
  return next;
}

/**
 * Reset the ladder after a payment lands: clear the notice and the idle mark so
 * a renewed server starts from the top rung again. Does NOT clear
 * `terminated_at` — a destroyed box comes back through `restore`, not `renew`.
 */
export function clearLapseState(serverId: string): void {
  db.prepare(
    "UPDATE servers SET expiry_notified_at = NULL, idled_at = NULL WHERE id = ?",
  ).run(serverId);
}

// ── Owner-facing view ─────────────────────────────────────────

export type LifecycleState = "active" | "expired" | "idled" | "terminated";

export interface LifecycleView {
  state: LifecycleState;
  paidThrough: string | null;
  daysRemaining: number | null;
  /** Set once the owner has been told the period lapsed. */
  notifiedAt?: string;
  /** When each remaining rung fires if nothing is paid. */
  idleAt?: string;
  terminateAt?: string;
  idledAt?: string;
  terminatedAt?: string;
  /** Present while a terminated server is still restorable. */
  restorableUntil?: string;
  renew?: string;
  restore?: string;
  message?: string;
}

/**
 * Render a server's billing state for API responses. This is the channel that
 * actually reaches an agent — webhooks need a registered URL, but every agent
 * polling `GET /compute/servers` sees this.
 */
export function lifecycleView(server: {
  id: string;
  paidThrough?: string | null;
  expiryNotifiedAt?: string | null;
  idledAt?: string | null;
  terminatedAt?: string | null;
  snapshotExpiresAt?: string | null;
}): LifecycleView {
  const paidThrough = server.paidThrough ?? null;
  const now = Date.now();
  const end = paidThrough ? new Date(paidThrough).getTime() : null;
  const daysRemaining =
    end === null ? null : Math.ceil((end - now) / 86_400_000);

  const renew = `POST /compute/servers/${server.id}/renew`;

  if (server.terminatedAt) {
    const restorable = server.snapshotExpiresAt ?? undefined;
    return {
      state: "terminated",
      paidThrough,
      daysRemaining,
      terminatedAt: server.terminatedAt,
      ...(restorable ? { restorableUntil: restorable } : {}),
      restore: `POST /compute/servers/${server.id}/restore`,
      message: restorable
        ? `Billing period lapsed — the server was snapshotted and destroyed. Restore it from the snapshot until ${restorable}, after which the snapshot is deleted.`
        : "Billing period lapsed — the server was destroyed and its snapshot has been deleted.",
    };
  }

  const notified = server.expiryNotifiedAt ?? undefined;
  const rung = (n: number) =>
    notified ? new Date(new Date(notified).getTime() + n * 86_400_000).toISOString() : undefined;

  if (server.idledAt) {
    return {
      state: "idled",
      paidThrough,
      daysRemaining,
      notifiedAt: notified,
      idledAt: server.idledAt,
      terminateAt: rung(NOTIFY_TO_TERMINATE_DAYS),
      renew,
      message: `Billing period lapsed — the server is powered off but intact. Renew to power it back on. If it is still unpaid on ${rung(NOTIFY_TO_TERMINATE_DAYS)} it will be snapshotted and destroyed.`,
    };
  }

  if (end !== null && end <= now) {
    return {
      state: "expired",
      paidThrough,
      daysRemaining,
      notifiedAt: notified,
      idleAt: rung(NOTIFY_TO_IDLE_DAYS),
      terminateAt: rung(NOTIFY_TO_TERMINATE_DAYS),
      renew,
      message: notified
        ? `Billing period ended ${paidThrough}. Renew to keep the server running — it powers off on ${rung(NOTIFY_TO_IDLE_DAYS)} and is snapshotted and destroyed on ${rung(NOTIFY_TO_TERMINATE_DAYS)}.`
        : `Billing period ended ${paidThrough}. Renew to keep the server running.`,
    };
  }

  return { state: "active", paidThrough, daysRemaining, renew };
}

// ── Notification ──────────────────────────────────────────────

/**
 * Tell a server's owner something about its billing period, on every channel
 * we have for them: the agent inbox (always — keyed by the owner string, which
 * is the wallet that paid), and a webhook if they registered one.
 *
 * Never throws — a failed notification must not stall the sweep. Returns
 * whether the notice was actually durably delivered: the expiry rung refuses
 * to start the grace clock on a notice that failed to land, because every
 * later rung (power off, destroy) is justified only by the owner having been
 * told first. A webhook is best-effort on top; most owners have none.
 */
async function notifyOwner(
  owner: string,
  event: string,
  subject: string,
  body: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  let delivered = false;
  try {
    db.prepare(
      "INSERT INTO agent_inbox (from_agent, to_agent, subject, body) VALUES (?, ?, ?, ?)",
    ).run("palmyr", owner, subject, body);
    delivered = true;
  } catch (err: any) {
    console.warn(`[compute-lifecycle] inbox write failed for ${owner}:`, err?.message ?? err);
  }

  try {
    // notifyAgent is keyed by agents.id; the server owner is a wallet address.
    const agent = db
      .prepare("SELECT id FROM agents WHERE wallet_address = ?")
      .get(owner) as { id: string } | undefined;
    if (agent) await notifyAgent(agent.id, event, data);
  } catch (err: any) {
    console.warn(`[compute-lifecycle] webhook notify failed for ${owner}:`, err?.message ?? err);
  }

  return delivered;
}

// ── Ladder rungs ──────────────────────────────────────────────

/**
 * Rung 0 — reconcile rows whose box is already gone from Hetzner.
 *
 * The `servers` table outlives the servers: some were deleted straight from
 * the Hetzner console and their rows still read "running" months later. Left
 * alone they would each earn their owner a "renew or we destroy it" notice
 * about a server that no longer exists, then fail a poweroff against a 404 on
 * every sweep forever. Marking them terminated (with no snapshot — there is no
 * disk left to image) retires them silently.
 *
 * Only runs against servers that have actually lapsed, so a healthy paying
 * tenant never costs us an extra API call.
 */
async function reconcileVanished(): Promise<number> {
  const rows = db
    .prepare(
      `SELECT * FROM servers
        WHERE terminated_at IS NULL
          AND paid_through IS NOT NULL
          AND datetime(paid_through) <= datetime('now')`,
    )
    .all() as LapsedRow[];

  let done = 0;
  for (const row of rows) {
    try {
      if (await computeService.serverExistsAtProvider(row.id)) continue;
      db.prepare(
        "UPDATE servers SET terminated_at = ?, status = 'deleted' WHERE id = ?",
      ).run(nowIso(), row.id);
      done++;
      console.log(`[compute-lifecycle] reconciled ${row.id} (${row.name}) — already gone from Hetzner`);
    } catch (err: any) {
      // Transient API trouble: leave the row alone and retry next sweep. The
      // rungs below are guarded the same way, so nothing acts on a stale row
      // in the meantime beyond a logged failure.
      console.warn(`[compute-lifecycle] existence check failed for ${row.id}:`, err?.message ?? err);
    }
  }

  return done;
}

/** Rung 1 — the period lapsed and the owner hasn't been told yet. */
async function notifyExpired(): Promise<number> {
  const rows = db
    .prepare(
      `SELECT * FROM servers
        WHERE terminated_at IS NULL
          AND expiry_notified_at IS NULL
          AND paid_through IS NOT NULL
          AND datetime(paid_through) <= datetime('now')`,
    )
    .all() as LapsedRow[];

  let done = 0;
  for (const row of rows) {
    const at = nowIso();
    const idleAt = new Date(Date.now() + NOTIFY_TO_IDLE_DAYS * 86_400_000).toISOString();
    const terminateAt = new Date(Date.now() + NOTIFY_TO_TERMINATE_DAYS * 86_400_000).toISOString();

    // Quote the LIVE catalog price — the same number the renew paywall will
    // charge. `price_monthly` is what this tenant paid at deploy time and can
    // be months stale (cpx32 has since gone $25 -> $63); quoting it would
    // promise a price we then refuse. Call out the change so the difference
    // isn't a surprise at the paywall.
    const renewPrice = computeService.priceForServerType(row.server_type).toFixed(2);
    const paidBefore = Number(row.price_monthly);
    const priceChanged = Number.isFinite(paidBefore) && paidBefore.toFixed(2) !== renewPrice;

    const delivered = await notifyOwner(
      row.owner,
      "server.billing.expired",
      `Action needed: ${row.name} billing period ended`,
      [
        `Your server "${row.name}" (${row.id}, ${row.server_type}) reached the end of its paid period on ${row.paid_through}.`,
        ``,
        `Renew for ${renewPrice} USDC to keep it running:`,
        `  POST /compute/servers/${row.id}/renew`,
        `  palmyr compute renew ${row.id}`,
        ...(priceChanged
          ? [``, `(You paid ${paidBefore.toFixed(2)} USDC when you deployed. ${renewPrice} is the current ${row.server_type} price — see GET /compute/plans.)`]
          : []),
        ``,
        `If it is still unpaid:`,
        `  ${idleAt} — powered off (disk kept intact, renew powers it back on)`,
        `  ${terminateAt} — snapshotted and destroyed; restore from the snapshot for ${SNAPSHOT_RETAIN_DAYS} days after that`,
        ``,
        DOCS,
      ].join("\n"),
      {
        serverId: row.id,
        serverName: row.name,
        paidThrough: row.paid_through,
        priceUsdc: renewPrice,
        ...(priceChanged ? { previousPriceUsdc: paidBefore.toFixed(2) } : {}),
        idleAt,
        terminateAt,
        renew: `POST /compute/servers/${row.id}/renew`,
      },
    );

    if (!delivered) {
      // Leave expiry_notified_at NULL and retry next sweep. Better to keep
      // paying Hetzner for another hour than to power off a box whose owner
      // was never told.
      console.warn(`[compute-lifecycle] could not deliver expiry notice for ${row.id}; grace clock NOT started`);
      continue;
    }

    db.prepare("UPDATE servers SET expiry_notified_at = ? WHERE id = ?").run(at, row.id);
    done++;
    console.log(`[compute-lifecycle] notified ${row.owner} that ${row.id} (${row.name}) lapsed on ${row.paid_through}`);
  }

  return done;
}

/** Rung 2 — grace elapsed with no payment: power the box off, keep the disk. */
async function idleLapsed(): Promise<number> {
  const rows = db
    .prepare(
      `SELECT * FROM servers
        WHERE terminated_at IS NULL
          AND idled_at IS NULL
          AND expiry_notified_at IS NOT NULL
          AND datetime(paid_through) <= datetime('now')
          AND datetime(expiry_notified_at, ?) <= datetime('now')`,
    )
    .all(days(NOTIFY_TO_IDLE_DAYS)) as LapsedRow[];

  let done = 0;
  for (const row of rows) {
    try {
      await computeService.serverAction(row.id, "poweroff");
      db.prepare("UPDATE servers SET idled_at = ? WHERE id = ?").run(nowIso(), row.id);
      done++;

      const terminateAt = new Date(
        new Date(row.expiry_notified_at!).getTime() + NOTIFY_TO_TERMINATE_DAYS * 86_400_000,
      ).toISOString();

      await notifyOwner(
        row.owner,
        "server.billing.idled",
        `${row.name} powered off — unpaid`,
        [
          `Your server "${row.name}" (${row.id}) has been powered off because its billing period ended on ${row.paid_through} and no renewal was received.`,
          ``,
          `The disk is untouched. Renewing powers it straight back on:`,
          `  POST /compute/servers/${row.id}/renew`,
          ``,
          `Still unpaid on ${terminateAt}: the server is snapshotted and destroyed, and restorable from that snapshot for ${SNAPSHOT_RETAIN_DAYS} days.`,
          ``,
          DOCS,
        ].join("\n"),
        { serverId: row.id, serverName: row.name, terminateAt, renew: `POST /compute/servers/${row.id}/renew` },
      );

      console.log(`[compute-lifecycle] idled ${row.id} (${row.name}) — unpaid since ${row.paid_through}`);
    } catch (err: any) {
      // Leave idled_at NULL so the next sweep retries. A box that's already
      // off (or gone from Hetzner) surfaces here as an error; that's fine —
      // the terminate rung reconciles it either way.
      console.warn(`[compute-lifecycle] poweroff failed for ${row.id}:`, err?.message ?? err);
    }
  }

  return done;
}

/** Rung 3 — snapshot, then destroy the box so Hetzner stops billing us. */
async function terminateLapsed(): Promise<number> {
  const rows = db
    .prepare(
      `SELECT * FROM servers
        WHERE terminated_at IS NULL
          AND expiry_notified_at IS NOT NULL
          AND datetime(paid_through) <= datetime('now')
          AND datetime(expiry_notified_at, ?) <= datetime('now')`,
    )
    .all(days(NOTIFY_TO_TERMINATE_DAYS)) as LapsedRow[];

  let done = 0;
  for (const row of rows) {
    try {
      // Snapshot FIRST. If this fails we abort and retry next sweep rather
      // than destroy a box whose data we can't give back.
      const snapshotId =
        row.snapshot_id ??
        (await computeService.createSnapshot(
          row.id,
          `palmyr lapsed ${row.name} (${row.id})`,
        ));

      const snapshotExpires = new Date(
        Date.now() + SNAPSHOT_RETAIN_DAYS * 86_400_000,
      ).toISOString();

      // Record the snapshot before destroying, so a crash between the two
      // leaves a recoverable pointer rather than an orphaned image.
      db.prepare(
        "UPDATE servers SET snapshot_id = ?, snapshot_expires_at = ? WHERE id = ?",
      ).run(snapshotId, snapshotExpires, row.id);

      await computeService.destroyServerAtProvider(row.id);

      db.prepare(
        "UPDATE servers SET terminated_at = ?, status = 'terminated' WHERE id = ?",
      ).run(nowIso(), row.id);

      // A destroyed box's host key is meaningless, and Hetzner recycles IPs.
      // Lazy import: clearHostKeyPin lives in the route module, which imports
      // this service's siblings.
      try {
        const { clearHostKeyPin } = await import("../routes/compute");
        clearHostKeyPin(row.id);
      } catch { /* pin cleanup is best-effort */ }

      done++;

      await notifyOwner(
        row.owner,
        "server.billing.terminated",
        `${row.name} destroyed — snapshot kept until ${snapshotExpires}`,
        [
          `Your server "${row.name}" (${row.id}) was destroyed after its billing period ended on ${row.paid_through} and went unpaid through the grace window.`,
          ``,
          `Its disk was snapshotted first. You can rebuild from that snapshot until ${snapshotExpires}:`,
          `  POST /compute/servers/${row.id}/restore`,
          ``,
          `After that date the snapshot is deleted and the data is gone for good.`,
          ``,
          DOCS,
        ].join("\n"),
        {
          serverId: row.id,
          serverName: row.name,
          snapshotId,
          restorableUntil: snapshotExpires,
          restore: `POST /compute/servers/${row.id}/restore`,
        },
      );

      console.log(`[compute-lifecycle] terminated ${row.id} (${row.name}); snapshot ${snapshotId} kept until ${snapshotExpires}`);
    } catch (err: any) {
      console.warn(`[compute-lifecycle] terminate failed for ${row.id}:`, err?.message ?? err);
    }
  }

  return done;
}

/** Rung 4 — retention elapsed: drop the snapshot and stop paying for it. */
async function gcSnapshots(): Promise<number> {
  const rows = db
    .prepare(
      `SELECT * FROM servers
        WHERE snapshot_id IS NOT NULL
          AND snapshot_expires_at IS NOT NULL
          AND datetime(snapshot_expires_at) <= datetime('now')`,
    )
    .all() as LapsedRow[];

  let done = 0;
  for (const row of rows) {
    try {
      await computeService.deleteImage(row.snapshot_id!);
      db.prepare(
        "UPDATE servers SET snapshot_id = NULL, snapshot_expires_at = NULL WHERE id = ?",
      ).run(row.id);
      done++;
      console.log(`[compute-lifecycle] GC'd snapshot ${row.snapshot_id} for ${row.id} (${row.name})`);
    } catch (err: any) {
      console.warn(`[compute-lifecycle] snapshot GC failed for ${row.id}:`, err?.message ?? err);
    }
  }

  return done;
}

// ── Sweep ─────────────────────────────────────────────────────

/**
 * Walk every rung once. Exported so tests and ops can run a sweep on demand
 * without waiting for the hourly timer.
 */
export async function sweepLapsedServers(): Promise<{
  reconciled: number;
  notified: number;
  idled: number;
  terminated: number;
  snapshotsDeleted: number;
}> {
  const reconciled = await reconcileVanished();
  const notified = await notifyExpired();
  const idled = await idleLapsed();
  const terminated = await terminateLapsed();
  const snapshotsDeleted = await gcSnapshots();
  return { reconciled, notified, idled, terminated, snapshotsDeleted };
}

/**
 * Start the hourly sweep. Unref'd so it never holds the process open, and
 * every error is swallowed — a billing sweep must not be able to crash the API.
 */
export function startComputeLifecycle(): void {
  if (process.env.PALMYR_VPS_LIFECYCLE_DISABLED === "1") {
    console.log("[compute-lifecycle] disabled via PALMYR_VPS_LIFECYCLE_DISABLED");
    return;
  }

  const run = () => {
    void sweepLapsedServers()
      .then(({ reconciled, notified, idled, terminated, snapshotsDeleted }) => {
        if (reconciled || notified || idled || terminated || snapshotsDeleted) {
          console.log(
            `[compute-lifecycle] sweep: ${reconciled} reconciled, ${notified} notified, ${idled} idled, ${terminated} terminated, ${snapshotsDeleted} snapshot(s) GC'd`,
          );
        }
      })
      .catch(err => console.warn("[compute-lifecycle] sweep failed:", err?.message ?? err));
  };

  console.log(
    `[compute-lifecycle] billing period ${SERVER_BILLING_DAYS}d; idle at notice+${NOTIFY_TO_IDLE_DAYS}d, terminate at notice+${NOTIFY_TO_TERMINATE_DAYS}d, snapshots kept ${SNAPSHOT_RETAIN_DAYS}d`,
  );
  run();
  setInterval(run, SWEEP_INTERVAL_MS).unref();
}
