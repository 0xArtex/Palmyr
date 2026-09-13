/**
 * Pool health sweep — keeps dead stock out of the storefront and makes buyers
 * whole without waiting for them to notice.
 *
 * Until 2026-09-13 nothing watched pool inventory after it was seeded. A manual
 * audit that day found 13 suspended accounts: two still listed for sale, and
 * eight sold to agents who were never refunded because `getUserInfo()` misread
 * X's suspension response as "active" (see twitter-api.ts). Every one of them
 * would have had its dispute auto-REJECTED had the buyer filed one.
 *
 * The sweep runs twice a day and costs nothing: `user_about` and
 * `batch_info_by_ids` are both 0-credit endpoints on twitterapi.io, and the
 * batch form resolves 100 ids per call.
 *
 * What it does, by what it finds:
 *
 *   ready + suspended        → dead. Never sell a suspended account.
 *   ready + identity drift   → dead. The @handle or display name no longer
 *                              matches what we seeded, so the account is being
 *                              driven by someone else and can't be delivered
 *                              as listed. (Found in the wild: ready US stock
 *                              rebranded to a third party's crypto project.)
 *   sold  + suspended        → refund the buyer if they could still have
 *                              disputed it themselves (within DISPUTE_WINDOW_MS
 *                              of the sale) and we hold payment provenance.
 *                              Otherwise open an admin_review dispute so a
 *                              human decides.
 *   sold  + renamed          → nothing. Buyers rebrand what they bought; that
 *                              is the product working.
 *   handle gone, no rest_id  → nothing. Suspended and renamed are
 *                              indistinguishable without the stable id, and
 *                              guessing either way is worse than leaving it.
 *   no signal from the API   → nothing. A bad API day must never look like a
 *                              dead account.
 *
 * Deliberate limits:
 *
 *   • The auto-refund cutoff is the buyer's own dispute window, not "ever". An
 *     account suspended days after sale was almost certainly bad when we sold
 *     it; one suspended months later may well have been banned for what the
 *     buyer did with it, and that is a judgment call, not a sweep's decision.
 *
 *   • MAX_AUTO_REFUNDS_PER_RUN caps unattended spending. A mass-suspension
 *     event (X banning a whole supplier batch at once) parks the overflow in
 *     admin_review instead of draining the treasury while nobody is watching.
 *
 *   • Refunds route through resolveDisputeAdmin(), so every one leaves a
 *     dispute row with its detection payload attached. No bare transfers.
 *
 * Kill switch: PALMYR_POOL_HEALTH_DISABLED=1 stops the sweep entirely.
 * Interval:    PALMYR_POOL_HEALTH_INTERVAL_HOURS (default 12).
 */
import { db } from "../db";
import { getUserInfo, getUserInfosByIds, UserInfo } from "./twitter-api";
import { DISPUTE_WINDOW_MS, resolveDisputeAdmin } from "./disputes";
import { randomUUID } from "crypto";

const DEFAULT_INTERVAL_HOURS = 12;
const MAX_AUTO_REFUNDS_PER_RUN = 10;
// Small gap between handle lookups. The endpoint is free but not a firehose,
// and a pool sweep has no deadline worth hammering it for.
const PACE_MS = 150;

export interface SweepResult {
  checked: number;
  suspended: number;
  pulledFromStock: number;
  refunded: number;
  flagged: number;
  driftPulled: number;
  noSignal: number;
}

interface PoolRow {
  id: string;
  username: string;
  status: string;
  country: string | null;
  rest_id: string | null;
  sold_to_wallet: string | null;
  sold_at: string | null;
  payment_signature: string | null;
  payment_chain: string | null;
  paid_amount_usdc: number | null;
  seed_display_name: string | null;
}

/** Findings a row can produce. Ordered by how much we trust the signal. */
type Verdict =
  | { kind: "active"; display_name: string | null }
  | { kind: "suspended"; reason: string | null }
  | { kind: "renamed"; newHandle: string }
  | { kind: "gone" }
  | { kind: "no_signal" };

function note(accountId: string, text: string): void {
  db.prepare(
    "UPDATE social_account_pool SET notes = COALESCE(NULLIF(notes,'') || ' ', '') || ? WHERE id = ?",
  ).run(text, accountId);
}

function markDead(row: PoolRow, why: string): void {
  db.prepare("UPDATE social_account_pool SET status = 'dead' WHERE id = ?").run(row.id);
  note(row.id, `[health-sweep ${new Date().toISOString().slice(0, 10)}: ${why}]`);
  console.log(`[pool-health] pulled @${row.username} (${row.status} → dead): ${why}`);
}

/** Open a dispute on the buyer's behalf, carrying the detection evidence. */
function openDispute(row: PoolRow, verdictReason: string | null): string | null {
  const existing = db.prepare(
    "SELECT id FROM pool_disputes WHERE account_id = ? AND status IN ('pending','admin_review') ORDER BY created_at DESC LIMIT 1",
  ).get(row.id) as { id: string } | undefined;
  if (existing) return existing.id;
  if (!row.sold_to_wallet) return null;

  const id = "disp_" + randomUUID().replace(/-/g, "").slice(0, 16);
  db.prepare(
    "INSERT INTO pool_disputes (id, account_id, claimant_wallet, reason, evidence, detection_status, detection_payload, status) " +
    "VALUES (?, ?, ?, 'suspended', ?, 'suspended', ?, 'admin_review')",
  ).run(
    id,
    row.id,
    row.sold_to_wallet,
    `opened by the pool health sweep: X reports @${row.username} unavailable${verdictReason ? ` (${verdictReason})` : ""}. The buyer did not file this.`,
    JSON.stringify({
      source: "twitterapi.io",
      checked_at: new Date().toISOString(),
      unavailable: true,
      unavailableReason: verdictReason,
      opened_by: "pool-health-sweep",
    }),
  );
  return id;
}

function withinDisputeWindow(soldAt: string | null): boolean {
  if (!soldAt) return false;
  const ms = Date.parse(soldAt);
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms <= DISPUTE_WINDOW_MS;
}

function hasProvenance(row: PoolRow): boolean {
  return !!(row.payment_signature && row.payment_chain && row.paid_amount_usdc);
}

/**
 * Resolve one row to a verdict. `byId` holds the batched id re-checks for rows
 * whose handle came back gone; a row missing from it got no signal.
 */
function verdictFor(row: PoolRow, info: UserInfo | null, byId: Map<string, UserInfo | null>): Verdict {
  if (!info) return { kind: "no_signal" };
  if (info.status === "suspended") return { kind: "suspended", reason: info.unavailable_reason };
  if (info.status === "active") return { kind: "active", display_name: info.display_name };

  // Handle 404s. Without a stable id this is unknowable — a rename looks
  // exactly the same — so say so rather than guessing.
  if (!row.rest_id) return { kind: "gone" };
  const recheck = byId.get(row.rest_id);
  if (recheck === undefined || recheck === null) return { kind: "no_signal" };
  if (recheck.status === "suspended") return { kind: "suspended", reason: recheck.unavailable_reason };
  if (recheck.status === "active") {
    return { kind: "renamed", newHandle: recheck.username || "(unknown)" };
  }
  return { kind: "gone" };
}

/**
 * One pass over every pool account that isn't already dead.
 *
 * Never throws: a health sweep that can crash the API is worse than one that
 * misses a cycle. Individual row failures are logged and skipped.
 */
export async function sweepPoolHealth(): Promise<SweepResult> {
  const result: SweepResult = {
    checked: 0, suspended: 0, pulledFromStock: 0, refunded: 0, flagged: 0, driftPulled: 0, noSignal: 0,
  };

  const rows = db.prepare(
    "SELECT id, username, status, country, rest_id, sold_to_wallet, sold_at, " +
    "payment_signature, payment_chain, paid_amount_usdc, seed_display_name " +
    "FROM social_account_pool WHERE platform = 'twitter' AND status != 'dead' ORDER BY status, created_at",
  ).all() as PoolRow[];
  if (rows.length === 0) return result;

  // Pass 1: one handle lookup per row.
  const infos = new Map<string, UserInfo | null>();
  for (const row of rows) {
    try {
      infos.set(row.id, await getUserInfo(row.username));
    } catch (e: any) {
      console.warn(`[pool-health] @${row.username} lookup failed:`, e?.message ?? e);
      infos.set(row.id, null);
    }
    result.checked++;
    if (PACE_MS > 0) await new Promise((r) => setTimeout(r, PACE_MS));
  }

  // Pass 2: one batched id re-check for every handle that came back gone. This
  // is what separates "suspended" from "renamed, still alive" — and 100 ids
  // fit in a single call, so it costs one request for the whole pool.
  const needRecheck = rows
    .filter((r) => r.rest_id && infos.get(r.id)?.status === "not_found")
    .map((r) => r.rest_id!);
  const byId = needRecheck.length ? await getUserInfosByIds(needRecheck) : new Map<string, UserInfo | null>();

  // Pass 3: act.
  const now = new Date().toISOString();
  for (const row of rows) {
    let verdict: Verdict;
    try {
      verdict = verdictFor(row, infos.get(row.id) ?? null, byId);
    } catch (e: any) {
      console.warn(`[pool-health] @${row.username} verdict failed:`, e?.message ?? e);
      continue;
    }

    try {
      db.prepare("UPDATE social_account_pool SET health_checked_at = ? WHERE id = ?").run(now, row.id);

      if (verdict.kind === "no_signal") { result.noSignal++; continue; }
      if (verdict.kind === "gone") { continue; }

      if (verdict.kind === "active") {
        // Record the first display name we ever see as the baseline, then hold
        // later stock to it. Sold accounts are exempt: the buyer owns the
        // persona and renaming it is their prerogative.
        if (!row.seed_display_name && verdict.display_name) {
          db.prepare("UPDATE social_account_pool SET seed_display_name = ? WHERE id = ?")
            .run(verdict.display_name, row.id);
        } else if (
          row.status === "ready" &&
          row.seed_display_name &&
          verdict.display_name &&
          verdict.display_name !== row.seed_display_name
        ) {
          markDead(row, `identity drift: display name "${row.seed_display_name}" → "${verdict.display_name}"; account no longer under our control`);
          result.driftPulled++;
          result.pulledFromStock++;
        }
        continue;
      }

      if (verdict.kind === "renamed") {
        if (row.status === "ready") {
          markDead(row, `identity drift: @${row.username} now @${verdict.newHandle}; account no longer under our control`);
          result.driftPulled++;
          result.pulledFromStock++;
        }
        // Sold + renamed is the buyer using what they bought. Leave it.
        continue;
      }

      // Suspended.
      result.suspended++;
      if (row.status === "ready") {
        markDead(row, `suspended by X${verdict.reason ? ` (${verdict.reason})` : ""}`);
        result.pulledFromStock++;
        continue;
      }

      // Sold and suspended — the buyer is owed something.
      const disputeId = openDispute(row, verdict.reason);
      if (!disputeId) continue;

      const eligible = withinDisputeWindow(row.sold_at) && hasProvenance(row);
      if (!eligible) {
        result.flagged++;
        console.log(
          `[pool-health] @${row.username} suspended but not auto-refundable ` +
          `(${withinDisputeWindow(row.sold_at) ? "no payment provenance" : "outside dispute window"}) → ${disputeId} awaiting review`,
        );
        continue;
      }
      if (result.refunded >= MAX_AUTO_REFUNDS_PER_RUN) {
        result.flagged++;
        console.warn(`[pool-health] auto-refund cap (${MAX_AUTO_REFUNDS_PER_RUN}) reached — ${disputeId} left for review`);
        continue;
      }

      const refund = await resolveDisputeAdmin(disputeId, "refund", "pool health sweep: account suspended by X");
      if (refund.success) {
        result.refunded++;
        console.log(`[pool-health] refunded @${row.username} → ${row.sold_to_wallet} (${disputeId})`);
      } else {
        result.flagged++;
        console.warn(`[pool-health] refund for @${row.username} failed, left for review: ${refund.error}`);
      }
    } catch (e: any) {
      console.warn(`[pool-health] @${row.username} action failed:`, e?.message ?? e);
    }
  }

  return result;
}

/**
 * Start the twice-daily sweep. Unref'd so it never holds the process open, and
 * every error is swallowed — inventory hygiene must not be able to crash the API.
 */
export function startPoolHealthSweep(): void {
  if (process.env.PALMYR_POOL_HEALTH_DISABLED === "1") {
    console.log("[pool-health] disabled via PALMYR_POOL_HEALTH_DISABLED");
    return;
  }
  if (!process.env.TWITTER_API_IO_KEY) {
    console.warn("[pool-health] TWITTER_API_IO_KEY not set — suspended accounts will NOT be detected");
    return;
  }

  const hours = Math.max(1, Number(process.env.PALMYR_POOL_HEALTH_INTERVAL_HOURS ?? DEFAULT_INTERVAL_HOURS) || DEFAULT_INTERVAL_HOURS);
  const run = () => {
    void sweepPoolHealth()
      .then((r) => {
        if (r.suspended || r.pulledFromStock || r.refunded || r.flagged) {
          console.log(
            `[pool-health] sweep: ${r.checked} checked, ${r.suspended} suspended, ` +
            `${r.pulledFromStock} pulled from stock (${r.driftPulled} identity drift), ` +
            `${r.refunded} refunded, ${r.flagged} flagged for review, ${r.noSignal} no signal`,
          );
        }
      })
      .catch((err) => console.warn("[pool-health] sweep failed:", err?.message ?? err));
  };

  console.log(`[pool-health] sweeping pool stock every ${hours}h; auto-refund cap ${MAX_AUTO_REFUNDS_PER_RUN}/run`);
  run();
  setInterval(run, hours * 60 * 60 * 1000).unref();
}
