import Database from 'better-sqlite3';
import { isAbsolute, join } from 'path';
import { existsSync, mkdirSync, chmodSync } from 'fs';

// PALMYR_DATA_DIR pins the SQLite path to a stable location outside the
// release tree. Critical in prod: without this, `process.cwd()` resolves
// inside the current release directory (e.g. /opt/palmyr/releases/<ts>/),
// and every redeploy creates a fresh empty DB. Set it to something like
// `/var/lib/palmyr/data` and the DB survives every deploy.
//
// Dev falls back to the repo-relative ./data path, gitignored so it
// doesn't pollute commits.
const envDir = process.env.PALMYR_DATA_DIR;
export const DATA_DIR = envDir
  ? (isAbsolute(envDir) ? envDir : join(process.cwd(), envDir))
  : join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'agentos.db');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

console.log(`[db] using ${DB_PATH}${envDir ? ' (PALMYR_DATA_DIR)' : ' (cwd default)'}`);

// Lock down the data dir / DB files to owner-only. The SQLite file holds VPS
// root passwords, agent tokens and session tokens; with the default umask the
// dir/files are group/world-readable, so anyone with local read (or a copied
// backup) gets every credential. chmod is a no-op-ish on Windows and may be
// unsupported on exotic filesystems, so it is best-effort.
function restrictPerms(path: string, mode: number): void {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch (e) {
    console.warn(`[db] could not restrict permissions on ${path}:`, (e as Error).message);
  }
}
restrictPerms(DATA_DIR, 0o700);

/**
 * Length of one paid VPS billing period, in days. A deploy payment buys this
 * much runtime; `POST /compute/servers/:id/renew` buys another. Also used to
 * backfill `paid_through` for servers created before the column existed.
 */
export const SERVER_BILLING_DAYS = Math.max(
  1,
  parseInt(process.env.PALMYR_VPS_BILLING_DAYS ?? "30", 10) || 30,
);

// Initialize SQLite database
export const db: Database.Database = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Enforce declared FOREIGN KEY constraints. SQLite defaults foreign_keys to OFF
// per connection, which left every FK clause in the schema inert (orphaned child
// rows on parent delete/replace). Enable it for referential integrity. Note the
// schema declares no ON DELETE CASCADE, and the migration rebuilds below toggle
// this OFF/ON around table rebuilds, which now correctly restores the ON state.
db.pragma('foreign_keys = ON');

// Restrict the on-disk SQLite files (main DB + WAL/SHM sidecars) to owner-only.
restrictPerms(DB_PATH, 0o600);
restrictPerms(`${DB_PATH}-wal`, 0o600);
restrictPerms(`${DB_PATH}-shm`, 0o600);

/**
 * Initialize all tables for Palmyr
 */
export function initDatabase(): void {
  // Phone Numbers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_numbers (
      id TEXT PRIMARY KEY,
      phone_number TEXT UNIQUE NOT NULL,
      country TEXT NOT NULL,
      owner TEXT NOT NULL,
      provisioned_at TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );
    
    CREATE INDEX IF NOT EXISTS idx_phone_numbers_phone_number ON phone_numbers(phone_number);
    CREATE INDEX IF NOT EXISTS idx_phone_numbers_owner ON phone_numbers(owner);
  `);

  // JSON array of wallet addresses granted shared use (send/read/call on the
  // number — but cannot release, re-transfer, or unshare). Same shape as
  // domains.shared_with. Probe PRAGMA since SQLite has no IF NOT EXISTS on columns.
  const phoneCols = db.prepare("PRAGMA table_info(phone_numbers)").all() as Array<{ name: string }>;
  const phoneColNames = new Set(phoneCols.map(c => c.name));
  if (!phoneColNames.has('shared_with')) {
    db.exec("ALTER TABLE phone_numbers ADD COLUMN shared_with TEXT DEFAULT '[]'");
  }
  // Disposable temp-number leases reuse the phone_numbers table: each lease is a
  // FRESH row (new id) pointing at a pooled E.164 number, with a TTL. A permanent
  // (bought) number has all three NULL; a temp lease sets all three. Probe PRAGMA
  // since SQLite has no IF NOT EXISTS on columns. NOTE: phone_number stays UNIQUE,
  // so a pooled number can hold at most one lease row at a time — re-leasing only
  // happens after the previous lease row is hard-deleted (sweep + quarantine).
  if (!phoneColNames.has('expires_at')) {
    db.exec("ALTER TABLE phone_numbers ADD COLUMN expires_at TEXT");
  }
  if (!phoneColNames.has('lease_start')) {
    db.exec("ALTER TABLE phone_numbers ADD COLUMN lease_start TEXT");
  }
  if (!phoneColNames.has('pool_number')) {
    db.exec("ALTER TABLE phone_numbers ADD COLUMN pool_number INTEGER");
  }

  // Pre-owned pool of US local numbers seeded by OPS (never bought in the
  // request path — cost control). A temp lease allocates a FREE pool number
  // (one with no live lease and past its inter-lease quarantine) and returns it
  // to the pool at expiry. Flat + strings, mirroring the dead-simple schema rule.
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_pool (
      phone_number TEXT UNIQUE NOT NULL,
      telnyx_id TEXT,
      added_at TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_phone_pool_active ON phone_pool(active);
  `);

  // Durable per-wallet lease ledger for the rolling-24h cap. The lease ROWS in
  // phone_numbers get hard-deleted 15min after expiry (quarantine), so they
  // can't back a 24h count — a short lease is long gone within the window. This
  // append-only log survives the sweep; old rows are pruned past 24h. Concurrent
  // (live) leases are still counted from phone_numbers directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS temp_phone_leases (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      leased_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_temp_phone_leases_owner ON temp_phone_leases(owner, leased_at);
  `);

  // SMS Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_messages (
      id TEXT PRIMARY KEY,
      phone_number_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (phone_number_id) REFERENCES phone_numbers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sms_messages_phone_number_id ON sms_messages(phone_number_id);
    CREATE INDEX IF NOT EXISTS idx_sms_messages_timestamp ON sms_messages(timestamp);
  `);
  // delivery_status + provider_error track outbound message lifecycle from
  // Telnyx webhooks (queued → sending → sent → delivered, or *_failed). Added
  // in a separate ALTER block so existing DBs upgrade without dropping rows.
  // SQLite has no IF NOT EXISTS on columns — we probe PRAGMA instead.
  const smsCols = db.prepare("PRAGMA table_info(sms_messages)").all() as Array<{ name: string }>;
  const smsColNames = new Set(smsCols.map(c => c.name));
  if (!smsColNames.has("delivery_status")) {
    db.exec(`ALTER TABLE sms_messages ADD COLUMN delivery_status TEXT DEFAULT 'queued'`);
  }
  if (!smsColNames.has("delivery_updated_at")) {
    db.exec(`ALTER TABLE sms_messages ADD COLUMN delivery_updated_at TEXT`);
  }
  if (!smsColNames.has("provider_error")) {
    db.exec(`ALTER TABLE sms_messages ADD COLUMN provider_error TEXT`);
  }

  // Email Inboxes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_inboxes (
      id TEXT PRIMARY KEY,
      address TEXT UNIQUE NOT NULL,
      local_part TEXT NOT NULL,
      owner TEXT NOT NULL,
      public_key TEXT,
      solana_public_key TEXT,
      e2e_enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS email_challenges (
      inbox_id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_email_inboxes_local_part ON email_inboxes(local_part);
    CREATE INDEX IF NOT EXISTS idx_email_inboxes_owner ON email_inboxes(owner);
  `);

  // Idempotent migration: add e2e_enabled column if a pre-existing DB lacks it
  // (multi-domain inbox feature shipped against a schema that already
  // referenced this column, so older DBs without it would break setEmailInbox).
  const inboxCols = db.prepare("PRAGMA table_info(email_inboxes)").all() as Array<{ name: string }>;
  if (!inboxCols.some(c => c.name === 'e2e_enabled')) {
    db.exec("ALTER TABLE email_inboxes ADD COLUMN e2e_enabled INTEGER DEFAULT 1");
  }

  // Idempotent migration: drop the legacy UNIQUE constraint on local_part so
  // the same local-part can exist on different domains (hello@brand-a.com +
  // hello@brand-b.com). SQLite can't drop constraints in place — rebuild the
  // table when the unique index is detected.
  //
  // Detection: inline UNIQUE constraints get auto-named indexes
  // (sqlite_autoindex_email_inboxes_N) that DON'T contain the column name —
  // we have to query PRAGMA index_info(<idx>) to find the column each index
  // actually covers.
  const inboxIndexes = db.prepare("PRAGMA index_list(email_inboxes)").all() as Array<{ name: string; unique: number; origin: string }>;
  let hasLegacyUniqueLocalPart = false;
  for (const idx of inboxIndexes) {
    if (idx.unique !== 1 || idx.origin !== 'u') continue;
    const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>;
    if (cols.length === 1 && cols[0].name === 'local_part') {
      hasLegacyUniqueLocalPart = true;
      break;
    }
  }
  if (hasLegacyUniqueLocalPart) {
    // Discover the actual columns the existing table has — older prod DBs
    // may be missing optional columns (public_key, solana_public_key) and
    // INSERT ... SELECT would error trying to read them.
    const existingCols = new Set(
      (db.prepare("PRAGMA table_info(email_inboxes)").all() as Array<{ name: string }>).map(c => c.name)
    );
    const pickCol = (col: string, fallback: string) =>
      existingCols.has(col) ? col : fallback;

    // Disable foreign-key enforcement for the duration of the rebuild so the
    // DROP TABLE doesn't fail when email_messages.inbox_id has rows pointing
    // at the table being rebuilt. SQLite re-evaluates FKs on COMMIT (or when
    // foreign_keys is re-enabled), so the new table — same name, same id PK
    // values — keeps every reference valid.
    const fkBefore = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN");
      db.exec(`
        CREATE TABLE email_inboxes_new (
          id TEXT PRIMARY KEY,
          address TEXT UNIQUE NOT NULL,
          local_part TEXT NOT NULL,
          owner TEXT NOT NULL,
          public_key TEXT,
          solana_public_key TEXT,
          e2e_enabled INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          active INTEGER DEFAULT 1
        )
      `);
      db.exec(`
        INSERT INTO email_inboxes_new (id, address, local_part, owner, public_key, solana_public_key, e2e_enabled, created_at, active)
          SELECT
            id,
            address,
            local_part,
            owner,
            ${pickCol('public_key', 'NULL')},
            ${pickCol('solana_public_key', 'NULL')},
            ${existingCols.has('e2e_enabled') ? "COALESCE(e2e_enabled, 1)" : "1"},
            created_at,
            ${pickCol('active', '1')}
          FROM email_inboxes
      `);
      db.exec("DROP TABLE email_inboxes");
      db.exec("ALTER TABLE email_inboxes_new RENAME TO email_inboxes");
      db.exec("CREATE INDEX IF NOT EXISTS idx_email_inboxes_local_part ON email_inboxes(local_part)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_email_inboxes_owner ON email_inboxes(owner)");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (fkBefore?.foreign_keys === 1) db.exec("PRAGMA foreign_keys = ON");
      throw err;
    }
    if (fkBefore?.foreign_keys === 1) db.exec("PRAGMA foreign_keys = ON");
  }

  // Idempotent migration: add expires_at for disposable temp inboxes. Runs
  // AFTER the legacy-unique rebuild above (which recreates the table without
  // this column), so the probe re-adds it regardless of which path ran. NULL
  // on every normal/owned inbox; an ISO timestamp only on temp inboxes.
  const inboxCols2 = db.prepare("PRAGMA table_info(email_inboxes)").all() as Array<{ name: string }>;
  if (!inboxCols2.some(c => c.name === 'expires_at')) {
    db.exec("ALTER TABLE email_inboxes ADD COLUMN expires_at TEXT");
  }

  // Email Messages table — created without indexes first so the column
  // backfill below can run before any CREATE INDEX references thread_id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_messages (
      id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL,
      thread_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      cc TEXT,
      message_id_header TEXT,
      in_reply_to TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      html TEXT,
      encrypted INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id)
    );
  `);

  // Backfill threading columns on older DBs that have email_messages from
  // before threads/attachments existed. CREATE TABLE IF NOT EXISTS leaves the
  // pre-existing table untouched, so add any missing columns explicitly.
  // Must run BEFORE the CREATE INDEX below, since the index targets thread_id.
  {
    const cols = db.prepare("PRAGMA table_info(email_messages)").all() as Array<{ name: string }>;
    const have = new Set(cols.map(c => c.name));
    const adds: Array<[string, string]> = [
      ['thread_id', 'TEXT'],
      ['cc', 'TEXT'],
      ['message_id_header', 'TEXT'],
      ['in_reply_to', 'TEXT'],
    ];
    for (const [name, spec] of adds) {
      if (!have.has(name)) db.exec(`ALTER TABLE email_messages ADD COLUMN ${name} ${spec}`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_id ON email_messages(inbox_id);
    CREATE INDEX IF NOT EXISTS idx_email_messages_thread_id ON email_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_email_messages_timestamp ON email_messages(timestamp);
  `);

  // Email Threads, Attachments, Webhooks — added when threading shipped.
  // Older DBs predate them; create here so storage.ts INSERTs don't 500.
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_threads (
      id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL,
      subject TEXT,
      participants TEXT,
      message_count INTEGER DEFAULT 0,
      last_message_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_email_threads_inbox_id ON email_threads(inbox_id);
    CREATE INDEX IF NOT EXISTS idx_email_threads_last_message_at ON email_threads(last_message_at);

    CREATE TABLE IF NOT EXISTS email_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      filename TEXT,
      content_type TEXT,
      size INTEGER,
      content TEXT,
      FOREIGN KEY (message_id) REFERENCES email_messages(id)
    );
    CREATE INDEX IF NOT EXISTS idx_email_attachments_message_id ON email_attachments(message_id);

    CREATE TABLE IF NOT EXISTS email_webhooks (
      id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_email_webhooks_inbox_id ON email_webhooks(inbox_id);
  `);

  // Domains table
  db.exec(`
    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      domain TEXT UNIQUE NOT NULL,
      owner TEXT NOT NULL,
      registrar_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'failed', 'expired')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dns_records TEXT,
      payment_signature TEXT,
      failure_reason TEXT,
      shared_with TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
    CREATE INDEX IF NOT EXISTS idx_domains_owner ON domains(owner);
  `);

  // Idempotent column backfill — CREATE TABLE IF NOT EXISTS leaves pre-existing
  // tables untouched, so older prod DBs can be missing columns added later.
  const domainsCols = db.prepare("PRAGMA table_info(domains)").all() as Array<{ name: string }>;
  const have = new Set(domainsCols.map(c => c.name));
  const additions: Array<[string, string]> = [
    ['registrar_id', 'TEXT'],
    ['status', "TEXT NOT NULL DEFAULT 'active'"],
    ['expires_at', 'TEXT'],
    ['created_at', 'TEXT'],
    ['dns_records', 'TEXT'],
    // x402 settlement signature for every registration — enables refunds
    // and reconciliation when registrar vs DB disagree.
    ['payment_signature', 'TEXT'],
    // Captures why a registration moved to 'failed' so ops can refund with context.
    ['failure_reason', 'TEXT'],
    // JSON array of wallet addresses granted shared access (sees the row in
    // GET /domains, can edit DNS — but cannot re-transfer or unshare).
    ['shared_with', "TEXT DEFAULT '[]'"],
  ];
  for (const [name, spec] of additions) {
    if (!have.has(name)) db.exec(`ALTER TABLE domains ADD COLUMN ${name} ${spec}`);
  }

  // One-shot rebuild for older prod DBs that have legacy NOT NULL columns
  // (tld, registrar, registered_at) the current code doesn't know about.
  // Those columns used to cause INSERT failures whenever the code evolved.
  // Rebuild the table to match the clean schema, preserving all data.
  // Idempotent — does nothing on DBs that don't have the legacy columns.
  const legacyCols = ['tld', 'registrar', 'registered_at'];
  const presentLegacy = legacyCols.filter(c => have.has(c));
  if (presentLegacy.length > 0) {
    console.warn(`[db] Rebuilding domains table to drop legacy columns: ${presentLegacy.join(', ')}`);
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      const createdAtExpr = have.has('registered_at')
        ? "COALESCE(created_at, registered_at, datetime('now'))"
        : "COALESCE(created_at, datetime('now'))";
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE domains_new (
            id TEXT PRIMARY KEY,
            domain TEXT UNIQUE NOT NULL,
            owner TEXT NOT NULL,
            registrar_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'failed', 'expired')),
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            dns_records TEXT,
            payment_signature TEXT,
            failure_reason TEXT,
            shared_with TEXT DEFAULT '[]'
          );
        `);
        const sharedExpr = have.has('shared_with') ? "COALESCE(shared_with, '[]')" : "'[]'";
        db.exec(`
          INSERT INTO domains_new (id, domain, owner, registrar_id, status, expires_at, created_at, dns_records, payment_signature, failure_reason, shared_with)
          SELECT id, domain, owner, registrar_id, status, expires_at, ${createdAtExpr}, dns_records, payment_signature, failure_reason, ${sharedExpr}
          FROM domains
        `);
        db.exec('DROP TABLE domains');
        db.exec('ALTER TABLE domains_new RENAME TO domains');
        db.exec('CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_domains_owner ON domains(owner)');
      });
      rebuild();
      const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
      if (fkIssues.length > 0) {
        console.error('[db] [WARNING] FK check reported issues after rebuild:', fkIssues);
      }
      console.log('[db] domains table rebuild complete');
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Reconciliation log — any 'pending' row at startup means the server
  // crashed mid-registration. Ops should verify with the registrar whether
  // each row is actually registered and finalize or refund.
  try {
    const pending = db.prepare("SELECT id, domain, owner, created_at FROM domains WHERE status = 'pending'").all() as Array<{ id: string; domain: string; owner: string; created_at: string }>;
    if (pending.length > 0) {
      console.warn(`[db] [RECONCILE] ${pending.length} domain(s) left in 'pending' status — verify with registrar:`);
      for (const row of pending) console.warn('[db] [RECONCILE]', row);
    }
  } catch {
    // Pre-migration DB without status column — nothing to reconcile.
  }

  // DNS Records table
  db.exec(`
    CREATE TABLE IF NOT EXISTS dns_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV')),
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      ttl INTEGER NOT NULL,
      priority INTEGER,
      FOREIGN KEY (domain_id) REFERENCES domains(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_dns_records_domain_id ON dns_records(domain_id);
  `);

  // Servers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      server_type TEXT NOT NULL,
      image TEXT NOT NULL,
      status TEXT NOT NULL,
      ipv4 TEXT,
      ipv6 TEXT,
      owner TEXT NOT NULL,
      price_monthly TEXT NOT NULL,
      created_at TEXT NOT NULL,
      root_password TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner);
  `);

  // Migration: configure-openclaw flips this flag. Added after the original
  // CREATE TABLE shipped, so guard against the 'duplicate column' on re-run.
  try { db.exec("ALTER TABLE servers ADD COLUMN openclaw_configured INTEGER DEFAULT 0"); } catch {}

  // Servers have been sold as "monthly" (GET /compute/plans has always said
  // billingPeriod: "monthly") but nothing ever recorded when the month ended,
  // so a single deploy payment bought an indefinitely-running box — several
  // tenants ran 100+ days on one month's fee. These columns give every server
  // an explicit `paid_through` plus a timestamp per rung of the lapse ladder
  // (notify -> idle -> snapshot+terminate). The ladder itself lives in
  // services/compute-lifecycle.ts; storage.setServer carries these forward so
  // a status refresh can't reset them.
  for (const col of [
    "ADD COLUMN paid_through TEXT",
    "ADD COLUMN expiry_notified_at TEXT",
    "ADD COLUMN idled_at TEXT",
    "ADD COLUMN terminated_at TEXT",
    "ADD COLUMN snapshot_id TEXT",
    "ADD COLUMN snapshot_expires_at TEXT",
  ]) {
    try { db.exec("ALTER TABLE servers " + col); } catch {}
  }

  // Backfill: every server that predates this column was sold as one month
  // from creation, so that's the period it actually bought. Long-expired rows
  // land in the ladder at the notify rung on the next sweep — nothing is
  // powered off or destroyed without a notification first.
  db.prepare(
    `UPDATE servers
        SET paid_through = datetime(created_at, ?)
      WHERE paid_through IS NULL`
  ).run(`+${SERVER_BILLING_DAYS} days`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_servers_paid_through ON servers(paid_through)");

  // Vestigial: the managed third-party API-key feature was removed (it only
  // ever issued fake stub keys). The table is retained, inert, so legacy
  // hackathon stat routes that COUNT(*) it keep returning 0 instead of throwing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('brave_search', 'helius', 'openai', 'anthropic', 'elevenlabs', 'custom')),
      label TEXT NOT NULL,
      secret TEXT NOT NULL,
      owner TEXT NOT NULL,
      price_usdc TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner);
    CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider);
  `);

  // Used Payments table (for transaction deduplication)
  db.exec(`
    CREATE TABLE IF NOT EXISTS used_payments (
      signature TEXT PRIMARY KEY,
      payer TEXT NOT NULL,
      amount_lamports TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      endpoint TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_used_payments_payer ON used_payments(payer);
    CREATE INDEX IF NOT EXISTS idx_used_payments_verified_at ON used_payments(verified_at);
  `);

  // Inbound SMS table (from webhook callbacks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_sms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telnyx_id TEXT UNIQUE NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT NOT NULL,
      media_count INTEGER DEFAULT 0,
      media_url TEXT,
      media_type TEXT,
      received_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_inbound_sms_to_number ON inbound_sms(to_number);
    CREATE INDEX IF NOT EXISTS idx_inbound_sms_received_at ON inbound_sms(received_at);
  `);

  // Inbound Emails table (from webhook callbacks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      text_body TEXT NOT NULL,
      html_body TEXT,
      attachment_count INTEGER DEFAULT 0,
      raw_data TEXT,
      received_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_inbound_emails_to_address ON inbound_emails(to_address);
    CREATE INDEX IF NOT EXISTS idx_inbound_emails_received_at ON inbound_emails(received_at);
  `);

  // Agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      wallet_address TEXT,
      webhook_url TEXT,
      token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
    CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(token);
    CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet_address);
  `);

  // API request log for analytics
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      payment_type TEXT CHECK(payment_type IN ('x402', 'hackathon', 'free')),
      cost_usdc TEXT,
      response_time_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_request_log_agent ON request_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_request_log_endpoint ON request_log(endpoint);
    CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);
  `);

  // Opt-in CLI telemetry. install_id is generated client-side on opt-in; we
  // never see who the user is. cmd is "phone search" / "wallet create" — no
  // flag values, no positional args. See cli/telemetry.ts for the full
  // capture contract.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      install_id TEXT NOT NULL,
      cmd TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER,
      cli_version TEXT,
      node_version TEXT,
      platform TEXT,
      client_ts TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );

    CREATE INDEX IF NOT EXISTS idx_cli_events_install ON cli_events(install_id);
    CREATE INDEX IF NOT EXISTS idx_cli_events_cmd ON cli_events(cmd);
    CREATE INDEX IF NOT EXISTS idx_cli_events_created ON cli_events(created_at);
  `);

  // Who's pulling SKILL.md? Agent attribution for the docs-fetch traffic.
  // agent_kind is coarse-bucketed by src/utils/agent-classifier.ts from the
  // raw User-Agent. We store the raw UA too (capped) so new buckets can be
  // back-filled later from the same data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_fetches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      user_agent TEXT,
      agent_kind TEXT,
      referer TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );

    CREATE INDEX IF NOT EXISTS idx_skill_fetches_created ON skill_fetches(created_at);
    CREATE INDEX IF NOT EXISTS idx_skill_fetches_kind ON skill_fetches(agent_kind);
  `);

  // Registered Agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS registered_agents (
      id TEXT PRIMARY KEY,
      wallet_address TEXT UNIQUE NOT NULL,
      agent_id TEXT UNIQUE,
      name TEXT,
      api_key TEXT UNIQUE NOT NULL,
      hackathon_verified INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_registered_agents_wallet ON registered_agents(wallet_address);
    CREATE INDEX IF NOT EXISTS idx_registered_agents_agent_id ON registered_agents(agent_id);
    CREATE INDEX IF NOT EXISTS idx_registered_agents_api_key ON registered_agents(api_key);
  `);

// Hackathon Usage table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hackathon_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL CHECK(service_type IN ('phone', 'email', 'server')),
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_hackathon_usage_agent_id ON hackathon_usage(agent_id);
    CREATE INDEX IF NOT EXISTS idx_hackathon_usage_service_type ON hackathon_usage(service_type);
    CREATE INDEX IF NOT EXISTS idx_hackathon_usage_created_at ON hackathon_usage(created_at);
  `);

  // Agent-to-agent messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      reply_to TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (from_agent) REFERENCES agents(id),
      FOREIGN KEY (to_agent) REFERENCES agents(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at);
  `);

  // Webhook delivery log
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_webhook_log_agent ON webhook_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_log_event ON webhook_log(event);
  `);

  // Balances
  db.exec(`
    CREATE TABLE IF NOT EXISTS balances (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      balance_usdc REAL NOT NULL DEFAULT 0,
      total_deposited REAL NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_balances_user ON balances(user_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('deposit', 'debit', 'refund')),
      amount_usdc REAL NOT NULL,
      description TEXT,
      service_type TEXT,
      reference_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_balance_tx_user ON balance_transactions(user_id);
  `);

  // Real (not advisory) idempotency for deposit()/refund(): a UNIQUE index on
  // reference_id lets the credit transaction itself reject a replayed deposit
  // via a constraint violation, instead of relying on a SELECT-then-INSERT race
  // outside the transaction. SQLite treats every NULL as distinct, so the many
  // existing NULL reference_id rows (all debits, legacy refunds) are unaffected.
  //
  // Wrapped in try/catch: if a pre-existing prod DB somehow holds duplicate
  // non-NULL reference_ids, the index build would throw and brick startup. In
  // that case we log for reconciliation and continue — the in-transaction
  // dup-check in balance.deposit() still guards against double-credit.
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_balance_tx_reference ON balance_transactions(reference_id)");
  } catch (err) {
    const dups = db.prepare(
      "SELECT reference_id, COUNT(*) AS n FROM balance_transactions WHERE reference_id IS NOT NULL GROUP BY reference_id HAVING n > 1"
    ).all();
    console.error(
      `[db] [WARNING] Could not create UNIQUE index on balance_transactions.reference_id — duplicate reference_ids exist. ` +
      `Reconcile these before relying on DB-level deposit idempotency:`, dups
    );
  }

  // Per-chain deposit scan cursor. Persisting the last fully-scanned block per
  // chain lets the Base deposit monitor resume across restarts instead of only
  // looking back a fixed window (which would miss deposits during any downtime
  // longer than that window).
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_cursor (
      chain TEXT PRIMARY KEY,
      last_block INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS deposit_wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      derivation_index INTEGER UNIQUE NOT NULL,
      solana_address TEXT NOT NULL,
      evm_address TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_deposit_wallets_user ON deposit_wallets(user_id);
    CREATE INDEX IF NOT EXISTS idx_deposit_wallets_sol ON deposit_wallets(solana_address);
    CREATE INDEX IF NOT EXISTS idx_deposit_wallets_evm ON deposit_wallets(evm_address);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS deposit_sweeps (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      chain TEXT NOT NULL CHECK(chain IN ('solana', 'base')),
      amount_usdc REAL NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
  `);

  // Dashboard users
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      wallet_address TEXT UNIQUE,
      wallet_chain TEXT,
      display_name TEXT,
      email_verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_dash_users_email ON dashboard_users(email);
    CREATE INDEX IF NOT EXISTS idx_dash_users_wallet ON dashboard_users(wallet_address);
  `);

  // Email verification shipped after dashboard accounts were already live.
  // Existing email/password users successfully authenticated before this
  // column existed, so grandfather them as verified exactly once. New users
  // are only inserted after consuming a verification link (dashboard-auth).
  const dashboardUserCols = db.prepare("PRAGMA table_info(dashboard_users)").all() as Array<{ name: string }>;
  if (!dashboardUserCols.some((c) => c.name === "email_verified_at")) {
    db.transaction(() => {
      db.exec("ALTER TABLE dashboard_users ADD COLUMN email_verified_at TEXT");
      db.exec("UPDATE dashboard_users SET email_verified_at = created_at WHERE email IS NOT NULL");
    })();
  }

  // Pending registrations are deliberately separate from dashboard_users:
  // an unverified address is not an account and cannot receive a session. The
  // hash stored here belongs to the same single-use token; re-registering
  // atomically replaces both, so an attacker cannot swap a victim's password
  // underneath a verification link that was already emailed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_pending_registrations (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      continue_path TEXT NOT NULL DEFAULT '/dashboard.html',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      last_sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dash_pending_token ON dashboard_pending_registrations(token_hash);
    CREATE INDEX IF NOT EXISTS idx_dash_pending_expiry ON dashboard_pending_registrations(expires_at);
  `);

  // Dashboard sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      FOREIGN KEY (user_id) REFERENCES dashboard_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_dash_sessions_token ON dashboard_sessions(token);
  `);

  // Agent Templates (marketplace)
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      thumbnail TEXT,
      blueprint TEXT NOT NULL,
      services TEXT NOT NULL,
      base_cost_usdc REAL NOT NULL DEFAULT 0,
      margin_usdc REAL NOT NULL DEFAULT 0,
      total_price_usdc REAL NOT NULL DEFAULT 0,
      deploys INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published', 'unlisted', 'removed')),
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      FOREIGN KEY (author_id) REFERENCES dashboard_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_templates_author ON templates(author_id);
    CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status);
  `);

  // Template deployments (tracks who bought/deployed what)
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_deployments (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'provisioning', 'completed', 'failed')),
      provisioning_log TEXT,
      resources TEXT,
      payment_tx TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      completed_at TEXT,
      FOREIGN KEY (template_id) REFERENCES templates(id),
      FOREIGN KEY (user_id) REFERENCES dashboard_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_template ON template_deployments(template_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_user ON template_deployments(user_id);
  `);

  // Projects (each project = a canvas with its own nodes/connections)
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      canvas_state TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
  `);

  // Per-account action log — drives server-side velocity caps for platforms
  // that suspend aggressively on high action rates (TikTok in particular).
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      operation TEXT NOT NULL,
      acted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_social_action_log_acc_plat_at
      ON social_action_log(account_id, platform, acted_at);
  `);

  // Wallet-auth nonces (single-use, short-TTL challenges for /auth/wallet)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_auth_nonces (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_auth_nonces_expires ON wallet_auth_nonces(expires_at);
  `);

  // Social account pool — admin-seeded accounts for sale to agents
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_account_pool (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      country TEXT,
      age_category TEXT,
      proxy_session_id TEXT NOT NULL,
      credentials_encrypted TEXT NOT NULL,
      cookies_encrypted TEXT,
      acquired_cost_usdc REAL,
      sale_price_usdc REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready', 'sold', 'dead')),
      sold_to_wallet TEXT,
      sold_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      tested_at TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pool_sold_to ON social_account_pool(sold_to_wallet);
  `);

  // Idempotent backfill: shared_with arrived alongside x_accounts and
  // social_registered_accounts; pool rows need it too so post-purchase
  // sharing works the same way.
  const poolCols = db.prepare("PRAGMA table_info(social_account_pool)").all() as Array<{ name: string }>;
  const poolColNames = new Set(poolCols.map(c => c.name));
  if (!poolColNames.has('shared_with')) {
    db.exec("ALTER TABLE social_account_pool ADD COLUMN shared_with TEXT DEFAULT '[]'");
  }
  // Payment provenance — captured at buy time so disputes can issue refunds
  // back to the original payer on the original chain. Rows seeded before this
  // feature shipped won't have these; the dispute service degrades to
  // admin_review when missing.
  //
  // Richer about_profile fields come from twitterapi.io's expanded user/info
  // response. We store them flat (one column each) so buy filters and
  // pool-status breakdowns can use plain SQL — keeping with the "strings >
  // structured objects, flat > nested" rule. source/username_change_count
  // back the new --source and --max-renames buy filters.
  for (const [col, spec] of [
    ['payment_signature', 'TEXT'],
    ['payment_chain', 'TEXT'],
    ['paid_amount_usdc', 'REAL'],
    ['detected_location', 'TEXT'],
    // `source` stores the raw "Connected via" string from twitterapi.io
    // (e.g. "United Kingdom Android App"). It encodes BOTH the country the
    // account was registered from AND the platform — we parse those into
    // the two columns below at seed time, but keep the raw value for audit
    // and exact-match filtering when needed.
    ['source', 'TEXT'],
    ['registered_country', 'TEXT'],         // ISO alpha-2 parsed from source
    ['registered_platform', 'TEXT'],        // 'android' | 'ios' | 'web' | NULL
    ['username_change_count', 'INTEGER'],   // 0 = never renamed
    ['account_based_in', 'TEXT'],           // free-text "United States, California"
    ['location_accurate', 'INTEGER'],       // 0/1 from twitterapi.io
    ['affiliate_username', 'TEXT'],         // org account handle, if any
    // X profile display name as first observed by the health sweep. Pool
    // personas are seeded with a name matching the handle, so a later change
    // means someone else is driving the account — see pool-health-sweep.ts.
    ['seed_display_name', 'TEXT'],
    ['health_checked_at', 'TEXT'],          // last health-sweep observation
  ] as const) {
    if (!poolColNames.has(col)) db.exec(`ALTER TABLE social_account_pool ADD COLUMN ${col} ${spec}`);
  }
  // Indexes supporting the most-common filter combos. Status comes first
  // since every buy starts with status='ready'.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pool_filters ON social_account_pool(status, platform, country, source, username_change_count);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pool_registration ON social_account_pool(status, platform, registered_country, registered_platform);`);
  // idx_pool_filters' leftmost columns (status, platform, country) already serve
  // every query the narrower idx_pool_status_platform_country could — drop the
  // redundant index so existing DBs stop paying for it on each pool write.
  db.exec(`DROP INDEX IF EXISTS idx_pool_status_platform_country;`);

  // Admin-set per-country prices that `palmyr twitter buy --country US` reads
  // from. Decouples pricing from per-account sale_price_usdc: one row per
  // country, the buy route looks it up at request time and the x402 402
  // response advertises the country-specific amount.
  db.exec(`
    CREATE TABLE IF NOT EXISTS country_prices (
      country TEXT PRIMARY KEY,
      price_usdc REAL NOT NULL CHECK(price_usdc > 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
  `);

  // Per-source multipliers applied on top of country_prices when a buy
  // request specifies --source. Final charge = country_price * multiplier.
  // Sources without a row (or buys without --source) implicitly use 1.0.
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_multipliers (
      source TEXT PRIMARY KEY,
      multiplier REAL NOT NULL CHECK(multiplier > 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
  `);

  // Dispute records for pool-bought accounts. Buyer files a dispute within
  // the 7-day window; the service auto-verifies via twitterapi.io and either
  // (a) replaces from same-country stock, (b) refunds the original payer, or
  // (c) queues for admin review when the signal is ambiguous.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_disputes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      claimant_wallet TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('suspended', 'other')),
      evidence TEXT,
      detection_status TEXT,
      detection_payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'admin_review', 'replaced', 'refunded', 'rejected')),
      resolution TEXT,
      replacement_account_id TEXT,
      refund_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      resolved_at TEXT,
      FOREIGN KEY (account_id) REFERENCES social_account_pool(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pool_disputes_account ON pool_disputes(account_id);
    CREATE INDEX IF NOT EXISTS idx_pool_disputes_claimant ON pool_disputes(claimant_wallet);
    CREATE INDEX IF NOT EXISTS idx_pool_disputes_status ON pool_disputes(status);
  `);

  // Wallet-registered social accounts — user uploads credentials once, server
  // encrypts them at rest, then re-uses them indefinitely (re-logging in when
  // cookies go stale). Distinct from social_account_pool: those are admin-
  // seeded for sale; these are wallet-bound BYO accounts the wallet owner
  // manages directly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_registered_accounts (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      country TEXT,
      proxy_session_id TEXT NOT NULL,
      credentials_encrypted TEXT NOT NULL,
      cookies_encrypted TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'session_expired', 'revoked')),
      registered_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      last_login_at TEXT,
      last_used_at TEXT,
      shared_with TEXT DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_registered_wallet_platform ON social_registered_accounts(wallet, platform);
    CREATE INDEX IF NOT EXISTS idx_registered_username ON social_registered_accounts(platform, username);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_registered_wallet_username
      ON social_registered_accounts(wallet, platform, username);
  `);

  // Idempotent backfill: shared_with arrived with the transfer feature
  // (#162) and may be missing on older prod DBs.
  const regCols = db.prepare("PRAGMA table_info(social_registered_accounts)").all() as Array<{ name: string }>;
  if (!regCols.some(c => c.name === 'shared_with')) {
    db.exec("ALTER TABLE social_registered_accounts ADD COLUMN shared_with TEXT DEFAULT '[]'");
  }

  // TikTok accounts that live entirely on the server: logged in inside their
  // own persistent browser profile, acting from it, with no credentials ever
  // exported. Deliberately NOT social_registered_accounts — that table requires
  // credentials_encrypted NOT NULL, and the whole point here is that there are
  // no credentials to store. The profile IS the credential.
  //
  // Before this, `account_id` was a caller-supplied string with no binding to
  // anyone: any wallet could name any account and act on it, and the protective
  // velocity caps keyed on that string reset the moment you changed it. A row
  // here makes ownership a fact the server can check.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tiktok_accounts (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      handle TEXT,
      country TEXT,
      proxy_session_id TEXT,
      tag TEXT,
      status TEXT NOT NULL DEFAULT 'connecting'
        CHECK(status IN ('connecting','active','logged_out','restricted','dead')),
      connected_at TEXT,
      last_seen_at TEXT,
      last_error_code TEXT,
      last_error_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_tiktok_accounts_owner ON tiktok_accounts(owner);
    CREATE INDEX IF NOT EXISTS idx_tiktok_accounts_tag ON tiktok_accounts(owner, tag);
  `);

  // Per-post engagement over time. Analytics used to be a one-shot scrape: the
  // caller paid, got a snapshot, and unless they stored it themselves the
  // history was gone. "Is this video still growing?" — the actual question —
  // was unanswerable from the server, and an agent hitting the API directly had
  // nowhere to accumulate anything.
  //
  // One row per (video, sample). Deliberately flat: the series IS the rows, so
  // reading it is an ORDER BY rather than a decode.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tiktok_post_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      caption TEXT,
      video_url TEXT,
      posted_at TEXT,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      privacy TEXT,
      sampled_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tpm_series ON tiktok_post_metrics(account_id, video_id, sampled_at);
    CREATE INDEX IF NOT EXISTS idx_tpm_account ON tiktok_post_metrics(account_id, sampled_at);
  `);

  // Observed hooks from the wider platform, per niche.
  //
  // Separate from tiktok_post_metrics on purpose: that table is what YOUR
  // accounts did, this is what other people's posts did. They must never be
  // averaged together — a hook that prints for a 5M-follower creator says
  // nothing about a new account, and blending the two would launder someone
  // else's reach into a claim about yours.
  //
  // `posted_at` is when the hook worked; `collected_at` is when we looked.
  // Both matter, because hooks decay: without the first the corpus cannot
  // answer "is this still working", and without the second it cannot show that
  // the answer changed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tiktok_niche_corpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      niche TEXT NOT NULL,
      query TEXT NOT NULL,
      video_id TEXT NOT NULL,
      author TEXT,
      caption TEXT,
      hook TEXT,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      shares INTEGER,
      saves INTEGER,
      posted_at TEXT,
      collected_at TEXT NOT NULL,
      UNIQUE(niche, video_id, collected_at)
    );
    CREATE INDEX IF NOT EXISTS idx_tnc_niche ON tiktok_niche_corpus(niche, collected_at);
    CREATE INDEX IF NOT EXISTS idx_tnc_posted ON tiktok_niche_corpus(niche, posted_at);

    -- What we paid and when, per collection. Kept even when a collection
    -- returns nothing, so a failing niche is visible rather than looking like
    -- one nobody has asked for.
    CREATE TABLE IF NOT EXISTS tiktok_niche_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      niche TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      queries INTEGER NOT NULL,
      posts INTEGER NOT NULL,
      cost_usdc REAL NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tncol_niche ON tiktok_niche_collections(niche, collected_at);
  `);

  // Server-side scheduled posts. Agents call POST /social/scheduled, pay
  // upfront via x402 (the payment covers the eventual fire — worker calls
  // the internal post function with no further charge). Worker polls
  // (status='pending' AND post_at <= now()) to find what to dispatch.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_social_posts (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      registered_account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('post', 'post_thread', 'post_media')),
      payload_json TEXT NOT NULL,
      post_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      paid_amount_usdc REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      attempted_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      cancelled_at TEXT,
      error TEXT,
      result_json TEXT,
      FOREIGN KEY (registered_account_id) REFERENCES social_registered_accounts(id)
    );
    -- Worker poll uses both columns; index covers it.
    CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_social_posts(status, post_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_wallet ON scheduled_social_posts(wallet, status);
  `);

  // i402 protocol — provider registry
  // Federated across: Palmyr primitives, Agentic Market, curated external APIs, ClawHub.
  // Every row is one callable x402 endpoint registered under one capability class.
  db.exec(`
    CREATE TABLE IF NOT EXISTS i402_providers (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(source IN ('agentos', 'agentic_market', 'external', 'clawhub', 'agent_composed')),
      capability TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'POST',
      auth_scheme TEXT NOT NULL CHECK(auth_scheme IN ('internal', 'x402-solana', 'x402-base', 'api_key', 'wallet_sig')),
      input_schema TEXT NOT NULL,
      output_schema TEXT NOT NULL,
      cost_per_call_usdc REAL NOT NULL,
      p50_latency_ms INTEGER,
      p99_latency_ms INTEGER,
      success_rate REAL NOT NULL DEFAULT 1.0,
      reputation_score REAL NOT NULL DEFAULT 0.5,
      embedding BLOB,
      enabled INTEGER NOT NULL DEFAULT 1,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
    );
    CREATE INDEX IF NOT EXISTS idx_i402_providers_capability ON i402_providers(capability, enabled);
    CREATE INDEX IF NOT EXISTS idx_i402_providers_source ON i402_providers(source);
    CREATE INDEX IF NOT EXISTS idx_i402_providers_reputation ON i402_providers(reputation_score DESC);
  `);

  // i402 protocol — agent sessions
  // A session is a multi-turn conversation bound to one wallet, tracking goal state + escrow.
  db.exec(`
    CREATE TABLE IF NOT EXISTS i402_agent_sessions (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      agent_id TEXT,
      budget_usdc REAL NOT NULL,
      spent_usdc REAL NOT NULL DEFAULT 0,
      escrow_usdc REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'cancelled', 'budget_exhausted', 'expired')) DEFAULT 'active',
      goal_graph TEXT,
      context_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      expires_at TEXT,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_i402_sessions_wallet ON i402_agent_sessions(wallet_address, status);
    CREATE INDEX IF NOT EXISTS idx_i402_sessions_status_active ON i402_agent_sessions(status, last_active_at);
  `);

  // i402 protocol — messages within a session (agent / orchestrator / tool / clarification)
  db.exec(`
    CREATE TABLE IF NOT EXISTS i402_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('agent', 'orchestrator', 'tool', 'clarification', 'system')),
      content TEXT NOT NULL,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      llm_cost_usdc REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      FOREIGN KEY (session_id) REFERENCES i402_agent_sessions(id),
      UNIQUE(session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_i402_messages_session ON i402_session_messages(session_id, seq);
  `);

  // i402 protocol — plans generated within a session
  db.exec(`
    CREATE TABLE IF NOT EXISTS i402_session_plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_seq INTEGER NOT NULL,
      intent TEXT NOT NULL,
      interpreted_intent TEXT,
      params TEXT,
      quality TEXT CHECK(quality IN ('fast', 'cheap', 'best')),
      steps TEXT NOT NULL,
      step_cost_usdc REAL NOT NULL,
      orchestration_fee_usdc REAL NOT NULL,
      total_cost_usdc REAL NOT NULL,
      within_budget INTEGER NOT NULL DEFAULT 1,
      execution_mode TEXT CHECK(execution_mode IN ('server_side', 'agent_side', 'hybrid')),
      status TEXT NOT NULL CHECK(status IN ('awaiting_approval', 'approved', 'executing', 'completed', 'failed', 'cancelled', 'budget_exceeded', 'clarification_needed')) DEFAULT 'awaiting_approval',
      approved_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      FOREIGN KEY (session_id) REFERENCES i402_agent_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_i402_plans_session ON i402_session_plans(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_i402_plans_status ON i402_session_plans(status);
  `);

  // i402 protocol — per-step execution results
  db.exec(`
    CREATE TABLE IF NOT EXISTS i402_session_step_results (
      plan_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      input TEXT,
      output TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'ok', 'error', 'timeout', 'skipped', 'cancelled')),
      latency_ms INTEGER,
      cost_charged_usdc REAL NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      x402_tx_signature TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (plan_id, step_id),
      FOREIGN KEY (plan_id) REFERENCES i402_session_plans(id),
      FOREIGN KEY (session_id) REFERENCES i402_agent_sessions(id),
      FOREIGN KEY (provider_id) REFERENCES i402_providers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_i402_steps_session ON i402_session_step_results(session_id);
    CREATE INDEX IF NOT EXISTS idx_i402_steps_provider ON i402_session_step_results(provider_id, status);
  `);

  // i402 protocol — artifacts produced by a session (domains, VPSes, accounts, inboxes)
  // Follow-up messages in the same session reference these for context inheritance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS i402_session_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plan_id TEXT,
      step_id TEXT,
      type TEXT NOT NULL,
      name TEXT,
      resource_ref TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      FOREIGN KEY (session_id) REFERENCES i402_agent_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_i402_artifacts_session ON i402_session_artifacts(session_id, type);
  `);

  // i402 protocol — escrow ledger (pay-in, debit, refund) for per-session x402 bookkeeping
  db.exec(`
    CREATE TABLE IF NOT EXISTS i402_escrow_ledger (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plan_id TEXT,
      step_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('deposit', 'debit_step', 'debit_orchestration_fee', 'refund')),
      amount_usdc REAL NOT NULL,
      balance_after_usdc REAL NOT NULL,
      tx_signature TEXT,
      chain TEXT CHECK(chain IN ('solana', 'base')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      FOREIGN KEY (session_id) REFERENCES i402_agent_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_i402_escrow_session ON i402_escrow_ledger(session_id, created_at);
  `);

  // Async X account transfers — Playwright password-rotation takes 30-90s
  // which exceeds Cloudflare's tunnel response timeout. Transfer endpoints
  // return immediately with a transfer_id; the rotation runs in-process via
  // setImmediate; CLI polls /transfers/:id for status. Same table now also
  // tracks unshare-with-rotate jobs (op='unshare_rotate' — rotates creds in
  // place without ownership change), since both share the slow Playwright
  // password-change op and benefit from the same async machinery.
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      account_kind TEXT NOT NULL CHECK(account_kind IN ('x_accounts', 'registered')),
      from_wallet TEXT NOT NULL,
      to_wallet TEXT NOT NULL,
      op TEXT NOT NULL DEFAULT 'transfer' CHECK(op IN ('transfer', 'unshare_rotate')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'rotating', 'completed', 'failed')),
      error TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_from_wallet ON transfers(from_wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_to_wallet ON transfers(to_wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status, created_at);
  `);

  // Idempotent: add `op` to older DBs created before unshare_rotate.
  const transferCols = db.prepare("PRAGMA table_info(transfers)").all() as Array<{ name: string }>;
  if (!transferCols.some(c => c.name === 'op')) {
    db.exec("ALTER TABLE transfers ADD COLUMN op TEXT NOT NULL DEFAULT 'transfer'");
  }

  console.log('✅ Database initialized with all tables');
}

// Initialize database when this module is imported
initDatabase();
