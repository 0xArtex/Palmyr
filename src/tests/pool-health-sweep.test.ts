/**
 * Tests for suspension detection and the pool health sweep.
 *
 * The detection cases here are not hypothetical — each one is a shape
 * twitterapi.io returned in production on 2026-09-13 that the old code read
 * wrong, and each one cost money:
 *
 *   - 200 + data.unavailable=true          was read as "active", which makes
 *                                          createDispute() auto-REJECT a real
 *                                          suspension claim. 13 accounts hid
 *                                          behind this.
 *   - 200 + status=error "user not found"  was read as "no signal", so a dead
 *                                          handle never triggered anything.
 *
 * The sweep tests cover the decisions that move money or stock: pull suspended
 * ready stock, refund a suspended sale inside the dispute window, flag one
 * outside it, and never act on an ambiguous signal.
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.POOL_ENCRYPTION_KEY = process.env.POOL_ENCRYPTION_KEY || "a".repeat(64);

import { db } from "../db";
import { getUserInfo, getUserInfosByIds } from "../services/twitter-api";
import { sweepPoolHealth } from "../services/pool-health-sweep";
import { randomBytes, createCipheriv } from "crypto";

function encryptForTest(plaintext: string): string {
  const key = Buffer.from(process.env.POOL_ENCRYPTION_KEY!, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString("hex"),
    ciphertext: ct.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  });
}
const CREDS = encryptForTest(JSON.stringify({ login: "t", password: "t" }));
const BUYER = "0xbuyer000000000000000000000000000000000001";

const originalFetch = global.fetch;
function mockFetch(handler: (url: string) => any) {
  (global as any).fetch = async (input: any) => {
    const url = String(input);
    const body = handler(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** user_about payload for a live account. */
const liveBody = (name: string) => ({
  status: "success",
  msg: "success",
  data: { id: "111", name, userName: "x", about_profile: { account_based_in: "United States" } },
});
/** user_about payload X actually returns for a suspended account. */
const suspendedBody = { status: "success", msg: "success", data: { unavailable: true, unavailableReason: "Suspended" } };
/** user_about payload for a handle that no longer exists. */
const notFoundBody = { status: "error", msg: "user not found" };

function seed(row: {
  id: string; username: string; status: string; country?: string;
  sold_to_wallet?: string; sold_at?: string; rest_id?: string;
  payment_signature?: string; seed_display_name?: string;
}) {
  db.prepare(
    "INSERT INTO social_account_pool (id, platform, username, country, proxy_session_id, credentials_encrypted, " +
    "sale_price_usdc, status, sold_to_wallet, sold_at, rest_id, payment_signature, payment_chain, paid_amount_usdc, seed_display_name) " +
    "VALUES (?, 'twitter', ?, ?, 'p', ?, 5, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id, row.username, row.country ?? "US", CREDS, row.status,
    row.sold_to_wallet ?? null, row.sold_at ?? null, row.rest_id ?? null,
    row.payment_signature ?? null, row.payment_signature ? "base" : null,
    row.payment_signature ? 5 : null, row.seed_display_name ?? null,
  );
}

function wipe() {
  db.exec("DELETE FROM pool_disputes; DELETE FROM social_account_pool; DELETE FROM refunds;");
}

const statusOf = (id: string) =>
  (db.prepare("SELECT status FROM social_account_pool WHERE id = ?").get(id) as any)?.status;

/* ─── detection ──────────────────────────────────────────────────────── */

describe("twitter-api — suspension detection", () => {
  beforeEach(() => { process.env.TWITTER_API_IO_KEY = "test_key"; });
  afterEach(() => { global.fetch = originalFetch; delete process.env.TWITTER_API_IO_KEY; });

  it("reads 200 + unavailable=true as suspended, not active", async () => {
    // The regression that hid 13 suspended accounts: this shape has no
    // about_profile, so field-only parsing fell through to "active".
    mockFetch(() => suspendedBody);
    const info = await getUserInfo("ghost");
    assert.equal(info!.status, "suspended");
    assert.equal(info!.unavailable_reason, "Suspended");
  });

  it("reads an unavailable account with a non-suspension reason as gone, not suspended", async () => {
    mockFetch(() => ({ status: "success", data: { unavailable: true, unavailableReason: "Deactivated" } }));
    const info = await getUserInfo("ghost");
    assert.equal(info!.status, "not_found");
    assert.equal(info!.unavailable_reason, "Deactivated");
  });

  it('reads status=error "user not found" as not_found, not no-signal', async () => {
    mockFetch(() => notFoundBody);
    const info = await getUserInfo("ghost");
    assert.ok(info, "a dead handle must produce a verdict, not null");
    assert.equal(info!.status, "not_found");
  });

  it("still returns null for a status=error that is NOT about the account", async () => {
    // A plan-tier limit or upstream hiccup carries no signal about the
    // account. Acting on it would kill live stock on a bad API day.
    mockFetch(() => ({ status: "error", msg: "rate limit exceeded" }));
    assert.equal(await getUserInfo("alice"), null);
  });

  it("still reads a healthy account as active and keeps its display name", async () => {
    mockFetch(() => liveBody("Beverly Woods"));
    const info = await getUserInfo("alice");
    assert.equal(info!.status, "active");
    assert.equal(info!.display_name, "Beverly Woods");
    assert.equal(info!.country, "US");
  });

  it("separates suspended from renamed when resolving by id", async () => {
    mockFetch(() => ({
      status: "success",
      users: [
        { id: "1", unavailable: true, unavailableReason: "Suspended" },
        { id: "2", userName: "rebranded_handle", name: "New Name" },
      ],
    }));
    const got = await getUserInfosByIds(["1", "2", "3"]);
    assert.equal(got.get("1")!.status, "suspended");
    assert.equal(got.get("2")!.status, "active");
    assert.equal(got.get("2")!.username, "rebranded_handle");
    // An id absent from a successful response resolved to nothing at all.
    assert.equal(got.get("3")!.status, "not_found");
  });

  it("leaves a whole failed batch unset rather than reporting accounts gone", async () => {
    mockFetch(() => ({ status: "error", msg: "plan tier" }));
    const got = await getUserInfosByIds(["1", "2"]);
    assert.equal(got.get("1"), undefined);
    assert.equal(got.get("2"), undefined);
  });
});

/* ─── sweep behavior ─────────────────────────────────────────────────── */

describe("pool health sweep", () => {
  before(() => { process.env.TWITTER_API_IO_KEY = "test_key"; });
  beforeEach(() => { wipe(); process.env.TWITTER_API_IO_KEY = "test_key"; });
  afterEach(() => { global.fetch = originalFetch; });

  it("pulls suspended ready stock out of the storefront", async () => {
    seed({ id: "a1", username: "suspended_stock", status: "ready" });
    mockFetch(() => suspendedBody);
    const r = await sweepPoolHealth();
    assert.equal(statusOf("a1"), "dead");
    assert.equal(r.pulledFromStock, 1);
  });

  it("leaves healthy ready stock alone and records its display name baseline", async () => {
    seed({ id: "a2", username: "good_stock", status: "ready" });
    mockFetch(() => liveBody("Vera Baxter"));
    await sweepPoolHealth();
    assert.equal(statusOf("a2"), "ready");
    const row = db.prepare("SELECT seed_display_name FROM social_account_pool WHERE id = 'a2'").get() as any;
    assert.equal(row.seed_display_name, "Vera Baxter");
  });

  it("pulls ready stock whose display name drifted from the seeded persona", async () => {
    seed({ id: "a3", username: "taken_over", status: "ready", seed_display_name: "Kendra Book" });
    mockFetch(() => liveBody("Herbrain"));
    const r = await sweepPoolHealth();
    assert.equal(statusOf("a3"), "dead");
    assert.equal(r.driftPulled, 1);
  });

  it("does NOT touch a sold account the buyer renamed", async () => {
    seed({ id: "a4", username: "buyer_rebrand", status: "sold", sold_to_wallet: BUYER, seed_display_name: "Old Name" });
    mockFetch(() => liveBody("Their New Brand"));
    const r = await sweepPoolHealth();
    assert.equal(statusOf("a4"), "sold");
    assert.equal(r.driftPulled, 0);
  });

  it("opens a dispute and flags — not refunds — a suspended sale outside the dispute window", async () => {
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    seed({ id: "a5", username: "old_sale", status: "sold", sold_to_wallet: BUYER, sold_at: old, payment_signature: "0xsig_old" });
    mockFetch(() => suspendedBody);
    const r = await sweepPoolHealth();
    assert.equal(r.flagged, 1);
    assert.equal(r.refunded, 0);
    const d = db.prepare("SELECT status FROM pool_disputes WHERE account_id = 'a5'").get() as any;
    assert.equal(d.status, "admin_review", "a human decides on a months-old ban");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM refunds").get() as any).c, 0);
  });

  it("attempts a refund for a suspended sale INSIDE the dispute window", async () => {
    // The treasury key is absent in tests, so the transfer itself can't land —
    // but refundUsdcToPayer records the attempt before broadcasting, so a
    // refunds row against this exact payment proves the sweep took the money
    // path rather than the flag path. (The boot-time retry sweep drains these
    // once the key is present, which is why recording the attempt matters.)
    seed({
      id: "a5b", username: "fresh_sale", status: "sold", sold_to_wallet: BUYER,
      sold_at: new Date().toISOString(), payment_signature: "0xsig_fresh",
    });
    mockFetch(() => suspendedBody);
    await sweepPoolHealth();
    const refund = db.prepare(
      "SELECT payer, amount_usdc, chain FROM refunds WHERE original_payment_signature = '0xsig_fresh'",
    ).get() as any;
    assert.ok(refund, "an in-window suspended sale must trigger a refund attempt");
    assert.equal(refund.payer, BUYER);
    assert.equal(refund.amount_usdc, 5);
    assert.equal(refund.chain, "base");
    // And it is anchored to a dispute record, never a bare transfer.
    const d = db.prepare("SELECT detection_status FROM pool_disputes WHERE account_id = 'a5b'").get() as any;
    assert.equal(d.detection_status, "suspended");
  });

  it("flags a suspended sale that has no payment provenance to refund against", async () => {
    seed({ id: "a6", username: "legacy_sale", status: "sold", sold_to_wallet: BUYER, sold_at: new Date().toISOString() });
    mockFetch(() => suspendedBody);
    const r = await sweepPoolHealth();
    assert.equal(r.flagged, 1);
    assert.equal(r.refunded, 0);
    assert.ok(db.prepare("SELECT id FROM pool_disputes WHERE account_id = 'a6'").get());
  });

  it("acts on nothing when the API gives no signal", async () => {
    seed({ id: "a7", username: "unknown_stock", status: "ready" });
    mockFetch(() => ({ status: "error", msg: "rate limit exceeded" }));
    const r = await sweepPoolHealth();
    assert.equal(statusOf("a7"), "ready", "a bad API day must not kill live stock");
    assert.equal(r.noSignal, 1);
    assert.equal(r.pulledFromStock, 0);
  });

  it("leaves a gone handle with no rest_id untouched — suspended and renamed are indistinguishable", async () => {
    seed({ id: "a8", username: "legacy_gone", status: "sold", sold_to_wallet: BUYER });
    mockFetch(() => notFoundBody);
    const r = await sweepPoolHealth();
    assert.equal(statusOf("a8"), "sold");
    assert.equal(r.suspended, 0);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM pool_disputes").get() as any).c, 0);
  });

  it("resolves a gone handle WITH a rest_id: suspended pulls, renamed does not", async () => {
    seed({ id: "a9", username: "gone_suspended", status: "ready", rest_id: "900" });
    seed({ id: "a10", username: "gone_renamed", status: "ready", rest_id: "901" });
    mockFetch((url) => {
      if (url.includes("batch_info_by_ids")) {
        return {
          status: "success",
          users: [
            { id: "900", unavailable: true, unavailableReason: "Suspended" },
            { id: "901", userName: "now_called_this", name: "Whatever" },
          ],
        };
      }
      return notFoundBody;
    });
    await sweepPoolHealth();
    assert.equal(statusOf("a9"), "dead", "suspended → out of stock");
    assert.equal(statusOf("a10"), "dead", "renamed ready stock is no longer ours to sell");
    const notes = db.prepare("SELECT notes FROM social_account_pool WHERE id = 'a10'").get() as any;
    assert.match(notes.notes, /now_called_this/);
  });

  it("is idempotent — a second sweep opens no duplicate dispute", async () => {
    seed({ id: "a11", username: "dupe_check", status: "sold", sold_to_wallet: BUYER, sold_at: new Date().toISOString() });
    mockFetch(() => suspendedBody);
    await sweepPoolHealth();
    await sweepPoolHealth();
    assert.equal((db.prepare("SELECT COUNT(*) c FROM pool_disputes WHERE account_id = 'a11'").get() as any).c, 1);
  });
});
