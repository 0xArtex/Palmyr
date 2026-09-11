/**
 * VPS billing-period enforcement (services/compute-lifecycle.ts).
 *
 * Regression cover for the bug this replaced: servers were advertised as
 * monthly but nothing ever ended the period, so one deploy payment ran a box
 * indefinitely (three tenants reached 79–102 days on a single month's fee).
 *
 * The properties worth pinning down:
 *  - a lapsed server is NOTIFIED before anything is powered off or destroyed,
 *    and the grace clock runs from the notice, not from the expiry — so a
 *    server months overdue still gets the full window once we finally tell it;
 *  - terminate SNAPSHOTS BEFORE it destroys, and never destroys if the
 *    snapshot failed;
 *  - a paid server is never touched at any rung;
 *  - renew stacks onto remaining time rather than discarding it;
 *  - storage.setServer (which every status refresh calls) does NOT blank the
 *    billing columns — that would make an expired box look freshly paid on
 *    every poll and silently restore the original bug.
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Isolated DB + deterministic grace windows. Both must be set before the
// modules under test are required, since db.ts resolves its path at import.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "palmyr-lifecycle-"));
process.env.PALMYR_DATA_DIR = TMP_DIR;
process.env.PALMYR_VPS_BILLING_DAYS = "30";
process.env.PALMYR_VPS_IDLE_GRACE_DAYS = "3";
process.env.PALMYR_VPS_TERMINATE_GRACE_DAYS = "7";
process.env.PALMYR_VPS_SNAPSHOT_RETAIN_DAYS = "30";
process.env.HCLOUD_TOKEN = process.env.HCLOUD_TOKEN || "test-token";
process.env.HCLOUD_LOCATION = process.env.HCLOUD_LOCATION || "fsn1";
delete process.env.TREASURY_SOL_PRIVATE_KEY;
delete process.env.SVM_PRIVATE_KEY;
delete process.env.TREASURY_EVM_PRIVATE_KEY;

import { db } from "../db";
import { storage } from "../services/storage";
import * as computeService from "../services/compute";
import {
  sweepLapsedServers,
  extendPaidThrough,
  clearLapseState,
  lifecycleView,
} from "../services/compute-lifecycle";

// agent_inbox is created by the agent-inbox route module at boot; this test
// exercises the service without loading routes, so ensure it exists here.
db.exec(`CREATE TABLE IF NOT EXISTS agent_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  read_status INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
)`);

const OWNER = "0xTESTOWNER0000000000000000000000000000001";
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

/** Calls the sweep made into the (stubbed) Hetzner client. */
let calls: string[] = [];
let snapshotShouldFail = false;

const realServerAction = computeService.serverAction;
const realCreateSnapshot = computeService.createSnapshot;
const realDestroy = computeService.destroyServerAtProvider;
const realDeleteImage = computeService.deleteImage;
const realExists = computeService.serverExistsAtProvider;

/** Server ids the stubbed Hetzner should report as already deleted. */
let vanished = new Set<string>();
/** When set, the existence probe throws instead of answering. */
let existsShouldThrow = false;

function insertServer(id: string, fields: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT OR REPLACE INTO servers
       (id, name, server_type, image, status, ipv4, ipv6, owner, price_monthly, created_at,
        root_password, paid_through, expiry_notified_at, idled_at, terminated_at, snapshot_id, snapshot_expires_at)
     VALUES (@id, @name, 'cx23', 'ubuntu-24.04', 'running', '203.0.113.9', NULL, @owner, '7.00', @createdAt,
             NULL, @paidThrough, @notifiedAt, @idledAt, @terminatedAt, @snapshotId, @snapshotExpiresAt)`,
  ).run({
    id,
    name: `srv-${id}`,
    owner: OWNER,
    createdAt: iso(-60),
    paidThrough: null,
    notifiedAt: null,
    idledAt: null,
    terminatedAt: null,
    snapshotId: null,
    snapshotExpiresAt: null,
    ...fields,
  });
}

const rowOf = (id: string): any =>
  db.prepare("SELECT * FROM servers WHERE id = ?").get(id);

describe("compute lifecycle — VPS billing period", () => {
  before(() => {
    // Stub every outbound Hetzner call. CommonJS namespace objects are
    // mutable, and the service calls through `computeService.x(...)` at call
    // time, so assignment here is what the sweep actually invokes.
    (computeService as any).serverAction = async (id: string, action: string) => {
      calls.push(`${action}:${id}`);
      return {};
    };
    (computeService as any).createSnapshot = async (id: string) => {
      calls.push(`snapshot:${id}`);
      if (snapshotShouldFail) throw new Error("hetzner snapshot failed");
      return `img-${id}`;
    };
    (computeService as any).destroyServerAtProvider = async (id: string) => {
      calls.push(`destroy:${id}`);
    };
    (computeService as any).deleteImage = async (imageId: string) => {
      calls.push(`deleteImage:${imageId}`);
    };
    (computeService as any).serverExistsAtProvider = async (id: string) => {
      if (existsShouldThrow) throw new Error("hetzner unreachable");
      return !vanished.has(id);
    };
  });

  after(() => {
    (computeService as any).serverAction = realServerAction;
    (computeService as any).createSnapshot = realCreateSnapshot;
    (computeService as any).destroyServerAtProvider = realDestroy;
    (computeService as any).deleteImage = realDeleteImage;
    (computeService as any).serverExistsAtProvider = realExists;
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* temp dir */ }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM servers").run();
    db.prepare("DELETE FROM agent_inbox").run();
    calls = [];
    snapshotShouldFail = false;
    vanished = new Set();
    existsShouldThrow = false;
  });

  it("leaves a paid server completely alone", async () => {
    insertServer("paid-1", { paidThrough: iso(10) });

    const result = await sweepLapsedServers();

    assert.deepEqual(result, { reconciled: 0, notified: 0, idled: 0, terminated: 0, snapshotsDeleted: 0 });
    assert.deepEqual(calls, []);
    const row = rowOf("paid-1");
    assert.equal(row.expiry_notified_at, null);
    assert.equal(row.idled_at, null);
  });

  it("notifies on lapse, and powers nothing off on that first sweep", async () => {
    insertServer("lapsed-1", { paidThrough: iso(-1) });

    const result = await sweepLapsedServers();

    assert.equal(result.notified, 1);
    assert.equal(result.idled, 0);
    assert.equal(result.terminated, 0);
    assert.deepEqual(calls, [], "nothing should be powered off or destroyed on the notify rung");

    const row = rowOf("lapsed-1");
    assert.ok(row.expiry_notified_at, "notice timestamp recorded");

    const inbox = db
      .prepare("SELECT * FROM agent_inbox WHERE to_agent = ?")
      .all(OWNER) as any[];
    assert.equal(inbox.length, 1);
    assert.match(inbox[0].body, /renew/i);
  });

  it("notifies only once, however long the server stays overdue", async () => {
    insertServer("lapsed-2", { paidThrough: iso(-1) });

    await sweepLapsedServers();
    const first = rowOf("lapsed-2").expiry_notified_at;
    const second = await sweepLapsedServers();

    assert.equal(second.notified, 0);
    assert.equal(rowOf("lapsed-2").expiry_notified_at, first);
  });

  it("does not start the grace clock when the notice can't be delivered", async () => {
    insertServer("undeliverable-1", { paidThrough: iso(-30) });
    db.exec("ALTER TABLE agent_inbox RENAME TO agent_inbox_hidden");
    try {
      const result = await sweepLapsedServers();
      assert.equal(result.notified, 0);
      assert.equal(
        rowOf("undeliverable-1").expiry_notified_at,
        null,
        "an owner who was never told must never enter the grace window",
      );
      assert.deepEqual(calls, []);
    } finally {
      db.exec("ALTER TABLE agent_inbox_hidden RENAME TO agent_inbox");
    }
  });

  it("retires a row whose box is already gone, without mailing its owner", async () => {
    insertServer("ghost-1", { paidThrough: iso(-120) });
    vanished.add("ghost-1");

    const result = await sweepLapsedServers();

    assert.equal(result.reconciled, 1);
    assert.equal(result.notified, 0, "no renew notice for a server that no longer exists");
    assert.deepEqual(calls, []);

    const row = rowOf("ghost-1");
    assert.ok(row.terminated_at);
    assert.equal(row.status, "deleted");
    assert.equal(row.snapshot_id, null, "nothing left to snapshot");
    assert.equal(
      (db.prepare("SELECT COUNT(*) n FROM agent_inbox").get() as any).n,
      0,
    );
  });

  it("leaves rows alone when the existence probe itself fails", async () => {
    insertServer("outage-1", { paidThrough: iso(-30) });
    existsShouldThrow = true;

    const result = await sweepLapsedServers();

    assert.equal(result.reconciled, 0, "an API outage must not be read as 'server deleted'");
    assert.equal(rowOf("outage-1").terminated_at, null);
  });

  it("runs the grace clock from the notice, not from expiry", async () => {
    // Overdue for 100 days — the shape of the servers that triggered this work
    // — but only told about it today. It must NOT be idled on this sweep.
    insertServer("backlog-1", { paidThrough: iso(-100) });

    const first = await sweepLapsedServers();
    assert.equal(first.notified, 1);
    assert.equal(first.idled, 0, "a server notified today gets its full grace window");
    assert.deepEqual(calls, []);

    // Once the notice itself is old enough, the idle rung fires.
    db.prepare("UPDATE servers SET expiry_notified_at = ? WHERE id = ?").run(iso(-4), "backlog-1");
    const second = await sweepLapsedServers();
    assert.equal(second.idled, 1);
    assert.deepEqual(calls, ["poweroff:backlog-1"]);
  });

  it("idles after the idle grace, keeping the disk", async () => {
    insertServer("idle-1", { paidThrough: iso(-10), notifiedAt: iso(-4) });

    const result = await sweepLapsedServers();

    assert.equal(result.idled, 1);
    assert.equal(result.terminated, 0);
    assert.deepEqual(calls, ["poweroff:idle-1"]);

    const row = rowOf("idle-1");
    assert.ok(row.idled_at);
    assert.equal(row.terminated_at, null);
    assert.equal(row.snapshot_id, null, "idling must not snapshot or destroy");
  });

  it("snapshots BEFORE destroying, and records the snapshot first", async () => {
    insertServer("term-1", { paidThrough: iso(-14), notifiedAt: iso(-8), idledAt: iso(-5) });

    const result = await sweepLapsedServers();

    assert.equal(result.terminated, 1);
    assert.deepEqual(
      calls,
      ["snapshot:term-1", "destroy:term-1"],
      "snapshot must precede destroy so a missed renewal is never permanent data loss",
    );

    const row = rowOf("term-1");
    assert.equal(row.snapshot_id, "img-term-1");
    assert.ok(row.terminated_at);
    assert.equal(row.status, "terminated");
    assert.ok(
      new Date(row.snapshot_expires_at).getTime() > Date.now() + 29 * DAY,
      "snapshot retained ~30 days",
    );
  });

  it("does NOT destroy when the snapshot fails", async () => {
    snapshotShouldFail = true;
    insertServer("term-2", { paidThrough: iso(-14), notifiedAt: iso(-8), idledAt: iso(-5) });

    const result = await sweepLapsedServers();

    assert.equal(result.terminated, 0);
    assert.deepEqual(calls, ["snapshot:term-2"], "destroy must not run after a failed snapshot");
    assert.equal(rowOf("term-2").terminated_at, null, "row stays live so the next sweep retries");
  });

  it("never re-terminates an already terminated server", async () => {
    insertServer("term-3", {
      paidThrough: iso(-40),
      notifiedAt: iso(-30),
      terminatedAt: iso(-20),
      snapshotId: "img-old",
      snapshotExpiresAt: iso(10),
    });

    const result = await sweepLapsedServers();

    assert.equal(result.terminated, 0);
    assert.equal(result.notified, 0);
    assert.deepEqual(calls, []);
  });

  it("GCs the snapshot once retention elapses", async () => {
    insertServer("gc-1", {
      paidThrough: iso(-60),
      notifiedAt: iso(-50),
      terminatedAt: iso(-40),
      snapshotId: "img-gc-1",
      snapshotExpiresAt: iso(-1),
    });

    const result = await sweepLapsedServers();

    assert.equal(result.snapshotsDeleted, 1);
    assert.deepEqual(calls, ["deleteImage:img-gc-1"]);
    const row = rowOf("gc-1");
    assert.equal(row.snapshot_id, null);
    assert.equal(row.snapshot_expires_at, null);
  });

  it("keeps a retained snapshot until its expiry", async () => {
    insertServer("gc-2", {
      paidThrough: iso(-60),
      notifiedAt: iso(-50),
      terminatedAt: iso(-40),
      snapshotId: "img-gc-2",
      snapshotExpiresAt: iso(5),
    });

    const result = await sweepLapsedServers();

    assert.equal(result.snapshotsDeleted, 0);
    assert.deepEqual(calls, []);
  });
});

describe("compute lifecycle — renewal", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM servers").run();
  });

  it("stacks an early renewal onto the time that's left", () => {
    insertServer("renew-1", { paidThrough: iso(10) });

    const next = extendPaidThrough("renew-1");

    const daysOut = (new Date(next).getTime() - Date.now()) / DAY;
    assert.ok(daysOut > 39 && daysOut < 41, `expected ~40 days (10 left + 30 bought), got ${daysOut}`);
  });

  it("starts a late renewal from now, not from the lapsed date", () => {
    insertServer("renew-2", { paidThrough: iso(-45) });

    const next = extendPaidThrough("renew-2");

    const daysOut = (new Date(next).getTime() - Date.now()) / DAY;
    assert.ok(daysOut > 29 && daysOut < 31, `expected ~30 days, got ${daysOut}`);
  });

  it("resets the ladder so a renewed server is swept as healthy again", async () => {
    insertServer("renew-3", { paidThrough: iso(-10), notifiedAt: iso(-8), idledAt: iso(-5) });

    extendPaidThrough("renew-3");
    clearLapseState("renew-3");

    const row = rowOf("renew-3");
    assert.equal(row.expiry_notified_at, null);
    assert.equal(row.idled_at, null);

    calls = [];
    const result = await sweepLapsedServers();
    assert.deepEqual(result, { reconciled: 0, notified: 0, idled: 0, terminated: 0, snapshotsDeleted: 0 });
  });

  it("does not clear terminated_at — a destroyed box comes back via restore", () => {
    insertServer("renew-4", { paidThrough: iso(-10), notifiedAt: iso(-8), terminatedAt: iso(-1) });

    clearLapseState("renew-4");

    assert.ok(rowOf("renew-4").terminated_at, "termination is not undone by a renewal");
  });
});

describe("compute lifecycle — billing state survives a status refresh", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM servers").run();
  });

  it("setServer carries the billing columns forward instead of blanking them", () => {
    insertServer("refresh-1", { paidThrough: iso(-10), notifiedAt: iso(-4), idledAt: iso(-1) });

    // What getServer/serverAction/rename/resize all do on every poll.
    const server = storage.getServer("refresh-1")!;
    server.status = "off";
    storage.setServer("refresh-1", server);

    const row = rowOf("refresh-1");
    assert.ok(row.paid_through, "paid_through survives — otherwise every poll looks freshly paid");
    assert.ok(row.expiry_notified_at, "the notice survives, so grace isn't silently restarted");
    assert.ok(row.idled_at);
    assert.equal(row.status, "off");
  });

  it("reads the billing columns back through storage", () => {
    insertServer("refresh-2", { paidThrough: iso(5) });

    const server = storage.getServer("refresh-2")!;
    assert.ok(server.paidThrough);

    const listed = storage.listServers(OWNER).find(s => s.id === "refresh-2")!;
    assert.ok(listed.paidThrough);
  });
});

describe("compute lifecycle — owner-facing state", () => {
  it("reports an unexpired server as active", () => {
    const view = lifecycleView({ id: "v1", paidThrough: iso(12) });
    assert.equal(view.state, "active");
    assert.equal(view.daysRemaining, 12);
    assert.match(String(view.renew), /\/compute\/servers\/v1\/renew$/);
  });

  it("reports a lapsed server as expired, with the dates each rung fires", () => {
    const view = lifecycleView({ id: "v2", paidThrough: iso(-2), expiryNotifiedAt: iso(-1) });
    assert.equal(view.state, "expired");
    assert.ok(view.idleAt && view.terminateAt);
    assert.ok(
      new Date(view.terminateAt!).getTime() > new Date(view.idleAt!).getTime(),
      "terminate must come after idle",
    );
  });

  it("reports an idled server, and points a terminated one at restore", () => {
    const idled = lifecycleView({ id: "v3", paidThrough: iso(-5), expiryNotifiedAt: iso(-4), idledAt: iso(-1) });
    assert.equal(idled.state, "idled");
    assert.ok(idled.terminateAt);

    const dead = lifecycleView({
      id: "v4",
      paidThrough: iso(-20),
      expiryNotifiedAt: iso(-15),
      terminatedAt: iso(-8),
      snapshotExpiresAt: iso(22),
    });
    assert.equal(dead.state, "terminated");
    assert.match(String(dead.restore), /\/compute\/servers\/v4\/restore$/);
    assert.ok(dead.restorableUntil);
  });

  it("says so when a terminated server's snapshot is already gone", () => {
    const gone = lifecycleView({ id: "v5", paidThrough: iso(-90), terminatedAt: iso(-40) });
    assert.equal(gone.state, "terminated");
    assert.equal(gone.restorableUntil, undefined);
    assert.match(String(gone.message), /deleted/i);
  });
});
