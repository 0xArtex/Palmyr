/**
 * Pool account disputes — buyer files a complaint about a recently purchased
 * X account, server auto-verifies via twitterapi.io, and either replaces
 * from same-country stock or refunds the original payer.
 *
 * Decision tree on createDispute():
 *
 *   1. Validate: account exists, was sold to the claimant, sold within 7
 *      days, not already disputed, not already dead.
 *
 *   2. Auto-verify via twitterapi.io GET /twitter/user/info:
 *        - status='suspended' or 'not_found' → confirmed bad (but see 2a)
 *        - status='active'                   → reject the dispute (account is fine)
 *        - twitterapi.io unavailable / null  → queue for admin review
 *
 *   2a. Rebrand-fraud guard. A genuinely suspended account and a handle the
 *       buyer simply RENAMED both 404 by handle — indistinguishable. When the
 *       row carries a stable numeric id (rest_id, captured at seed time), a
 *       404 is re-checked BY ID (a rename preserves it). If the id still
 *       resolves to a LIVE account, the buyer rebranded and still controls it
 *       → admin_review, NOT auto-resolve. If the id is also gone → genuinely
 *       bad, proceed. Legacy rows with no rest_id skip this guard.
 *
 *   3. On confirmed bad:
 *        a. Find oldest 'ready' pool row with matching country.
 *           Found → atomic transaction: transfer ownership of replacement,
 *           mark old account 'dead'. Dispute → status='replaced'.
 *        b. No replacement → fire refund via refundUsdcToPayer using the
 *           payment_signature/chain/paid_amount_usdc stored at buy time.
 *           Dispute → status='refunded'.
 *        c. If refund fails (missing payment context for legacy rows, or
 *           refund tx reverts) → queue for admin_review with a clear
 *           resolution note so ops can manually settle.
 *
 *   4. Reason='other' or unverified → always admin_review queue.
 *
 * Admin can override any auto-decision via resolveDisputeAdmin().
 *
 * Idempotency: only one pending/admin_review dispute per account_id can
 * exist at a time. Repeat createDispute() calls return the existing record.
 */
import { db } from "../db";
import { randomUUID } from "crypto";
import { getUserInfo, getUserInfoById } from "./twitter-api";
import { refundUsdcToPayer } from "./refund";

/**
 * How long after a sale a buyer can still dispute. Exported because the pool
 * health sweep refunds suspended accounts on the buyer's behalf and uses the
 * same cutoff — if the buyer could still have claimed it themselves, we do it
 * for them rather than waiting for them to notice.
 */
export const DISPUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Self-contained schema guard: the rebrand-fraud check reads social_account_pool.rest_id,
// but this module deliberately does NOT import social-pool.ts (that would pull
// playwright in via social-login). So we ensure the column here too —
// idempotent and identical to social-pool.ts's guard. Both run at module load,
// after db.ts's initDatabase() has created the table.
(function ensurePoolRestIdColumn() {
  try {
    const cols = db.prepare("PRAGMA table_info(social_account_pool)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "rest_id")) {
      db.exec("ALTER TABLE social_account_pool ADD COLUMN rest_id TEXT");
    }
  } catch (e: any) {
    console.warn("[disputes] could not ensure rest_id column:", e?.message || e);
  }
})();

export type DisputeStatus =
  | "pending"
  | "admin_review"
  | "replaced"
  | "refunded"
  | "rejected";

export interface DisputeRecord {
  id: string;
  account_id: string;
  claimant_wallet: string;
  reason: "suspended" | "other";
  evidence: string | null;
  detection_status: string | null;
  detection_payload: string | null;
  status: DisputeStatus;
  resolution: string | null;
  replacement_account_id: string | null;
  refund_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface CreateDisputeRequest {
  account_id: string;
  claimant_wallet: string;
  reason: "suspended" | "other";
  evidence?: string;
}

export interface DisputeResult {
  success: boolean;
  dispute?: DisputeRecord;
  error?: string;
}

function getRowById(id: string): DisputeRecord | null {
  const row = db.prepare("SELECT * FROM pool_disputes WHERE id = ?").get(id) as any;
  return row || null;
}

export function getDispute(id: string): DisputeRecord | null {
  return getRowById(id);
}

export function listDisputes(opts: { status?: string; claimant?: string } = {}): DisputeRecord[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.claimant) {
    where.push("claimant_wallet = ?");
    params.push(opts.claimant);
  }
  const sql =
    "SELECT * FROM pool_disputes" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY created_at DESC LIMIT 200";
  return db.prepare(sql).all(...params) as DisputeRecord[];
}

interface PoolAccountRow {
  id: string;
  username: string;
  country: string | null;
  sold_to_wallet: string | null;
  sold_at: string | null;
  status: string;
  payment_signature: string | null;
  payment_chain: string | null;
  paid_amount_usdc: number | null;
  rest_id: string | null;
}

function getAccount(id: string): PoolAccountRow | null {
  const row = db.prepare(`
    SELECT id, username, country, sold_to_wallet, sold_at, status,
           payment_signature, payment_chain, paid_amount_usdc, rest_id
    FROM social_account_pool WHERE id = ?
  `).get(id) as PoolAccountRow | undefined;
  return row || null;
}

export async function createDispute(req: CreateDisputeRequest): Promise<DisputeResult> {
  if (!req.account_id) return { success: false, error: "account_id required" };
  if (!req.claimant_wallet) return { success: false, error: "claimant_wallet required" };
  if (req.reason !== "suspended" && req.reason !== "other") {
    return { success: false, error: 'reason must be "suspended" or "other"' };
  }

  const account = getAccount(req.account_id);
  if (!account) return { success: false, error: "account not found" };
  if (account.sold_to_wallet !== req.claimant_wallet) {
    return { success: false, error: "account not owned by claimant" };
  }
  if (account.status === "dead") {
    return { success: false, error: "account already marked dead" };
  }
  if (!account.sold_at) {
    return { success: false, error: "account has no sold_at — internal inconsistency" };
  }
  const soldAtMs = Date.parse(account.sold_at);
  if (!Number.isFinite(soldAtMs)) {
    return { success: false, error: "invalid sold_at on account" };
  }
  const ageMs = Date.now() - soldAtMs;
  if (ageMs > DISPUTE_WINDOW_MS) {
    return {
      success: false,
      error: `dispute window expired (>${Math.floor(DISPUTE_WINDOW_MS / 86_400_000)} days since purchase)`,
    };
  }

  // Idempotency: don't allow a second open dispute for the same account.
  const existing = db.prepare(`
    SELECT id FROM pool_disputes
    WHERE account_id = ? AND status IN ('pending', 'admin_review')
    ORDER BY created_at DESC LIMIT 1
  `).get(req.account_id) as { id: string } | undefined;
  if (existing) {
    return { success: true, dispute: getRowById(existing.id)! };
  }

  const id = "disp_" + randomUUID().replace(/-/g, "").slice(0, 16);
  db.prepare(`
    INSERT INTO pool_disputes (id, account_id, claimant_wallet, reason, evidence, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(id, req.account_id, req.claimant_wallet, req.reason, req.evidence || null);

  // Auto-verify only when reason='suspended'. For reason='other', queue
  // straight to admin review — the buyer must explain in `evidence` and a
  // human decides.
  if (req.reason !== "suspended") {
    db.prepare("UPDATE pool_disputes SET status = 'admin_review' WHERE id = ?").run(id);
    return { success: true, dispute: getRowById(id)! };
  }

  // Live-check via twitterapi.io. null means "no signal" — queue for admin,
  // don't auto-resolve. The signal is conservative: only 'suspended' or
  // 'not_found' trigger auto-resolution.
  const info = await getUserInfo(account.username);
  const detectionStatus = info?.status || "unknown";
  const detectionPayload = info ? JSON.stringify(info) : null;
  db.prepare(`
    UPDATE pool_disputes SET detection_status = ?, detection_payload = ? WHERE id = ?
  `).run(detectionStatus, detectionPayload, id);

  if (detectionStatus === "active") {
    // X says the account is fine — reject the dispute.
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE pool_disputes
      SET status = 'rejected',
          resolution = 'rejected: twitterapi.io reports account active',
          resolved_at = ?
      WHERE id = ?
    `).run(now, id);
    return { success: true, dispute: getRowById(id)! };
  }

  if (detectionStatus === "suspended" || detectionStatus === "not_found") {
    // Rebrand-fraud guard. A genuinely suspended account AND a handle that the
    // buyer simply RENAMED both 404 by handle — they're indistinguishable this
    // way. If we captured the account's stable numeric id at seed time, re-check
    // by id (a rename preserves it):
    //   - id still resolves to a LIVE account → the buyer just changed the
    //     @handle and still controls the account. Auto-resolving here would
    //     hand them a free replacement / refund while they keep the working
    //     account → route to admin_review instead.
    //   - id is also gone → genuinely suspended/deleted → auto-resolve as before.
    //   - id recheck inconclusive (API error) → don't auto-resolve on an
    //     unverifiable 404; let a human settle.
    // Rows with no stored rest_id (legacy/pre-fix) skip this and keep the
    // current behavior.
    if (account.rest_id) {
      const byId = await getUserInfoById(account.rest_id);
      if (byId && byId.status === "active") {
        const now = new Date().toISOString();
        const newHandle = byId.username && byId.username !== account.username
          ? ` → @${byId.username}`
          : "";
        db.prepare(`
          UPDATE pool_disputes
          SET status = 'admin_review',
              resolution = ?
          WHERE id = ?
        `).run(
          `account appears rebranded, still live: @${account.username}${newHandle} (rest_id ${account.rest_id} resolves to an active account)`,
          id,
        );
        return { success: true, dispute: getRowById(id)! };
      }
      if (!byId) {
        db.prepare(`
          UPDATE pool_disputes
          SET status = 'admin_review',
              resolution = 'handle 404 but rest_id recheck unavailable — needs manual verify'
          WHERE id = ?
        `).run(id);
        return { success: true, dispute: getRowById(id)! };
      }
      // byId resolved and the id is gone too → genuinely dead. Fall through.
    }
    return await resolveAutoVerified(id, account);
  }

  // Unknown / API unreachable → human decides.
  db.prepare("UPDATE pool_disputes SET status = 'admin_review' WHERE id = ?").run(id);
  return { success: true, dispute: getRowById(id)! };
}

/**
 * Confirmed-bad path: try same-country replacement first; if none, refund.
 * Atomic w.r.t. the replacement pool row via the SQLite transaction.
 */
async function resolveAutoVerified(disputeId: string, deadAccount: PoolAccountRow): Promise<DisputeResult> {
  const replacementId = tryReserveReplacement(deadAccount);
  if (replacementId) {
    finalizeReplacement(disputeId, deadAccount.id, replacementId);
    return { success: true, dispute: getRowById(disputeId)! };
  }

  // No replacement in same country → refund.
  if (!deadAccount.payment_signature || !deadAccount.payment_chain || !deadAccount.paid_amount_usdc) {
    // Pre-feature row with no payment provenance — can't auto-refund. Mark
    // the account dead and queue for admin to manually settle.
    markAccountDead(deadAccount.id, disputeId);
    db.prepare(`
      UPDATE pool_disputes
      SET status = 'admin_review',
          resolution = 'no_replacement_available_and_no_payment_provenance'
      WHERE id = ?
    `).run(disputeId);
    return { success: true, dispute: getRowById(disputeId)! };
  }

  const refund = await refundUsdcToPayer({
    chain: deadAccount.payment_chain as "solana" | "base",
    payer: deadAccount.sold_to_wallet!,
    amountUsdc: deadAccount.paid_amount_usdc,
    reason: `dispute ${disputeId}: account @${deadAccount.username} suspended, no replacement in stock`,
    originalPaymentSignature: deadAccount.payment_signature,
    endpoint: "POST /social/twitter/dispute",
  });

  const now = new Date().toISOString();
  if (refund.ok) {
    markAccountDead(deadAccount.id, disputeId);
    db.prepare(`
      UPDATE pool_disputes
      SET status = 'refunded',
          resolution = ?,
          refund_id = ?,
          resolved_at = ?
      WHERE id = ?
    `).run(`refunded:${refund.refundTx || refund.refundId}`, refund.refundId, now, disputeId);
  } else {
    // Refund failed — keep account live for now, surface to admin so a human
    // can decide whether to retry the refund manually or escalate.
    db.prepare(`
      UPDATE pool_disputes
      SET status = 'admin_review',
          resolution = ?,
          refund_id = ?
      WHERE id = ?
    `).run(`refund_failed: ${refund.reason || "unknown"}`, refund.refundId, disputeId);
  }

  return { success: true, dispute: getRowById(disputeId)! };
}

function tryReserveReplacement(deadAccount: PoolAccountRow): string | null {
  if (!deadAccount.country) return null;
  const tx = db.transaction(() => {
    const candidate = db.prepare(`
      SELECT id FROM social_account_pool
      WHERE status = 'ready' AND platform = 'twitter' AND country = ?
        AND id != ?
      ORDER BY created_at ASC LIMIT 1
    `).get(deadAccount.country, deadAccount.id) as { id: string } | undefined;
    if (!candidate) return null;

    const r = db.prepare(`
      UPDATE social_account_pool
      SET status = 'sold',
          sold_to_wallet = ?,
          sold_at = ?,
          payment_signature = ?,
          payment_chain = ?,
          paid_amount_usdc = ?
      WHERE id = ? AND status = 'ready'
    `).run(
      deadAccount.sold_to_wallet,
      new Date().toISOString(),
      // Carry over the original buy's payment provenance so a SECOND dispute
      // on the replacement can still refund against the original transaction.
      deadAccount.payment_signature,
      deadAccount.payment_chain,
      deadAccount.paid_amount_usdc,
      candidate.id,
    );
    return r.changes === 1 ? candidate.id : null;
  });
  return tx();
}

function finalizeReplacement(disputeId: string, deadId: string, replacementId: string): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    markAccountDead(deadId, disputeId);
    db.prepare(`
      UPDATE pool_disputes
      SET status = 'replaced',
          resolution = ?,
          replacement_account_id = ?,
          resolved_at = ?
      WHERE id = ?
    `).run(`replaced:${replacementId}`, replacementId, now, disputeId);
  })();
}

function markAccountDead(accountId: string, disputeId: string): void {
  db.prepare(`
    UPDATE social_account_pool
    SET status = 'dead',
        notes = COALESCE(notes || ' ', '') || ?
    WHERE id = ?
  `).run(`[dispute:${disputeId}]`, accountId);
}

/* ─── Admin override ─────────────────────────────────────────────────── */

export type AdminAction = "replace" | "refund" | "reject";

/**
 * Admin override on a dispute. Used to settle the admin_review queue —
 * either confirm an auto-resolution that the API couldn't verify, or take
 * a different action than the auto-flow would have.
 *
 * 'replace' — same logic as auto-replacement; needs same-country stock.
 * 'refund'  — fires refundUsdcToPayer using the account's payment columns.
 * 'reject'  — marks dispute rejected and leaves the account intact.
 */
export async function resolveDisputeAdmin(
  id: string,
  action: AdminAction,
  note?: string,
): Promise<DisputeResult> {
  const dispute = getRowById(id);
  if (!dispute) return { success: false, error: "dispute not found" };
  if (dispute.status === "replaced" || dispute.status === "refunded" || dispute.status === "rejected") {
    return { success: false, error: `dispute already resolved (${dispute.status})` };
  }

  const account = getAccount(dispute.account_id);
  if (!account) return { success: false, error: "underlying account not found" };

  if (action === "reject") {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE pool_disputes
      SET status = 'rejected', resolution = ?, resolved_at = ?
      WHERE id = ?
    `).run(`rejected by admin${note ? `: ${note}` : ""}`, now, id);
    return { success: true, dispute: getRowById(id)! };
  }

  if (action === "replace") {
    const replacementId = tryReserveReplacement(account);
    if (!replacementId) {
      return { success: false, error: `no same-country (${account.country}) replacement available` };
    }
    finalizeReplacement(id, account.id, replacementId);
    return { success: true, dispute: getRowById(id)! };
  }

  // refund
  if (!account.payment_signature || !account.payment_chain || !account.paid_amount_usdc) {
    return {
      success: false,
      error: "no payment provenance on account row — pre-feature seed; settle manually",
    };
  }
  const refund = await refundUsdcToPayer({
    chain: account.payment_chain as "solana" | "base",
    payer: account.sold_to_wallet!,
    amountUsdc: account.paid_amount_usdc,
    reason: `dispute ${id}: admin-issued refund${note ? ` (${note})` : ""}`,
    originalPaymentSignature: account.payment_signature,
    endpoint: "POST /social/twitter/pool/disputes/:id/resolve",
  });

  const now = new Date().toISOString();
  if (refund.ok) {
    markAccountDead(account.id, id);
    db.prepare(`
      UPDATE pool_disputes
      SET status = 'refunded',
          resolution = ?,
          refund_id = ?,
          resolved_at = ?
      WHERE id = ?
    `).run(`refunded:${refund.refundTx || refund.refundId}`, refund.refundId, now, id);
    return { success: true, dispute: getRowById(id)! };
  }

  return { success: false, error: `refund failed: ${refund.reason || "unknown"}` };
}
