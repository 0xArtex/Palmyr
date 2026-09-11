import { Request } from "express";

// ── x402 Payment ──────────────────────────────────────────────

export interface PaymentProof {
  /** Solana transaction signature OR EVM tx hash */
  signature: string;
  /** Payer wallet address */
  payer: string;
  /** Amount in USDC (6 decimals) */
  amountLamports: bigint;
  /** Unix timestamp of verification */
  verifiedAt: number;
  /**
   * Which chain settled this payment. Required by the auto-refund path —
   * if the upstream call fails, treasury sends USDC back on the same chain
   * from which it was received. Optional only for legacy callers that
   * existed before the refund path; new handlers should rely on it.
   */
  chain?: "solana" | "base";
}

export interface AuthenticatedRequest extends Request {
  payment?: PaymentProof;
  agentId?: string;
  isHackathonMode?: boolean;
  /** Populated by the i402 session middleware when X-Session-Id is present and valid. */
  i402Session?: import("./services/i402-types").I402Session;
}

// ── Phone Service ─────────────────────────────────────────────

export interface PhoneNumber {
  id: string;
  phoneNumber: string;
  country: string;
  /** Payer wallet that provisioned this number */
  owner: string;
  provisionedAt: string;
  active: boolean;
  /** Wallets granted shared use (send/read/call) — cannot release, transfer, or re-share */
  sharedWith?: string[];
  /**
   * Disposable temp-lease fields (all NULL/undefined on a normal bought number).
   * A lease is functionally gone once `expiresAt` passes (reads 410, inbound
   * dropped), and hard-deleted by the sweep 15min later so the pool number frees.
   */
  expiresAt?: string;
  /** Lease start — clamps the visible SMS window so a lessee can't see a prior lessee's codes. */
  leaseStart?: string;
  /** True when this row is a lease of a pooled number (not a bought/permanent number). */
  poolNumber?: boolean;
}

export interface SmsMessage {
  id: string;
  phoneNumberId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  timestamp: string;
  /**
   * Lifecycle for outbound messages. `queued` is the initial state right
   * after Telnyx accepts the send; webhook events update it to `sent`,
   * `delivered`, `sending_failed`, or `delivery_failed`. Inbound messages
   * are stored with `delivered` since they're already on the device.
   */
  deliveryStatus?: "queued" | "sending" | "sent" | "delivered" | "sending_failed" | "delivery_failed";
  /** ISO 8601 timestamp of the last delivery_status update. */
  deliveryUpdatedAt?: string;
  /** Provider-supplied error string when delivery_status is *_failed. */
  providerError?: string;
}

export interface ProvisionNumberRequest {
  country: string;
  areaCode?: string;
}

export interface SendSmsRequest {
  to: string;
  body: string;
}

// ── Email Service ─────────────────────────────────────────────

export interface EmailInbox {
  id: string;
  address: string;
  /** e.g. "agent-name" portion of agent-name@palmyr.ai */
  localPart: string;
  owner: string;
  /** X25519 public key derived from a Solana wallet (base64). Absent on
   *  server-encrypted inboxes (owner pays on Base, or no Solana key supplied). */
  publicKey?: string;
  /** Solana Ed25519 public key (base58) — present only for E2E inboxes. */
  solanaPublicKey?: string;
  /** If true, messages are E2E-encrypted with the wallet key (server can't read).
   *  If false/absent, server-side AES with decrypt-on-read after an x402 proof. */
  e2eEnabled?: boolean;
  createdAt: string;
  active: boolean;
  /** ISO timestamp when a disposable temp inbox expires. Absent on normal
   *  (owned, non-expiring) inboxes. After this instant the inbox is treated as
   *  gone (reads 404, inbound mail dropped) and is hard-deleted after a grace. */
  expiresAt?: string;
}

export interface EmailMessage {
  id: string;
  inboxId: string;
  threadId?: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  messageId?: string;
  inReplyTo?: string;
  /** Encrypted with inbox's X25519 public key (base64) */
  subject: string;
  /** Encrypted with inbox's X25519 public key (base64) */
  body: string;
  html?: string;
  attachments?: EmailAttachment[];
  /** Whether content is E2E encrypted */
  encrypted: boolean;
  timestamp: string;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** base64-encoded content (E2E encrypted if inbox has e2eEnabled) */
  content?: string;
}

export interface EmailThread {
  id: string;
  inboxId: string;
  subject: string;
  participants: string[];
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export interface CreateInboxRequest {
  /** Desired local part — becomes {name}@mail.palmyr.dev */
  name: string;
}

export interface SendEmailRequest {
  to: string;
  subject: string;
  body: string;
  html?: string;
  /** Agent's private key to prove inbox ownership */
  privateKey: string;
}

// ── Domain Service ────────────────────────────────────────────

export interface Domain {
  id: string;
  domain: string;
  tld: string;
  owner: string;
  status: "pending" | "active" | "failed" | "expired";
  registrar: "namecheap" | "cloudflare";
  dnsRecords: DnsRecord[];
  registeredAt: string;
  expiresAt: string;
}

export interface DnsRecord {
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV";
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

export interface RegisterDomainRequest {
  name: string;
  tld: string;
}

export interface UpdateDnsRequest {
  records: DnsRecord[];
}

// ── Compute Service ───────────────────────────────────────────

// Server-type names are sourced live from Hetzner Cloud at boot
// (src/services/hcloud-types.ts) so we never hardcode a list that gets
// deprecated. Type-level it's just a string; the runtime registry validates.
export type ServerType = string;

export interface ServerPlan {
  type: ServerType;
  vcpu: number;
  ram: number;       // GB
  disk: number;      // GB
  traffic: number;   // TB included
  arch: "x86" | "arm";
  hetznerMonthly: number;  // EUR approx
  priceUsdc: string;       // what we charge
}

// Server-type plans + pricing are sourced LIVE from Hetzner — see
// src/services/hcloud-types.ts. Call `getServerPlans()` / `getServerPricing()`
// to read the current cached list (refreshed every 6h from
// GET /v1/server_types). The old static `SERVER_PLANS` / `SERVER_PRICING`
// constants were removed because they hardcoded types that get deprecated.

export type ServerAction = "reboot" | "poweron" | "poweroff" | "rebuild" | "reset" | "reset_password" | "request_console";

export interface Server {
  id: string;
  name: string;
  serverType: ServerType;
  image: string;
  status: string;
  ipv4: string | null;
  ipv6: string | null;
  owner: string;
  priceMonthly: string;
  createdAt: string;
  rootPassword: string | null;
  /**
   * Billing period + lapse-ladder state. Optional because createServer builds a
   * Server before the period is written; storage always reads them back.
   * See services/compute-lifecycle.ts for how the ladder advances.
   */
  paidThrough?: string | null;
  expiryNotifiedAt?: string | null;
  idledAt?: string | null;
  terminatedAt?: string | null;
  snapshotId?: string | null;
  snapshotExpiresAt?: string | null;
}

// ── Pricing ───────────────────────────────────────────────────

export interface PricingTier {
  service: string;
  action: string;
  /** USDC cost (human-readable, e.g. "1.00") */
  priceUsdc: string;
}
