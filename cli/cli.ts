#!/usr/bin/env node

// Load .env from CWD if present so users only maintain one config file for both
// the server and the CLI. Process env (set in shell) still wins over .env.
import 'dotenv/config'

// Must stay ABOVE the ./app.js and ./ui.js imports below: it sets NO_COLOR from
// `--no-color`/env before ui.ts freezes the theme. See no-color-init.ts.
import './no-color-init.js'

// Silence the noisy `bigint: Failed to load bindings, pure JS will be used`
// warning from bigint-buffer (transitive dep of @solana/web3.js). The pure JS
// fallback is fine for CLI one-shot use — the warning is cosmetic noise.
const __origWarn = console.warn
console.warn = (...args: any[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : ''
  if (msg.startsWith('bigint: Failed to load bindings')) return
  __origWarn.apply(console, args)
}

import React from 'react'
import { render as inkRender } from 'ink'
import { ComputeDeployScreen, ComputeListScreen, ComputePlansScreen, ConfigScreen, Dashboard, DoctorScreen, DomainCheckScreen, DomainPricingScreen, ErrorScreen, HealthScreen, MenuScreen, PricingScreen, RecordsScreen, SetupScreen, StatusScreen, SuccessScreen, WalletCreateScreen, WalletStatusScreen, WalletListScreen } from './app.js'
import { Palmyr, dnsRecordsOf, type DnsRecordInput } from './sdk.js'
import { loadConfig, saveConfig, ensureDirs, getKeyfile, log, addPhone, addInbox, addServer, addDomain, addNote } from './config.js'
import { getState as getTelemetryState, setEnabled as setTelemetryEnabled, queuedCount as telemetryQueuedCount, appendEventSync as telemetryAppendEvent, flushQueue as telemetryFlushQueue } from './telemetry.js'
import { theme as t, icon, Spinner, header, row, ok, fail, warn, info, subtle, divider, blank, table, box, initReport, banner, kv, section, listItem, statusLine, welcomeScreen, statusBar, panel, setAgentMode as setUiAgentMode } from './ui.js'
import { GLOBAL_FLAGS as GLOBAL_FLAG_NAMES, findUnknownFlags, flagNamesFromTable, insufficientBalanceMessage, parseDnsRecords, usdcShortfall } from './cli-guards.js'
import { existsSync, readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, extname, join } from 'path'

// (NO_COLOR / --no-color is handled by the ./no-color-init.js import above,
// which runs before ./ui.js freezes the theme.)

// Alias for backwards compat in help text
const c = { ...t, cyan: t.info, green: t.success, red: t.error, yellow: t.warn, white: t.text, gray: t.muted, orange: t.accent }

// Read version from package.json so the binary and the published version
// can never drift. dist/cli.js sits next to ../package.json after build.
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version as string
  } catch {
    return '0.0.0'
  }
})()

// ─── Exit codes ───
//
// These are part of the agent-facing CLI contract — agents branch on $? to
// distinguish "wrong flag" from "no funds" from "API unreachable". Treat
// them as semver-stable. New error categories get new codes; never repurpose
// an existing one.
const EXIT = {
  OK: 0,
  GENERAL: 1,
  BAD_INPUT: 2,
  AUTH_FAIL: 3,
  NOT_FOUND: 4,
  NETWORK: 5,
  PAYMENT: 6,
  SECURITY: 7,
} as const

const EXIT_CODE_DOCS = [
  { code: 0, name: 'OK', description: 'Success' },
  { code: 1, name: 'GENERAL', description: 'Unspecified failure' },
  { code: 2, name: 'BAD_INPUT', description: 'Missing or invalid flag/argument' },
  { code: 3, name: 'AUTH_FAIL', description: 'Authentication failed (bad token/session)' },
  { code: 4, name: 'NOT_FOUND', description: 'Wallet/resource not found' },
  { code: 5, name: 'NETWORK', description: 'API unreachable or transient network error' },
  { code: 6, name: 'PAYMENT', description: 'x402 payment verification or settlement failed' },
  { code: 7, name: 'SECURITY', description: 'Vault tamper / security check failed — do not retry' },
]

function render(node: React.ReactElement) {
  return inkRender(node)
}

// ─── Parse args ───
// Boolean flags that never take a value (prevents flag <next> from eating the next positional)
// `json` and `no-color` are agent-mode toggles; the rest are command-specific.
// Boolean flags never consume the next argv token — important so `palmyr
// wallet list --json` doesn't try to swallow whatever comes after.
const BOOLEAN_FLAGS = new Set([
  'help', 'version', 'managed', 'quiet', 'confirm', 'json', 'no-color',
  // compute deploy/ssh flags
  'wait', 'generate-ssh-key', 'generate', 'progress',
  // wallet trading flags
  'dry-run', 'all', 'protected', 'auto-slippage', 'degen', 'history',
  // wallet daemon + triggers flags
  'auto', 'clear',
  // wallet brief flags
  'evaluate',
  // tiktok connect hand-off flags. Default is QR (zero-install phone scan);
  // --local opens the browser on this machine. ('qr' tolerated as explicit default.)
  'qr', 'local',
  // chat run/resume: bypass the USDC balance preflight
  'skip-balance-check',
])

function parse(argv: string[]) {
  const flags: Record<string, string | boolean> = {}
  // Every `--flag` key exactly as typed (before the `no-` normalization below),
  // in argv order — the unknown-flag guard validates these against the resolved
  // command's allowlist before dispatch.
  const flagKeys: string[] = []
  const positional: string[] = []
  let command = ''
  let subcommand = ''
  // After we hit a bare `--`, every remaining argv element is a positional —
  // even if it starts with a dash. Lets `palmyr compute exec my-vps --
  // systemctl status --no-pager openclaw` pass `--no-pager` through to the
  // remote shell instead of being swallowed as a CLI flag.
  let inPositionalRun = false

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (inPositionalRun) { positional.push(arg); continue }
    if (arg === '--') { inPositionalRun = true; continue }
    if (!command && !arg.startsWith('-')) { command = arg; continue }
    if (command && !subcommand && !arg.startsWith('-')) { subcommand = arg; continue }

    if (arg.startsWith('--')) {
      // Handle --key=value syntax
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx)
        flags[key] = arg.slice(eqIdx + 1)
        flagKeys.push(key)
        continue
      }

      // Handle --no-prefix as boolean false
      const key = arg.slice(2)
      flagKeys.push(key)
      if (key.startsWith('no-')) {
        flags[key.slice(3)] = false
        continue
      }

      // Known boolean flags — never consume the next arg
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
        continue
      }

      // Otherwise: next arg is the value (if it exists and isn't a real flag).
      // A "real flag" starts with `--` or `-<letter>`. Things like `-25%` or
      // `-0.5` are NOT flags — they're negative numeric values for things like
      // `--cut -25%` or `--offset -0.5`. Treat those as the value.
      const next = argv[i + 1]
      const nextIsFlag = next !== undefined && next.length > 1 && (next.startsWith('--') || /^-[a-zA-Z]/.test(next))
      if (next !== undefined && !nextIsFlag) { flags[key] = next; i++ }
      else flags[key] = true
    } else {
      positional.push(arg)
    }
  }
  return { command, subcommand, positional, flags, flagKeys }
}

// Global agent-mode flag — set early in main() based on TTY detection + the
// --json flag. When true, every output path emits structured JSON (stdout for
// data, stderr for errors) and skips Ink rendering and ANSI decoration. This
// is the contract agents rely on: pipe stdout into jq, check $? against the
// EXIT table, parse stderr for the {error, exitCode} object on failure.
let AGENT_MODE = !process.stdout.isTTY

function err(msg: string, code: number = EXIT.BAD_INPUT, details?: Record<string, unknown>): never {
  if (AGENT_MODE) {
    process.stderr.write(JSON.stringify({ error: msg, ...(details ?? {}), exitCode: code }) + '\n')
    process.exit(code)
  }
  render(React.createElement(ErrorScreen, {
    version: VERSION,
    title: 'Command error',
    message: msg,
    footerLeft: 'Fix the command and retry',
  }))
  process.exit(code)
}

/**
 * If `e` is a RouteError / JupiterRouteError shape, emit the structured fields
 * + a stable exit code. Otherwise return `null` so the caller falls through to
 * the generic error path.
 *
 * Stable exit code mapping:
 *   - TOKEN_NOT_TRADABLE, NO_ROUTE → BAD_INPUT (2)
 *   - RATE_LIMITED, PROVIDER_ERROR → NETWORK (5)
 *
 * Also recognises plain "No position…" / "No Base position…" errors thrown by
 * the trading library and routes them to NOT_FOUND (4) so agents can branch on
 * a stable code instead of grepping for the message.
 */
function emitRouteErrorIfApplicable(e: unknown): never | null {
  const candidate = e as { errorCode?: string; provider?: string; chain?: string; status?: number; message?: string }
  if (candidate?.errorCode && candidate?.provider) {
    const stableExit = (candidate.errorCode === 'TOKEN_NOT_TRADABLE' || candidate.errorCode === 'NO_ROUTE')
      ? EXIT.BAD_INPUT
      : EXIT.NETWORK
    err(candidate.message ?? `${candidate.provider}: ${candidate.errorCode}`, stableExit, {
      errorCode: candidate.errorCode,
      provider: candidate.provider,
      chain: candidate.chain,
      status: candidate.status,
    })
  }
  if (candidate?.message && /^No (Base )?position for/i.test(candidate.message)) {
    err(candidate.message, EXIT.NOT_FOUND, { errorCode: 'POSITION_NOT_FOUND' })
  }
  return null
}

/** Show per-subcommand help with flag descriptions */
function subcommandHelp(command: string, subcommand: string, options: Array<{ flag: string; desc: string; hint?: string }>) {
  if (AGENT_MODE) {
    print({ command, subcommand, options })
    return
  }
  console.log(`\n  ${t.accent}palmyr ${command} ${subcommand}${t.reset}\n`)
  for (const opt of options) {
    const flagStr = `  ${t.info}${opt.flag.padEnd(24)}${t.reset}`
    const hintStr = opt.hint ? ` ${t.muted}${opt.hint}${t.reset}` : ''
    console.log(`${flagStr}${opt.desc}${hintStr}`)
  }
  console.log()
}

/**
 * Loud, single-shot warning printed when `--session-only` was chosen. Goes to
 * stderr so JSON on stdout stays clean. Caller supplies the write fn so we
 * route through the right stream in agent vs TTY mode.
 *
 * Why this is here: 1.8.2 and earlier defaulted to session-only without
 * warning. A user lost three wallets to a routine keyring change on a
 * headless box because the JSON file alone is mathematically useless without
 * the keychain secret. 1.8.3 makes the choice explicit; this warning is the
 * reminder for anyone who picks the foot-gun anyway.
 */
function emitSessionOnlyWarning(write: (s: string) => void) {
  write(`\n  ${t.warn}⚠  session-only wallet — NOT recoverable from the JSON file alone.${t.reset}\n`)
  write(`     Reboot, OS-keychain password change, or host copy permanently breaks decryption.\n`)
  write(`     Back up the mnemonic externally, or run \`palmyr wallet rekey <id> --passphrase <p>\` later.\n\n`)
}

/**
 * Progress feedback for the long (10-60s) trade calls (`wallet buy` / `sell`).
 * On a TTY we drive a Spinner with stage labels; in AGENT_MODE we mirror the
 * compute-deploy convention and emit `{event:'progress', stage, message}`
 * NDJSON lines to stderr so the final JSON on stdout stays clean. Returns an
 * object with `update(stage,msg)`, `done()`, and `fail()` so the caller can
 * bracket the await and signal completion from either branch.
 *
 * `wantNdjson` (default true) gates only the agent-mode stderr stream — pass
 * `--no-progress` to silence it (parity with `compute deploy`). The TTY spinner
 * is always shown; it's the whole point of the feature.
 *
 * Caller is responsible for calling done()/fail() exactly once.
 */
function tradeProgress(initialStage: string, initialMessage: string, wantNdjson = true) {
  const spin = new Spinner()
  const ndjson = AGENT_MODE && wantNdjson
  const emit = (stage: string, message: string) => {
    // Spinner self-suppresses in agent mode, so the NDJSON line is the only
    // signal agents get; on a TTY the Spinner is the signal and we skip NDJSON.
    if (AGENT_MODE) {
      if (ndjson) process.stderr.write(JSON.stringify({ event: 'progress', stage, message }) + '\n')
    } else {
      spin.update(message)
    }
  }
  // Kick off the spinner (no-op in agent mode) and emit the first stage.
  if (!AGENT_MODE) spin.start(initialMessage)
  else if (ndjson) process.stderr.write(JSON.stringify({ event: 'progress', stage: initialStage, message: initialMessage }) + '\n')
  return {
    update: emit,
    done(message = 'done') {
      if (AGENT_MODE) { if (ndjson) process.stderr.write(JSON.stringify({ event: 'progress', stage: 'confirmed', message }) + '\n') }
      else spin.stop(message, true)
    },
    fail(message = 'failed') {
      if (!AGENT_MODE) spin.cancel()
      // In agent mode the err() path emits the structured failure to stderr;
      // no extra progress line needed.
      void message
    },
  }
}

// ─── Subcommand help definitions ───
const WALLET_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  create: [
    { flag: '--name <name>', desc: 'Wallet name', hint: 'default: "My Wallet"' },
    { flag: '--solana', desc: 'Materialize the Solana account only', hint: 'default: both chains' },
    { flag: '--base', desc: 'Materialize the Base/EVM account only', hint: 'pair with --solana for both (default)' },
    { flag: '--tag <name>', desc: 'Folder-like grouping tag', hint: 'e.g. palmyr-demo — required with --count' },
    { flag: '--count <N>', desc: 'Bulk-create N wallets in one call (1-500)', hint: 'requires --tag' },
    { flag: '--name-prefix <p>', desc: 'Bulk name prefix; suffixed `-001..-N`', hint: 'default: same as --tag' },
    { flag: '--passphrase <p>', desc: 'Seal the mnemonic with this passphrase (≥8 chars) for durable recovery across reboot / OS-keychain loss / host migration', hint: 'or PALMYR_WALLET_PASSPHRASE env (env preferred — keeps phrase out of shell history). Interactive prompt on TTY when neither set.' },
    { flag: '--session-only', desc: 'OPT OUT of the passphrase fallback. Wallet is bound to this machine\'s OS keychain — dies on reboot/keyring loss/migration.', hint: 'use only for ephemeral / throwaway wallets where loss is acceptable' },
  ],
  import: [
    { flag: '--mnemonic <words>', desc: 'BIP-39 mnemonic phrase (required)' },
    { flag: '--name <name>', desc: 'Wallet name', hint: 'default: "Imported Wallet"' },
    { flag: '--solana', desc: 'Materialize the Solana account only' },
    { flag: '--base', desc: 'Materialize the Base/EVM account only' },
    { flag: '--tag <name>', desc: 'Assign a tag at import time' },
    { flag: '--passphrase <p>', desc: 'Seal the mnemonic with this passphrase (≥8 chars) for durable recovery', hint: 'or PALMYR_WALLET_PASSPHRASE env (env preferred). Interactive prompt on TTY when neither set.' },
    { flag: '--session-only', desc: 'OPT OUT of the passphrase fallback. Wallet is bound to this machine\'s OS keychain.', hint: 'use only for ephemeral / throwaway wallets' },
  ],
  rekey: [
    { flag: '<WALLET_ID>', desc: 'Wallet ID or name (positional or --id)' },
    { flag: '--passphrase <p>', desc: 'New passphrase to seal the mnemonic with (≥8 chars)', hint: 'or PALMYR_WALLET_PASSPHRASE env; interactive prompt if neither set' },
    { flag: '--current-passphrase <p>', desc: 'Existing passphrase, if the wallet was already rekeyed and the OS session secret is gone', hint: 'or PALMYR_WALLET_PASSPHRASE_CURRENT env' },
    { flag: '(note)', desc: 'Run on the original machine while the OS session secret is still resolvable. Becomes the durable recovery path on any other host.' },
  ],
  tags: [
    { flag: '(no args)', desc: 'List all tags with wallet count, chains, and date range' },
  ],
  tag: [
    { flag: '<WALLET_ID>', desc: 'Wallet id or name (positional or --id)' },
    { flag: '<TAG>', desc: 'Tag to assign (positional)' },
    { flag: '--clear', desc: 'Remove the tag from this wallet instead of assigning one' },
  ],
  'tag-delete': [
    { flag: '<TAG>', desc: 'Tag to wipe (positional)' },
    { flag: '--confirm', desc: 'Required — deletes every wallet sharing this tag (irreversible)' },
  ],
  list: [
    { flag: '--tag <name>', desc: 'Filter to wallets in this tag' },
  ],
  'sign-message': [
    { flag: '<WALLET_ID>', desc: 'Wallet ID (positional or --id)' },
    { flag: '--chain <chain>', desc: 'Chain to sign on (required)', hint: 'solana | evm' },
    { flag: '--msg <message>', desc: 'Message to sign (required)' },
  ],
  register: [
    { flag: '<WALLET_ID>', desc: 'Wallet ID or name to register as an agent (positional or --id)' },
    { flag: '--name <name>', desc: 'Agent name (≥2 chars, must be unique on the server)', hint: 'default: the wallet name' },
    { flag: '--chain <chain>', desc: 'Which chain address becomes the agent identity', hint: 'solana (default when present) | base' },
    { flag: '--description <text>', desc: 'Optional agent description' },
    { flag: '--webhook-url <url>', desc: 'Optional webhook URL stored on the agent' },
    { flag: '(proof)', desc: 'Signs `palmyr-register:<wallet>:<timestamp>` with the wallet key to prove control (Ed25519 for Solana, EIP-191 for Base). Honors PALMYR_WALLET_PASSPHRASE for headless wallets.' },
  ],
  'api-key': [
    { flag: '<WALLET_ID>', desc: 'Wallet ID (positional or --id)' },
    { flag: '--name <name>', desc: 'API key name', hint: 'default: "cli-agent"' },
  ],
  'request-approval': [
    { flag: '<WALLET_ID>', desc: 'Wallet ID (positional or --id)' },
    { flag: '--action <type>', desc: 'Approval action', hint: 'default: "limits"' },
    { flag: '--daily <usdc>', desc: 'Requested daily USDC limit' },
    { flag: '--tx <usdc>', desc: 'Requested per-tx USDC limit' },
  ],
  export: [
    { flag: '<WALLET_ID>', desc: 'Wallet ID (positional or --id)' },
    { flag: '--confirm', desc: 'Confirm you understand the risk of exposing the mnemonic' },
  ],
  use: [
    { flag: '<WALLET_ID>', desc: 'Wallet ID to use for x402 payments (positional or --id)' },
    { flag: '--chain <chain>', desc: 'Which chain to pay on', hint: 'solana (default) | base' },
  ],
  buy: [
    { flag: '<CHAIN>', desc: 'Chain (positional)', hint: 'solana' },
    { flag: '<CA>', desc: 'Token mint / contract address (positional)' },
    { flag: '--amount <amt>', desc: 'Amount + asset suffix (required). Suffix picks the input asset.', hint: 'e.g. 0.5sol, 0.01eth, 10usdc' },
    { flag: '--thesis "..."', desc: 'Plain-string reasoning for the entry (required)' },
    { flag: '--cut <pct>', desc: 'Stop-loss target', hint: 'e.g. -25%' },
    { flag: '--tp <pct>', desc: 'Take-profit target', hint: 'e.g. +40%' },
    { flag: '--trail <pct>', desc: 'Trailing-stop (drop from peak in pct points)', hint: 'e.g. 20%' },
    { flag: '--time-limit <dur>', desc: 'Sell after duration regardless of PnL', hint: 'e.g. 24h, 30m, 7d' },
    { flag: '--thesis-check <dur>', desc: 'Daemon LLM thesis-health interval', hint: 'e.g. 6h (needs ANTHROPIC_API_KEY)' },
    { flag: '--hold-if "..."', desc: 'Free-form hold condition (informational)' },
    { flag: '--wallet <id|name>', desc: 'Vault wallet to sign with (else env WALLET_SECRET_KEY)' },
    { flag: '--slippage <bps>', desc: 'Explicit slippage in basis points', hint: 'overrides --auto-slippage' },
    { flag: '--degen', desc: 'Disable MEV protection + dynamic slippage. Faster / cheaper, no sandwich defense.' },
    { flag: '--no-protected', desc: 'Disable MEV protection only (keep dynamic slippage)' },
    { flag: '--no-auto-slippage', desc: 'Disable dynamic slippage only (use config default or --slippage)' },
    { flag: '--tip <amount>', desc: 'Override the protection tip — sol: Jito tip lamports (default 10000); base: priority fee gwei (default 0.001)' },
    { flag: '--rpc <url>', desc: 'Override RPC endpoint (base only; default uses PALMYR_BASE_PROTECTED_RPC env if set)' },
    { flag: '--template <name>', desc: 'YAML strategy template (see `wallet template list`). CLI flags win on conflict.' },
    { flag: '--dry-run', desc: 'Simulate without sending the swap' },
  ],
  cohort: [
    { flag: 'buy <CHAIN> <CA>', desc: 'Split a buy across N derived wallets with timing jitter (Phase 4c)' },
    { flag: '--total <amt>', desc: 'Total amount + asset suffix across all cohort legs (required unless template supplies it)', hint: 'e.g. 1.0sol, 0.05eth, 100usdc' },
    { flag: '--thesis "..."', desc: 'Plain-string reasoning (shared across all legs) — required' },
    { flag: '--wallets <list>', desc: 'Explicit comma-separated wallet refs (vault names/ids or `trading:N`)', hint: 'e.g. alice,bob,carol or trading:0,trading:1,trading:2' },
    { flag: '--from trading:N --split K', desc: 'Power-user: derive K consecutive wallets from the trading-keystore starting at index N' },
    { flag: '--jitter <ms>', desc: 'Random delay [0..jitterMs] between legs; first leg fires immediately', hint: 'default 0' },
    { flag: '--template <name>', desc: 'YAML strategy template. Can supply chain, total, exit plan, and cohort {split,from,jitterMs}.' },
    { flag: '(other flags)', desc: 'Same as `buy`: --cut, --tp, --trail, --time-limit, --thesis-check, --slippage, --protected, --tip, --rpc, --dry-run' },
  ],
  template: [
    { flag: 'list', desc: 'List installed templates; auto-installs bundled examples on first run' },
    { flag: 'show <name>', desc: 'Print template YAML body + metadata' },
    { flag: 'path <name>', desc: 'Print the absolute file path so you can pipe it to your editor' },
    { flag: 'delete <name>', desc: 'Remove a template file' },
  ],
  positions: [
    { flag: '--chain <chain>', desc: 'Filter by chain', hint: 'solana' },
    { flag: '--wallet <id|name>', desc: 'Filter by signing wallet (vault ref)' },
    { flag: '--all', desc: 'Include closed positions (default: open only)' },
  ],
  position: [
    { flag: '<CA>', desc: 'Token mint / contract address (positional or --ca)' },
  ],
  sell: [
    { flag: '<CHAIN>', desc: 'Chain (positional)', hint: 'solana' },
    { flag: '<CA>', desc: 'Token mint / contract address (positional)' },
    { flag: '--percent <n>', desc: 'Percent of remaining tokens to sell (required)', hint: '1-100' },
    { flag: '--reason "..."', desc: 'Why are you exiting? (required)' },
    { flag: '--wallet <id|name>', desc: 'Vault wallet to sign with (else env)' },
    { flag: '--slippage <bps>', desc: 'Explicit slippage in basis points', hint: 'overrides --auto-slippage' },
    { flag: '--degen', desc: 'Disable MEV protection + dynamic slippage' },
    { flag: '--no-protected', desc: 'Disable MEV protection only' },
    { flag: '--no-auto-slippage', desc: 'Disable dynamic slippage only' },
    { flag: '--tip <amount>', desc: 'Override protection tip (sol: Jito lamports; base: priority fee gwei)' },
    { flag: '--rpc <url>', desc: 'Override RPC endpoint (base only)' },
    { flag: '--dry-run', desc: 'Simulate without sending the swap' },
  ],
  sync: [
    { flag: '--wallet <id|name>', desc: 'Vault wallet whose positions to reconcile (else env signer)' },
    { flag: '--chain <chain>', desc: 'Chain to sync', hint: 'solana | base (default solana)' },
  ],
  pnl: [
    { flag: '--by <group>', desc: 'Group output', hint: 'wallet | chain' },
    { flag: '--since <date>', desc: 'Filter by entry date', hint: 'ISO 8601 or YYYY-MM-DD' },
    { flag: '--no-usd', desc: 'Skip USD price lookups (default: include cross-chain USD totals)' },
  ],
  journal: [
    { flag: 'add <CA> --note "..."', desc: 'Append a note (omit CA for a general note)' },
    { flag: 'show [--ca <CA>] [--date <YYYY-MM-DD>]', desc: 'List or read journal entries' },
  ],
  watch: [
    { flag: 'add <CA> --trigger "..."', desc: 'Add a CA to the watchlist with a trigger condition' },
    { flag: 'list', desc: 'Show the watchlist' },
  ],
  brief: [
    { flag: '<CA>', desc: 'Show a position brief: thesis + PnL + last sync time' },
    { flag: '--evaluate', desc: 'Ask Claude (Haiku) whether the thesis still holds (requires ANTHROPIC_API_KEY)' },
  ],
  'trading-keystore': [
    { flag: 'init [--count N] [--mnemonic "..."]', desc: 'Create encrypted keystore (BIP39 + scrypt + AES-256-GCM, default count 5)' },
    { flag: 'unlock [--ttl <dur>]', desc: 'Prompt passphrase, cache decrypted seed in OS keychain. --ttl sets cache lifetime (default 24h; examples: 30m, 4h, 7d)' },
    { flag: 'lock', desc: 'Clear the cached seed from OS keychain' },
    { flag: 'list', desc: 'List derived wallet addresses (no unlock needed)' },
    { flag: 'status', desc: 'Show keystore exists / wallet count / locked vs unlocked' },
    { flag: 'derive --count N', desc: 'Derive N more wallets (uses cached seed if unlocked)' },
    { flag: 'export --confirm', desc: 'Print the mnemonic (always requires passphrase, no cache fallback)' },
    { flag: '(passphrase)', desc: 'PALMYR_TRADING_KEYSTORE_PASSPHRASE env > interactive prompt > OS keychain cache' },
  ],
  daemon: [
    { flag: 'tick', desc: 'One-shot: sync positions + evaluate triggers + exit' },
    { flag: 'start [--interval N] [--auto] [--wallet <id|name>]', desc: 'Spawn detached monitor daemon' },
    { flag: 'stop', desc: 'Stop the running daemon (SIGTERM + cleanup)' },
    { flag: 'status', desc: 'Show daemon liveness + last tick time' },
    { flag: '--interval <s>', desc: 'Tick interval in seconds', hint: 'default 30' },
    { flag: '--auto', desc: 'Auto-execute sell(100%) when a trigger fires' },
  ],
  triggers: [
    { flag: '--ca <CA>', desc: 'Filter by mint address' },
    { flag: '--since <iso>', desc: 'Filter to fires after this timestamp' },
    { flag: '--clear', desc: 'Truncate pending.jsonl after listing' },
  ],
  'evm-quote': [
    { flag: '<SRC> <DST>', desc: 'Token addresses (0x... or `eth` for native)' },
    { flag: '--amount <raw>', desc: 'Raw u256 amount in src smallest unit (required)' },
    { flag: '--chain <c>', desc: 'Chain', hint: 'base (default) | other EVM chains by numeric id' },
    { flag: '--src-decimals <n>', desc: 'Source token decimals', hint: 'default 18' },
    { flag: '--dst-decimals <n>', desc: 'Dest token decimals', hint: 'default 6 (USDC-like)' },
  ],
  'pay-preflight': [
    { flag: '--chain <c>', desc: 'Override the default pay chain', hint: 'solana | base (default: config.defaultPayChain)' },
    { flag: '--wallet <ID>', desc: 'Override the wallet to check', hint: 'default: config.defaultPayWalletId / PALMYR_PAY_WALLET / auto-pick' },
    { flag: '--min-usdc <N>', desc: 'Required USDC balance to pass (default 0 — just check the wallet exists)' },
    { flag: '--passphrase <p>', desc: 'Wallet passphrase if no OS-keychain session secret', hint: 'or PALMYR_WALLET_PASSPHRASE env' },
    { flag: '(price)', desc: 'Free — one RPC call to read USDC balance' },
    { flag: '(example)', desc: 'palmyr wallet pay-preflight --chain base --min-usdc 3 --json' },
    { flag: '(note)', desc: 'Local-only version runs automatically before every paid command (set PALMYR_NO_PREFLIGHT=1 to disable)' },
  ],
}

const PHONE_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  search: [
    { flag: '--country <ISO>', desc: 'Country code', hint: 'default US (e.g. US, GB, AE)' },
    { flag: '--limit <N>', desc: 'Max results to return' },
    { flag: '(price)', desc: 'Free — no payment required' },
    { flag: '(example)', desc: 'palmyr phone search --country US --json' },
  ],
  buy: [
    { flag: '--country <ISO>', desc: 'Country code (required)', hint: 'e.g. US, GB' },
    { flag: '--area <code>', desc: 'Preferred area code (optional, US only)' },
    { flag: '(price)', desc: '$3.00 per number provisioned' },
    { flag: '(example)', desc: 'palmyr phone buy --country US' },
  ],
  temp: [
    { flag: '--ttl <seconds>', desc: 'Lease lifetime before auto-expiry (default 1800 = 30min, min 300, max 1800)' },
    { flag: '(price)', desc: '$0.20 per 30-min lease — instant, receive-only US number from a pool' },
    { flag: '(note)', desc: 'Receive-only for verification codes (Google/X/Discord OK; Telegram/WhatsApp/OpenAI often block VoIP). Call `phone wait-otp <id>` to catch the code.' },
    { flag: '(example)', desc: 'palmyr phone temp --ttl 1800' },
  ],
  extend: [
    { flag: '<id>', desc: 'Temp lease id (from `palmyr phone temp`) to extend (required; --id also accepted)' },
    { flag: '(price)', desc: '$0.20 per +30min — stackable up to 24h total; expired leases 404 (no revival)' },
    { flag: '(example)', desc: 'palmyr phone extend PN_abc' },
  ],
  sms: [
    { flag: '--id <PHONE_ID>', desc: 'Source phone number id (required)' },
    { flag: '--to <+E.164>', desc: 'Destination phone number (required)', hint: 'e.g. +15551234567' },
    { flag: '--body <text>', desc: 'Message body (required)' },
    { flag: '(price)', desc: '$0.05 per SMS sent' },
    { flag: '(example)', desc: 'palmyr phone sms --id PN_abc --to +15551234567 --body "hi"' },
  ],
  call: [
    { flag: '--id <PHONE_ID>', desc: 'Source phone number id (required)' },
    { flag: '--to <+E.164>', desc: 'Destination phone number (required)' },
    { flag: '--tts <text>', desc: 'Text-to-speech to play on answer (optional)' },
    { flag: '(price)', desc: '$0.10 per call placed' },
    { flag: '(example)', desc: 'palmyr phone call --id PN_abc --to +15551234567 --tts "hello"' },
  ],
  list: [
    { flag: '(no args)', desc: 'List phone numbers owned by or shared with your wallet (rows tagged access: owner/shared)' },
    { flag: '(price)', desc: '$0.01 per call' },
    { flag: '(example)', desc: 'palmyr phone list --json' },
  ],
  messages: [
    { flag: '--id <PHONE_ID>', desc: 'Phone number id to read SMS for (required; positional also accepted)' },
    { flag: '(price)', desc: '$0.02 per call' },
    { flag: '(example)', desc: 'palmyr phone messages --id PN_abc' },
  ],
  message: [
    { flag: '--id <MESSAGE_ID>', desc: 'SMS message id (Telnyx-supplied; positional also accepted)' },
    { flag: '(price)', desc: '$0.005 per readback — cheap so agents can poll until delivery_status is terminal' },
    { flag: '(example)', desc: 'palmyr phone message <message-id-from-sms-response>' },
  ],
  'wait-otp': [
    { flag: '<number-id>', desc: 'Phone number id to wait on (required; --id also accepted)' },
    { flag: '--timeout <s>', desc: 'Seconds to block waiting — integer 1-90 (default 60)' },
    { flag: '--lookback <s>', desc: 'Also match codes that arrived up to this many seconds BEFORE the call — integer 0-300 (default 10)', hint: 'pass 0 when reusing a number across signups so a stale code can’t be re-served' },
    { flag: '--pattern <regex>', desc: 'Custom extraction regex overriding the default OTP formats (first capture group wins; max 256 chars)' },
    { flag: '(price)', desc: '$0.02 per wait — one call replaces hand-rolled polling of `phone messages`' },
    { flag: '(example)', desc: 'palmyr phone wait-otp PN_abc --timeout 90' },
  ],
  'sms-status': [
    { flag: '<message-id>', desc: 'Alias for `palmyr phone message <id>` — readback by id' },
    { flag: '(price)', desc: '$0.005 per readback' },
  ],
  calls: [
    { flag: '--id <PHONE_ID>', desc: 'Phone number id to list calls for (required; positional also accepted)' },
    { flag: '(price)', desc: '$0.02 per call' },
    { flag: '(example)', desc: 'palmyr phone calls --id PN_abc' },
  ],
  release: [
    { flag: '--id <PHONE_ID>', desc: 'Phone number id to release (required; positional also accepted)' },
    { flag: '(price)', desc: '$0.01 per release (stops monthly Telnyx billing)' },
    { flag: '(example)', desc: 'palmyr phone release --id PN_abc' },
  ],
  'transfer-ownership': [
    { flag: '--id <PHONE_ID>', desc: 'Phone number id to transfer (required; positional also accepted)' },
    { flag: '--to <wallet>', desc: 'New owner — Solana (base58) or EVM (0x…) wallet (required)' },
    { flag: '(price)', desc: '$0.01 ownership proof. Clears shared access — collaborators don’t travel with the number' },
    { flag: '(example)', desc: 'palmyr phone transfer-ownership --id PN_abc --to <wallet>' },
  ],
  share: [
    { flag: '--id <PHONE_ID>', desc: 'Phone number id to share (required; positional also accepted)' },
    { flag: '--with <wallet>', desc: 'Wallet to grant shared use — can send/read SMS and place calls (required)' },
    { flag: '(price)', desc: '$0.01 ownership proof. Owner-only; ownership stays with you' },
    { flag: '(example)', desc: 'palmyr phone share --id PN_abc --with <wallet>' },
  ],
  unshare: [
    { flag: '--id <PHONE_ID>', desc: 'Phone number id (required; positional also accepted)' },
    { flag: '--from <wallet>', desc: 'Wallet to revoke shared use from (required; --wallet alias accepted)' },
    { flag: '(price)', desc: '$0.01 ownership proof. Owner-only' },
    { flag: '(example)', desc: 'palmyr phone unshare --id PN_abc --from <wallet>' },
  ],
  'call-info': [
    { flag: '--call <CALL_ID>', desc: 'Call control id (required; --id and positional also accepted)' },
    { flag: '(price)', desc: '$0.02 per lookup' },
    { flag: '(example)', desc: 'palmyr phone call-info --call CC_abc' },
  ],
  speak: [
    { flag: '--call <CALL_ID>', desc: 'Call control id of a live call (required)' },
    { flag: '--text <text>', desc: 'TTS text to speak (required; --tts alias accepted)' },
    { flag: '--voice <name>', desc: 'TTS voice (optional, provider default otherwise)' },
    { flag: '--language <code>', desc: 'TTS language code (optional, e.g. en-US)' },
    { flag: '(price)', desc: '$0.08 per speak action' },
    { flag: '(example)', desc: 'palmyr phone speak --call CC_abc --text "please hold"' },
  ],
  play: [
    { flag: '--call <CALL_ID>', desc: 'Call control id of a live call (required)' },
    { flag: '--url <audio_url>', desc: 'Public audio URL to play (required; --audio-url alias accepted)' },
    { flag: '(price)', desc: '$0.08 per playback' },
    { flag: '(example)', desc: 'palmyr phone play --call CC_abc --url https://example.com/hold.mp3' },
  ],
  dtmf: [
    { flag: '--call <CALL_ID>', desc: 'Call control id of a live call (required)' },
    { flag: '--digits <seq>', desc: 'DTMF digit sequence (required; positional also accepted)', hint: 'e.g. "1234#"' },
    { flag: '(price)', desc: '$0.02 per DTMF send' },
    { flag: '(example)', desc: 'palmyr phone dtmf --call CC_abc --digits "1234#"' },
  ],
  gather: [
    { flag: '--call <CALL_ID>', desc: 'Call control id of a live call (required)' },
    { flag: '--min-digits <N>', desc: 'Minimum digits to collect (optional)' },
    { flag: '--max-digits <N>', desc: 'Maximum digits to collect (optional)' },
    { flag: '--timeout <ms>', desc: 'Per-input timeout in milliseconds (optional)' },
    { flag: '--terminating-digit <d>', desc: 'Digit that ends collection (optional, e.g. "#")' },
    { flag: '--prompt <text>', desc: 'Optional TTS prompt to play before gathering' },
    { flag: '--prompt-voice <name>', desc: 'TTS voice for the prompt (optional)' },
    { flag: '(price)', desc: '$0.08 per gather action' },
    { flag: '(example)', desc: 'palmyr phone gather --call CC_abc --max-digits 4 --terminating-digit "#" --prompt "Enter PIN"' },
  ],
  record: [
    { flag: '--call <CALL_ID>', desc: 'Call control id of a live call (required)' },
    { flag: '--format <fmt>', desc: 'Recording format (optional, provider default otherwise)' },
    { flag: '(price)', desc: '$0.10 per record start' },
    { flag: '(example)', desc: 'palmyr phone record --call CC_abc --format mp3' },
  ],
  'record-stop': [
    { flag: '--call <CALL_ID>', desc: 'Call control id of a live call (required)' },
    { flag: '(price)', desc: '$0.02 per stop' },
    { flag: '(example)', desc: 'palmyr phone record-stop --call CC_abc' },
  ],
  hangup: [
    { flag: '--call <CALL_ID>', desc: 'Call control id of a live call (required)' },
    { flag: '(price)', desc: '$0.02 per hangup' },
    { flag: '(example)', desc: 'palmyr phone hangup --call CC_abc' },
  ],
  answer: [
    { flag: '--call <CALL_ID>', desc: 'Call control id of an inbound call (required)' },
    { flag: '(price)', desc: '$0.02 per answer' },
    { flag: '(example)', desc: 'palmyr phone answer --call CC_abc' },
  ],
  transfer: [
    { flag: '--call <CALL_ID>', desc: 'Call control id of a live call (required)' },
    { flag: '--to <+E.164>', desc: 'Destination phone number to bridge into (required)' },
    { flag: '(price)', desc: '$0.10 per transfer' },
    { flag: '(example)', desc: 'palmyr phone transfer --call CC_abc --to +15557654321' },
  ],
}

const EMAIL_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  create: [
    { flag: '--name <name>', desc: 'Inbox name (required)' },
    { flag: '--domain <domain>', desc: 'Wallet-owned domain to host the inbox on (optional)', hint: 'default: Palmyr-hosted domain' },
    { flag: '--wallet <id|name|sol_pubkey>', desc: 'Inbox owner — vault id/name (resolves to its Solana address) or a raw Solana pubkey. Omit to use the paying wallet.', hint: 'E2E encryption is Ed25519, so the owner must always be a Solana address — Base addresses cannot own an inbox' },
    { flag: '(price)', desc: '$2.00 per inbox provisioned' },
    { flag: '(example)', desc: 'palmyr email create --name agent --domain example.com' },
  ],
  temp: [
    { flag: '--ttl <seconds>', desc: 'Lifetime before the inbox auto-expires (optional; default 86400 = 24h, min 300, max 604800)' },
    { flag: '(note)', desc: 'Disposable, receive-only inbox on a dedicated inbox domain (natural handle, server-generated) — reads return plaintext' },
    { flag: '(price)', desc: '$0.50 per disposable inbox' },
    { flag: '(example)', desc: 'palmyr email temp --ttl 3600' },
  ],
  extend: [
    { flag: '--id <INBOX_ID>', desc: 'Temp inbox id (from `palmyr email temp`) to extend (required; positional also accepted)' },
    { flag: '(note)', desc: 'Rents another 7 days on a LIVE temp inbox — fixed +7d per call, stackable, no cap. Expired temp inboxes cannot be revived (buy a new one).' },
    { flag: '(price)', desc: '$0.50 per 7-day extension' },
    { flag: '(example)', desc: 'palmyr email extend --id 8b6cf4a2-91d3-4f0e-b2a7-3c5d1e9f6a04' },
  ],
  list: [
    { flag: '(no args)', desc: 'List inboxes owned by your wallet' },
    { flag: '(price)', desc: '$0.01 per call' },
    { flag: '(example)', desc: 'palmyr email list --json' },
  ],
  status: [
    { flag: '<domain>', desc: 'Domain to check (positional or --domain)', hint: 'e.g. example.com' },
    { flag: '(price)', desc: '$0.01 per call' },
    { flag: '(example)', desc: 'palmyr email status example.com' },
  ],
  register: [
    { flag: '<domain>', desc: 'Wallet-owned domain to (re-)register with Mailgun (positional or --domain)' },
    { flag: '(price)', desc: '$0.05 per registration' },
    { flag: '(example)', desc: 'palmyr email register example.com' },
  ],
  read: [
    { flag: '--id <INBOX_ID>', desc: 'Inbox id (required; positional also accepted)' },
    { flag: '(price)', desc: '$0.02 per call' },
    { flag: '(example)', desc: 'palmyr email read --id INB_abc123' },
  ],
  send: [
    { flag: '--id <INBOX_ID>', desc: 'Source inbox id (required)' },
    { flag: '--to <addr>', desc: 'Destination email (required)' },
    { flag: '--subject <text>', desc: 'Subject line (required)' },
    { flag: '--body <text>', desc: 'Message body (required)' },
    { flag: '(price)', desc: '$0.08 per email sent' },
    { flag: '(example)', desc: 'palmyr email send --id INB_abc --to user@x.com --subject Hi --body "..."' },
  ],
  threads: [
    { flag: '--id <INBOX_ID>', desc: 'Inbox id (required; positional also accepted)' },
    { flag: '(price)', desc: '$0.02 per call' },
    { flag: '(example)', desc: 'palmyr email threads --id INB_abc123' },
  ],
  delete: [
    { flag: '--id <INBOX_ID>', desc: 'Inbox id (a UUID, from `palmyr email list`) to delete (required; positional also accepted)', hint: 'inbound mail stops; reads 404; stored messages retained encrypted' },
    { flag: '(price)', desc: '$0.01 per call' },
    { flag: '(example)', desc: 'palmyr email delete --id 8b6cf4a2-91d3-4f0e-b2a7-3c5d1e9f6a04' },
  ],
}

const COMPUTE_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  plans: [
    { flag: '--location <loc>', desc: 'Filter to types deployable in this datacenter (optional)', hint: 'e.g. fsn1, nbg1, hel1, ash, hil' },
    { flag: '(price)', desc: 'Free — live discovery from Hetzner' },
    { flag: '(example)', desc: 'palmyr compute plans --location fsn1 --json' },
  ],
  locations: [
    { flag: '(no args)', desc: 'List Hetzner datacenters + per-location server-type availability' },
    { flag: '(price)', desc: 'Free' },
  ],
  'install-recipes': [
    { flag: '(no args)', desc: 'List available agent install recipes (hermes, openclaw, …)' },
    { flag: '(price)', desc: 'Free' },
  ],
  renew: [
    { flag: '<name|id>', desc: 'Buy another billing period for a server' },
    { flag: '(effect)', desc: 'Extends paid-through; powers the box back on if it was idled for non-payment' },
    { flag: '(price)', desc: "Same as deploy for that server type — see 'palmyr compute plans'" },
    { flag: '(example)', desc: 'palmyr compute renew my-agent-box' },
  ],
  restore: [
    { flag: '<id>', desc: 'Rebuild a server destroyed for non-payment, from its termination snapshot' },
    { flag: '(effect)', desc: 'Creates a NEW server id and IP; the snapshot is kept 30 days after termination' },
    { flag: '(price)', desc: 'Same as deploy for that server type' },
    { flag: '(example)', desc: 'palmyr compute restore 165115762' },
  ],
  'ssh-key': [
    { flag: 'add <pubkey-file>', desc: 'Upload a key to Hetzner', hint: '[--name "label"]' },
    { flag: 'list', desc: 'List uploaded Hetzner SSH keys' },
    { flag: 'delete <id>', desc: 'Remove a Hetzner SSH key' },
    { flag: '(price)', desc: 'add $0.10 · list $0.01 · delete $0.01' },
  ],
  deploy: [
    { flag: '--type <name>', desc: 'Hetzner server type', hint: 'default cx23' },
    { flag: '--name <name>', desc: 'Server name', hint: 'default agent-<timestamp>' },
    { flag: '--location <loc>', desc: 'Hetzner datacenter (optional)', hint: 'e.g. fsn1, nbg1' },
    { flag: '--install <recipes>', desc: 'Comma-separated install recipes', hint: 'e.g. hermes,openclaw' },
    { flag: '--no-install', desc: 'Skip cloud-init entirely (vanilla Ubuntu)' },
    { flag: '--generate-ssh-key', desc: 'GOLDEN PATH (default): generate a fresh keypair locally' },
    { flag: '--pubkey-file <path>', desc: 'Use an existing public key from disk' },
    { flag: '--pubkey "ssh-..."', desc: 'Use an inline public key string' },
    { flag: '--ssh-key <id>', desc: 'Numeric Hetzner key id (already uploaded)' },
    { flag: '--no-wait', desc: 'Return immediately instead of waiting for SSH-ready' },
    { flag: '--wait-timeout <s>', desc: 'Override readiness timeout (30–900s)' },
    { flag: '(price)', desc: '$6.00 per deploy (Hetzner billing flows through)' },
    { flag: '(example)', desc: 'palmyr compute deploy --type cx23 --install hermes' },
  ],
  wait: [
    { flag: '<name|id>', desc: 'Server (positional, name or numeric id)' },
    { flag: '--install <recipes>', desc: 'Also gate on the install marker file (e.g. hermes)' },
    { flag: '--key <path>', desc: 'Path to the private key for SSH verification' },
    { flag: '--wait-timeout <s>', desc: 'Override readiness timeout (30–900s)' },
    { flag: '(price)', desc: '$0.01 per readiness poll (server status check)' },
    { flag: '(example)', desc: 'palmyr compute wait my-vps --install hermes' },
  ],
  ssh: [
    { flag: '<name|id>', desc: 'Server (positional)' },
    { flag: '(price)', desc: 'Free — local cache lookup only' },
    { flag: '(example)', desc: 'palmyr compute ssh my-vps' },
  ],
  exec: [
    { flag: '<name|id> -- <cmd> [args...]', desc: 'Run a one-shot command via Palmyr SSH bridge' },
    { flag: '--timeout <s>', desc: 'Command timeout (1–120s)' },
    { flag: '(price)', desc: '$0.05 per command' },
    { flag: '(example)', desc: 'palmyr compute exec my-vps -- systemctl status openclaw' },
  ],
  rename: [
    { flag: '<name|id> <new-name>', desc: 'Rename server (metadata-only, no reboot)' },
    { flag: '(price)', desc: '$0.01 per rename' },
  ],
  'reset-password': [
    { flag: '<name|id>', desc: 'Rotate the root password (Hetzner-side)' },
    { flag: '(price)', desc: '$0.10 per action' },
  ],
  console: [
    { flag: '<name|id>', desc: 'Get a noVNC console URL (break-glass)' },
    { flag: '(price)', desc: '$0.10 per action' },
  ],
  reboot: [
    { flag: '<name|id>', desc: 'Reboot the server' },
    { flag: '(price)', desc: '$0.10 per action' },
  ],
  'setup-ssh': [
    { flag: '--id <SERVER_ID>', desc: 'Server id (required; positional also accepted)' },
    { flag: '--pubkey-file <path>', desc: 'Public key file to inject' },
    { flag: '--pubkey "ssh-..."', desc: 'Inline public key string' },
    { flag: '(price)', desc: '$0.01 per call' },
    { flag: '(example)', desc: 'palmyr compute setup-ssh --id 12345 --pubkey-file ~/.ssh/id_ed25519.pub' },
  ],
  list: [
    { flag: '(no args)', desc: 'List your deployed servers' },
    { flag: '(price)', desc: '$0.01 per call' },
  ],
  delete: [
    { flag: '--id <SERVER_ID>', desc: 'Server id (required; positional also accepted)' },
    { flag: '--confirm', desc: 'Required — destroys the server + disk irreversibly' },
    { flag: '(price)', desc: '$0.10 per deletion (Hetzner billing stops on confirm)' },
  ],
  rebuild: [
    { flag: '<name|id>', desc: 'Re-image the server from a fresh OS image' },
    { flag: '--image <image>', desc: 'Optional image to rebuild from (default: same image)' },
    { flag: '--confirm', desc: 'Required — wipes ALL data on disk irreversibly' },
    { flag: '(price)', desc: '$0.10 per action' },
  ],
}

const DOMAIN_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  check: [
    { flag: '--name <domain>', desc: 'Domain or root name (positional also accepted)' },
    { flag: '(price)', desc: 'Free — availability lookup only' },
    { flag: '(example)', desc: 'palmyr domain check example.dev' },
  ],
  pricing: [
    { flag: '--name <root>', desc: 'Root name to price across TLDs (positional also accepted)' },
    { flag: '(price)', desc: 'Free' },
    { flag: '(example)', desc: 'palmyr domain pricing example' },
  ],
  buy: [
    { flag: '--name <domain>', desc: 'Fully-qualified domain (required, e.g. example.dev)' },
    { flag: '--no-wait', desc: 'Return the operation_id immediately instead of polling to completion' },
    { flag: '(async)', desc: 'Registration is async: returns an operation that is polled until active/failed (~5s cadence, ~120s cap). On timeout it stays pending server-side; re-check with the printed poll_url.' },
    { flag: '(price)', desc: 'Dynamic registrar cost × markup (charged via x402); each status poll costs 0.01 USDC' },
    { flag: '(example)', desc: 'palmyr domain buy --name example.dev' },
  ],
  list: [
    { flag: '(no args)', desc: 'List domains owned or shared with your wallet' },
    { flag: '(price)', desc: '$0.01 ownership-proof micro-payment' },
  ],
  dns: [
    { flag: '--name <domain>', desc: 'Domain to read or write DNS for (positional also accepted)' },
    { flag: 'set', desc: 'REPLACE every record: palmyr domain dns set --name X --records \'[{"type":"A","name":"@","value":"1.2.3.4"}]\'' },
    { flag: 'add', desc: 'Upsert ONE record, keeping the rest (read + write, so 2 payments)' },
    { flag: '--records <json>', desc: 'JSON array of {type,name,value,ttl?} — for set (whole zone) or add (several rows at once)' },
    { flag: '--type <T>', desc: 'A | AAAA | CNAME | MX | TXT | URL | URL301 — single-record form, with --value' },
    { flag: '--host <name>', desc: 'Record host for the single-record form: @ for the apex, www, mail, … (default @)' },
    { flag: '--value <v>', desc: 'Record target: an IP for A/AAAA, a hostname for CNAME/MX, text for TXT' },
    { flag: '--ttl <secs>', desc: 'Time to live, default 1800' },
    { flag: '(destructive)', desc: '`set` sends the complete zone — records you omit are DELETED, including MX rows your email depends on. `add` merges.' },
    { flag: '(price)', desc: '$0.01 ownership-proof micro-payment per call' },
    { flag: '(example)', desc: 'palmyr domain dns add --name example.dev --type A --host www --value 1.2.3.4' },
  ],
  'transfer-ownership': [
    { flag: '--name <domain>', desc: 'Domain to transfer (required)' },
    { flag: '--to <wallet>', desc: 'Recipient wallet address (required)' },
    { flag: '--confirm', desc: 'Required — you lose ownership irreversibly' },
    { flag: '(price)', desc: '$0.01 ownership-proof micro-payment' },
  ],
  share: [
    { flag: '--name <domain>', desc: 'Domain to share (required)' },
    { flag: '--with <wallet>', desc: 'Wallet to grant shared access (required)' },
    { flag: '(price)', desc: '$0.01 ownership-proof micro-payment' },
  ],
  unshare: [
    { flag: '--name <domain>', desc: 'Domain to revoke from (required)' },
    { flag: '--from <wallet>', desc: 'Wallet to revoke (required)' },
    { flag: '(price)', desc: '$0.01 ownership-proof micro-payment' },
  ],
}


const CARD_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  buy: [
    { flag: '--amount <usd>', desc: 'USD balance to load on the card ($5–$1000, whole cents; positional also accepted)' },
    { flag: '--no-wait', desc: 'Return the operation_id immediately instead of polling to completion' },
    { flag: '--no-details', desc: 'Skip the automatic card-details fetch after the card is ready' },
    { flag: '(async)', desc: 'Purchase is async: returns an operation polled until ready/failed (~3s cadence, free polls). Card is typically ready in ~10s.' },
    { flag: '(price)', desc: 'Dynamic: amount + fee (3% min $0.50) via x402; the details fetch afterwards costs 0.01 USDC' },
    { flag: '(card)', desc: 'USA prepaid Visa — US merchants only, non-reloadable, spend until depleted' },
    { flag: '(example)', desc: 'palmyr card buy --amount 20' },
  ],
  list: [
    { flag: '(no args)', desc: 'List cards owned by your wallet: status, last4, balance' },
    { flag: '(price)', desc: '$0.01 ownership-proof micro-payment' },
  ],
  get: [
    { flag: '--id <card_id>', desc: 'Card id from card buy (positional also accepted)' },
    { flag: '(price)', desc: '$0.01 ownership-proof micro-payment — returns full number / CVV / expiry (owner-only)' },
    { flag: '(example)', desc: 'palmyr card get --id 3f2a…' },
  ],
  refresh: [
    { flag: '--id <card_id>', desc: 'Card id to refresh (positional also accepted)' },
    { flag: '(price)', desc: '$0.01 — live balance + issuer transactions (issuer re-scrape limited to 1/5min per card)' },
  ],
}

const CHAT_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  run: [
    { flag: '"<intent>"', desc: 'Plain-string intent (positional or --intent)' },
    { flag: '--budget <USDC>', desc: 'Max spend cap (required, positive USDC)' },
    { flag: '--quality <q>', desc: 'Quality tier', hint: 'fast | cheap | best (default best)' },
    { flag: '--execute', desc: 'Auto-execute the plan once generated' },
    { flag: '--auto-approve-under <USDC>', desc: 'Skip approval prompts for steps cheaper than this' },
    { flag: '--max-usdc <USDC>', desc: 'Hard spend ceiling per payment; aborts before signing if exceeded (env: PALMYR_MAX_USDC)' },
    { flag: '--skip-balance-check', desc: 'Skip the USDC balance preflight (read before the orchestration fee is paid; plan totals are estimates — dynamically-priced steps can settle for less)' },
    { flag: '(price)', desc: '$0.10 orchestration fee + sum of per-step costs (capped by --budget)' },
    { flag: '(example)', desc: 'palmyr chat run "launch a sneaker brand" --budget 50' },
  ],
  resume: [
    { flag: '<session_id>', desc: 'Existing session id (positional)' },
    { flag: '"<follow-up>"', desc: 'Follow-up intent (positional remainder or --intent)' },
    { flag: '--approve', desc: 'Approve a previously-generated plan' },
    { flag: '--plan-id <id>', desc: 'Plan id to approve (pair with --approve)' },
    { flag: '--budget <USDC>', desc: 'Override session budget (default $20)' },
    { flag: '--execute', desc: 'Auto-execute the new plan' },
    { flag: '--skip-balance-check', desc: 'Skip the USDC balance preflight (see `chat run --help`)' },
    { flag: '(price)', desc: '$0.10 orchestration fee per new plan + per-step costs' },
    { flag: '(example)', desc: 'palmyr chat resume sess_abc "now post 3 videos"' },
  ],
  status: [
    { flag: '<session_id>', desc: 'Session id (positional)' },
    { flag: '(price)', desc: 'Free — session inspection' },
  ],
  cancel: [
    { flag: '<session_id>', desc: 'Session id (positional)' },
    { flag: '(price)', desc: 'Free — halts execution and refunds remaining escrow' },
  ],
  sessions: [
    { flag: '(no args)', desc: 'List your active i402 sessions' },
    { flag: '(price)', desc: 'Free' },
  ],
  capabilities: [
    { flag: '(no args)', desc: 'List canonical capability classes (e.g. web_search, mint_nft)' },
    { flag: '(price)', desc: 'Free' },
  ],
  providers: [
    { flag: '--capability <name>', desc: 'Filter providers by capability (optional)' },
    { flag: '(price)', desc: 'Free' },
    { flag: '(example)', desc: 'palmyr chat providers --capability web_search' },
  ],
}

// Help tables for the two social subsystems. Their presence is what gates
// `--help` from dispatching paid actions — see the `case 'twitter'` and
// `case 'tiktok'` blocks below. 1.8.3 had no entries here and the
// `case 'buy'` arm immediately called the $5 paid endpoint when a user
// (reasonably) ran `palmyr twitter buy --help`. Every entry below MUST
// flag the price for paid subcommands so future readers can scan it.
const TWITTER_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  import: [
    { flag: '<username>', desc: 'Twitter handle to import' },
    { flag: '--credentials-line "..."', desc: 'login:password:email:email_pw:totp_seed:ct0:auth_token format' },
    { flag: '--username --password ...', desc: 'Alternative: individual flags for each field' },
    { flag: '(price)', desc: 'Free — local vault only' },
  ],
  list: [
    { flag: '--local', desc: 'Skip server check; show only locally-vaulted accounts' },
    { flag: '(price)', desc: 'Free local listing + paid lookups when --local is omitted (~$0.001 to enumerate server-side access)' },
  ],
  info: [
    { flag: '<username>', desc: 'Account to inspect' },
    { flag: '(price)', desc: 'Free — local vault read' },
  ],
  rename: [
    { flag: '<old>', desc: 'Current local handle' },
    { flag: '--to <new>', desc: 'New handle (after a real-server rename)' },
    { flag: '(price)', desc: 'Free — local-only metadata update' },
  ],
  remove: [
    { flag: '<username>', desc: 'Account to remove' },
    { flag: '--confirm', desc: 'Required — local delete is irreversible' },
    { flag: '(price)', desc: 'Free — local vault only' },
  ],
  totp: [
    { flag: '<username>', desc: 'Account whose current TOTP code to print' },
    { flag: '(price)', desc: 'Free — local TOTP generation' },
  ],
  buy: [
    { flag: '(no args)', desc: 'Purchase the oldest ready X account from the supplier pool. Default for every filter below is random.' },
    { flag: '--country <CC>', desc: 'Filter by RESIDENCY (X about_profile.account_based_in). ISO alpha-2 — US, GB, DE, …. Run `pool-prices` to see what is priced.' },
    { flag: '--registered-country <CC>', desc: 'Filter by REGISTRATION country — where the X account was created from (parsed from X "Connected via" string). May differ from --country.' },
    { flag: '--platform android|ios|web', desc: 'Filter by registration platform (also parsed from X "Connected via" string).' },
    { flag: '--max-renames N', desc: 'Cap username-change count. --max-renames 0 = never renamed. Rows with unknown rename count do not match.' },
    { flag: '--source "raw string"', desc: 'Power-user: exact-match against the lowercased raw "Connected via" string. Used for fine-grained source_multiplier pricing.' },
    { flag: '--age 1y|2y|...', desc: 'Optional age category filter' },
    { flag: '(price)', desc: '$5 USDC default; country_price * source_multiplier when filters are passed.' },
    { flag: '(example)', desc: 'palmyr twitter buy --country GB --registered-country GB --platform android --max-renames 0' },
  ],
  login: [
    { flag: '<username>', desc: 'Force a fresh server-side session (browser runtime)' },
    { flag: '(price)', desc: '$0.005 USDC' },
  ],
  'manual-login': [
    { flag: '<username>', desc: 'Open a remote browser session you sign in to manually' },
    { flag: '(price)', desc: 'Variable — server-side browser session cost' },
  ],
  session: [
    { flag: '<username>', desc: 'Inspect cached server-side session status' },
    { flag: '(price)', desc: 'Free' },
  ],
  post: [
    { flag: '<username>', desc: 'Account to post from' },
    { flag: '--body "..."', desc: 'Tweet body (required)' },
    { flag: '(price)', desc: '$0.001 USDC per post' },
  ],
  reply: [
    { flag: '<username>', desc: 'Account to reply from' },
    { flag: '--to <url>', desc: 'Tweet URL to reply to' },
    { flag: '--body "..."', desc: 'Reply body' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  like: [
    { flag: '<username>', desc: 'Account doing the like' },
    { flag: '--tweet <url>', desc: 'Tweet to like' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  retweet: [
    { flag: '<username>', desc: 'Account doing the retweet' },
    { flag: '--tweet <url>', desc: 'Tweet to retweet' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  follow: [
    { flag: '<username>', desc: 'Account doing the follow' },
    { flag: '--user @handle', desc: 'User to follow' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  unfollow: [
    { flag: '<username>', desc: 'Account doing the unfollow' },
    { flag: '--user @handle', desc: 'User to unfollow' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  delete: [
    { flag: '<username>', desc: 'Account that posted the tweet' },
    { flag: '--tweet <url>', desc: 'Tweet to delete' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  'list-tweets': [
    { flag: '<username>', desc: 'Account whose timeline to fetch' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  bio: [
    { flag: '<username>', desc: 'Account whose bio to update' },
    { flag: '--text "..."', desc: 'New bio (<=160 chars)' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  name: [
    { flag: '<username>', desc: 'Account whose display name to update' },
    { flag: '--display "..."', desc: 'New display name' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  location: [
    { flag: '<username>', desc: 'Account whose location to update' },
    { flag: '--location "..."', desc: 'New location string' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  website: [
    { flag: '<username>', desc: 'Account whose profile website to update' },
    { flag: '--url https://...', desc: 'New website URL' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  pfp: [
    { flag: '<username>', desc: 'Account whose avatar to update' },
    { flag: '--file pic.png', desc: 'Image file (jpeg / png)' },
    { flag: '(price)', desc: '$0.005 USDC' },
  ],
  banner: [
    { flag: '<username>', desc: 'Account whose banner to update' },
    { flag: '--file banner.png', desc: 'Image file' },
    { flag: '(price)', desc: '$0.005 USDC' },
  ],
  username: [
    { flag: '<username>', desc: 'Current account handle' },
    { flag: '--to <new>', desc: 'New handle' },
    { flag: '(price)', desc: '$0.005 USDC' },
  ],
  transfer: [
    { flag: '<username>', desc: 'Account to transfer' },
    { flag: '--to <wallet>', desc: 'Destination wallet address' },
    { flag: '--confirm', desc: 'Required — rotates password, revokes other sessions' },
    { flag: '(price)', desc: 'Free for vaulted accounts; ~$0.01 USDC to auto-register an imported-only account first' },
  ],
  share: [
    { flag: '<username>', desc: 'Account to share' },
    { flag: '--with <wallet>', desc: 'Wallet to grant access to' },
    { flag: '(price)', desc: 'Free for shared access (no password rotation)' },
  ],
  unshare: [
    { flag: '<username>', desc: 'Account to revoke share on' },
    { flag: '--from <wallet>', desc: 'Wallet to revoke' },
    { flag: '--rotate', desc: 'Also rotate password so cached cookies stop working' },
    { flag: '(price)', desc: 'Free; --rotate runs async like transfer (~30-90s)' },
  ],
  claim: [
    { flag: '(no args)', desc: 'Pull every server-side X account the wallet can access into the local vault' },
    { flag: '(price)', desc: '~$0.001 USDC per account claimed (creds-decryption fee)' },
  ],
  // Server-backed account registration. Without these entries, `palmyr twitter
  // register --help` (and friends) fell through to the top-level menu instead
  // of explaining their flags. Subcommands listed in the parent switch must
  // always have an entry here so the help guard fires before the case body.
  thread: [
    { flag: '<username>', desc: 'Account to post the thread from' },
    { flag: '--texts \'["...","..."]\'', desc: 'JSON array of tweets (in order)' },
    { flag: '--file path.json', desc: 'Alternative: read the JSON array from a file' },
    { flag: '(price)', desc: '$0.005 USDC' },
  ],
  register: [
    { flag: '<username>', desc: 'Account handle' },
    { flag: '--password <pw>', desc: 'Required if the account is not already in the local vault' },
    { flag: '--login --email --totp-seed --auth-token --ct0', desc: 'Optional; auto-pulled from local vault when not passed' },
    { flag: '--country <CC>', desc: 'Optional residency hint stored alongside the encrypted credentials' },
    { flag: '(price)', desc: 'Free — server tests login + encrypts creds at rest. Enables scheduling.' },
  ],
  unregister: [
    { flag: '<username-or-id>', desc: 'Handle or 32-char hex account id' },
    { flag: '(price)', desc: 'Free — wipes server-side credentials, account no longer schedulable' },
  ],
  registered: [
    { flag: '(no args)', desc: 'List every server-registered X account this wallet owns' },
    { flag: '(price)', desc: 'Free' },
  ],
  schedule: [
    { flag: '<username>', desc: 'Account to post from (must be `register`-ed)' },
    { flag: '--at "ISO8601"', desc: 'When to fire (e.g. --at "2026-05-15T14:00:00Z")' },
    { flag: '--body "..."', desc: 'Text-only post' },
    { flag: '--texts \'["..."]\' / --file path.json', desc: 'Thread' },
    { flag: '--image / --video / --media-json', desc: 'Media attachments' },
    { flag: '--community <id>', desc: 'Post into an X Community' },
    { flag: '(price)', desc: '$0.001 USDC (text) or $0.005 USDC (thread / media) — paid up front' },
  ],
  queue: [
    { flag: '--status pending|in_progress|completed|failed|cancelled', desc: 'Filter by status' },
    { flag: '--from / --to "ISO8601"', desc: 'Filter by post-at window' },
    { flag: '--account-id <id>', desc: 'Filter to one account' },
    { flag: '--limit <n>', desc: 'Cap result count' },
    { flag: '(price)', desc: 'Free' },
  ],
  cancel: [
    { flag: '<schedule-id>', desc: 'Id from `palmyr twitter queue`' },
    { flag: '(price)', desc: 'Free — only cancels pending posts; in-flight ones are already settled' },
  ],
  status: [
    { flag: '<username>', desc: 'Account to inspect' },
    { flag: '(price)', desc: 'Server-side liveness/shadow-ban check (not yet wired — see `palmyr twitter session` for cached login state)' },
  ],
  'pool-add': [
    { flag: '--credentials-line "..."', desc: 'Single account creds (login:pw:email:email_pw[:2fa[:ct0:auth_token]])' },
    { flag: '--file path.txt', desc: 'Bulk: one credentials-line per row (# = comment)' },
    { flag: '--price <USDC>', desc: 'Required — per-account sale_price_usdc (legacy fallback when no country price row exists)' },
    { flag: '--country <CC>', desc: 'Optional override; twitterapi.io detects country + source + rename count from about_profile at seed time. Admin wins on country mismatch (flagged in response).' },
    { flag: '--age 1y|2y|3y|...', desc: 'Optional age category metadata' },
    { flag: '(auth)', desc: 'Admin-signed call — requires PALMYR_ADMIN_KEY' },
    { flag: '(price)', desc: 'Free — server-side seeding by pool operator' },
  ],
  'pool-prices': [
    { flag: '(no args)', desc: 'List per-country prices set by the pool admin (public, free).' },
    { flag: '(price)', desc: 'Free' },
  ],
  'pool-set-price': [
    { flag: '--country <CC>', desc: 'ISO 3166-1 alpha-2 country code (US, GB, DE, …)' },
    { flag: '--price <USDC>', desc: 'USDC amount the `buy --country <CC>` route will charge' },
    { flag: '(auth)', desc: 'Admin-signed call — requires PALMYR_ADMIN_KEY' },
    { flag: '(price)', desc: 'Free' },
  ],
  'pool-delete-price': [
    { flag: '--country <CC>', desc: 'Country code to remove pricing for' },
    { flag: '(auth)', desc: 'Admin-signed call — requires PALMYR_ADMIN_KEY' },
    { flag: '(price)', desc: 'Free' },
  ],
  'pool-set-source-multiplier': [
    { flag: '--source web|mobile|<id>', desc: 'Source identifier (matches the `source` column populated by twitterapi.io)' },
    { flag: '--multiplier <number>', desc: 'Positive scaling factor applied on top of country price when --source is passed at buy time. 1.0 = no change.' },
    { flag: '(auth)', desc: 'Admin-signed call — requires PALMYR_ADMIN_KEY' },
    { flag: '(price)', desc: 'Free' },
  ],
  'pool-delete-source-multiplier': [
    { flag: '--source <id>', desc: 'Source identifier to remove the multiplier for (buy still works, just reverts to multiplier=1.0)' },
    { flag: '(auth)', desc: 'Admin-signed call — requires PALMYR_ADMIN_KEY' },
    { flag: '(price)', desc: 'Free' },
  ],
  dispute: [
    { flag: '<account_id>', desc: 'Account id returned by `twitter buy` (the 32-char hex)' },
    { flag: '--reason suspended|other', desc: 'Default "suspended" — triggers auto-verify via twitterapi.io' },
    { flag: '--evidence "..."', desc: 'Optional note shown to the admin if the dispute ends up in admin_review' },
    { flag: '(price)', desc: '$0.01 USDC ownership-proof. 7-day window from purchase.' },
    { flag: '(example)', desc: 'palmyr twitter dispute abcd1234… --reason suspended' },
  ],
  disputes: [
    { flag: '<dispute_id>', desc: 'Look up the status of a previously filed dispute' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  'pool-disputes': [
    { flag: '(no args)', desc: 'List every dispute in the system (admin)' },
    { flag: '--status admin_review|pending|replaced|refunded|rejected', desc: 'Filter by status' },
    { flag: '(auth)', desc: 'Admin-signed call — requires PALMYR_ADMIN_KEY' },
    { flag: '(price)', desc: 'Free' },
  ],
  'pool-resolve-dispute': [
    { flag: '<dispute_id>', desc: 'Id from `pool-disputes`' },
    { flag: '--action replace|refund|reject', desc: 'replace = grant same-country swap; refund = USDC back to payer; reject = decline' },
    { flag: '--note "..."', desc: 'Optional admin note appended to the resolution' },
    { flag: '(auth)', desc: 'Admin-signed call — requires PALMYR_ADMIN_KEY' },
    { flag: '(price)', desc: 'Free' },
  ],
  'pool-status': [
    { flag: '(no args)', desc: 'Available / sold / reserved counts in the X account pool' },
    { flag: '(auth)', desc: 'Admin-signed call — requires PALMYR_ADMIN_KEY' },
    { flag: '(price)', desc: 'Free' },
  ],
}

const TIKTOK_HELP: Record<string, Array<{ flag: string; desc: string; hint?: string }>> = {
  import: [
    { flag: '<username>', desc: 'TikTok handle to import' },
    { flag: '--sessionid <s> --csrf <c> --webid <w>', desc: 'Cookies from a logged-in TikTok browser' },
    { flag: '--credentials-line "..."', desc: 'Marketplace login:pw:email:email_pw format' },
    { flag: '--tag <name>', desc: 'Assign a folder-like grouping tag at import' },
    { flag: '(price)', desc: 'Free — local vault only' },
  ],
  connect: [
    { flag: '<username>', desc: 'Default: prints a /connect link (qr_link) the human opens and scans with the TikTok app on their phone. Needs a local Chrome/Edge/Brave on this machine to host the login.' },
    { flag: '--server', desc: 'RECOMMENDED. Log in on the server, inside the account\'s own persistent browser profile, so the browser that authenticates is the one that later posts. No cookies are transferred and no device/IP mismatch is baked in at login. Costs $0.01; needs no local browser.' },
    { flag: '--local', desc: 'Open the browser on THIS machine and log in here yourself (a desktop with a human present).' },
    { flag: '--country <iso-2>', desc: 'Optional — auto-detected from your browser; override e.g. --country de' },
    { flag: '--timeout <sec>', desc: 'How long to wait for login (default 300)' },
    { flag: '--browser-path <path>', desc: 'Override Chrome/Edge/Brave auto-detection' },
    { flag: '--no-sandbox', desc: 'Launch without the browser sandbox (auto on root Linux; for headless/CI)' },
    { flag: '--force', desc: 'Re-capture even if a fresh session is already cached' },
    { flag: '--tag <name>', desc: 'Save under a folder-like grouping tag (organize many accounts)' },
    { flag: '(price)', desc: 'Free — local, no server call' },
  ],
  list: [
    { flag: '(no args)', desc: 'List all local TikTok accounts (free, reads the local vault only)' },
    { flag: '--server', desc: 'List what your wallet owns SERVER-SIDE, with session health (status, whether the browser profile is still present, hours since the last successful op). $0.001 — the payment is what identifies you. Accounts connected with `connect --server` exist only here, never in the local vault.' },
    { flag: '--tag <name>', desc: 'Filter to accounts in this folder/tag (works for both)' },
    { flag: '(price)', desc: 'Free locally; $0.001 with --server' },
  ],
  info: [{ flag: '<username>', desc: 'Show one account' }, { flag: '(price)', desc: 'Free' }],
  rename: [
    { flag: '<old>', desc: 'Current local handle' },
    { flag: '--to <new>', desc: 'New handle' },
    { flag: '(price)', desc: 'Free — local-only metadata update' },
  ],
  tag: [
    { flag: '<username>', desc: 'Account to tag' },
    { flag: '<tag-name>', desc: 'Folder name (positional) to assign' },
    { flag: '--clear', desc: "Remove the account's tag instead" },
    { flag: '(price)', desc: 'Free — local-only metadata' },
  ],
  remove: [
    { flag: '<username>', desc: 'Account to delete from local vault' },
    { flag: '--confirm', desc: 'Required' },
    { flag: '(price)', desc: 'Free' },
  ],
  totp: [{ flag: '<username>', desc: 'Print current TOTP code' }, { flag: '(price)', desc: 'Free' }],
  login: [
    { flag: '<username>', desc: 'Validate cookies and cache the session' },
    { flag: '(price)', desc: '$0.02 USDC' },
  ],
  session: [{ flag: '<username>', desc: 'Check cached session' }, { flag: '(price)', desc: 'Free' }],
  push: [
    { flag: '<username>', desc: "Stash THIS machine's cached session under a one-time transfer code (~30 min), to hand it to the machine that runs the ops" },
    { flag: '(price)', desc: 'Free' },
  ],
  pull: [
    { flag: '<username>', desc: "Redeem a transfer code into THIS machine's vault (creates the account locally if it isn't there yet)" },
    { flag: '--code <transfer-code>', desc: 'Code printed by `push` on the source machine — one-time, ~30 min' },
    { flag: '--country <iso-2>', desc: 'Country to record when the account is created here' },
    { flag: '--tag <name>', desc: 'Save under a folder-like grouping tag' },
    { flag: '(price)', desc: 'Free' },
  ],
  post: [
    { flag: '<username>', desc: 'Account to post from' },
    { flag: '--file video.mp4', desc: 'Video file' },
    { flag: '--caption "..."', desc: 'Caption' },
    { flag: '--privacy 0|1|2', desc: 'Audience: 0 public (default) · 1 friends · 2 private' },
    { flag: '(price)', desc: '$0.01 USDC' },
  ],
  schedule: [
    { flag: '<username>', desc: 'Account to post from' },
    { flag: '--at <iso8601>', desc: 'When TikTok publishes it — ~15 min to ~10 days out' },
    { flag: '--file video.mp4 | --url <https>', desc: 'Video' },
    { flag: '--caption "..."', desc: 'Caption' },
    { flag: '(price)', desc: "Same as post — uses TikTok's own scheduler" },
  ],
  follow: [
    { flag: '<username>', desc: 'Account doing the follow' },
    { flag: '--user @handle', desc: 'User to follow' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  like: [
    { flag: '<username>', desc: 'Account doing the like' },
    { flag: '--video <url>', desc: 'Video URL to like' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  delete: [
    { flag: '<username>', desc: 'Account that posted the video' },
    { flag: '--video <url>', desc: 'Video to delete' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  bio: [
    { flag: '<username>', desc: 'Account whose bio to update' },
    { flag: '--text "..."', desc: 'New bio (<=80 chars)' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  name: [
    { flag: '<username>', desc: 'Account whose display name to update' },
    { flag: '--display "..."', desc: 'New display name (<=30 chars)' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  pfp: [
    { flag: '<username>', desc: 'Account whose avatar to update' },
    { flag: '--file pic.png', desc: 'Image file' },
    { flag: '(price)', desc: '$0.005 USDC' },
  ],
  draft: [
    { flag: '<username>', desc: 'Account to post from' },
    { flag: '--file video.mp4 | --url <https>', desc: 'Video' },
    { flag: '--caption "..."', desc: 'Caption' },
    { flag: '--privacy 0|1|2', desc: 'Audience: 0 public (default) · 1 friends · 2 private' },
    { flag: '--at <iso8601>', desc: 'Optional — schedule on approval instead of posting now' },
    { flag: '(price)', desc: 'Free — queues for approval; you pay on approve' },
  ],
  drafts: [
    { flag: '[<username>]', desc: 'List drafts awaiting approval (optionally for one account)' },
    { flag: '--tag <name>', desc: 'Filter by folder/tag' },
    { flag: '(price)', desc: 'Free' },
  ],
  approve: [
    { flag: '<draft-id>', desc: 'Publish the queued draft + write it to the post log' },
    { flag: '(price)', desc: "Same as post — $0.01 (a scheduled draft uses TikTok's scheduler)" },
  ],
  reject: [
    { flag: '<draft-id>', desc: 'Discard a queued draft' },
    { flag: '(price)', desc: 'Free' },
  ],
  logs: [
    { flag: '[<username>]', desc: 'Recent posts (audit log) — approved drafts + direct posts' },
    { flag: '--tag <name>', desc: 'Filter by folder/tag' },
    { flag: '--limit <N>', desc: 'How many to show (default 20)' },
    { flag: '(price)', desc: 'Free' },
  ],
  analytics: [
    { flag: '<username>', desc: 'Scrape per-post views/likes/comments, categorize into tiers, snapshot the time-series' },
    { flag: '(price)', desc: '$0.005 USDC (free in self-hosted mode)' },
  ],
  review: [
    { flag: '<username>', desc: 'Performance review — best/worst, tier mix, engagement, trend vs last snapshot' },
    { flag: '(price)', desc: 'Free — reads the local snapshot store' },
  ],
  scheduled: [
    { flag: '[<account>]', desc: "Posts you have queued — Palmyr's record; TikTok can't be asked what's pending" },
    { flag: '--all', desc: 'Include cancelled and already-published ones' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  cancel: [
    { flag: '<operation-id>', desc: 'Cancel a scheduled post by deleting the held video (TikTok has no unschedule)' },
    { flag: '--account <user>', desc: 'Account the post belongs to' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  hooks: [
    { flag: '<username> | --tag <niche>', desc: "Which caption openings earn views, vs this account's OWN median" },
    { flag: '--caption "..."', desc: 'Classify a draft opening before posting, with what your history says about it' },
    { flag: '--maturity-days <n>', desc: 'Only judge posts older than n days (default 7 — younger ones are still distributing)' },
    { flag: '--niche <niche>', desc: "What's working in a niche across TikTok (no account history needed — the day-one answer). $0.05 — the answer is backed by a paid upstream collection, amortised across everyone who asks for that niche." },
    { flag: '--recency-days <n>', desc: 'Only judge posts NEWER than n days (default 90 — hooks decay, so old wins are not evidence about now)' },
    { flag: '(price)', desc: '$0.001 USDC against your own accounts; $0.05 with --niche' },
  ],
  corpus: [
    { flag: 'niches', desc: 'List the niches — the same set `hooks --niche` resolves against' },
    { flag: 'refresh <niche>', desc: 'Collect that niche from TikTok now and upload it. Operator pre-warm only: the server refreshes a stale niche by itself, so this exists to fill niches ahead of demand — and to collect at all on a deployment with no server payer wallet. Also accepts --niche <niche> instead of the positional.' },
    { flag: '--depth <n>', desc: "How many of the niche's queries to run (default 4) — one paid upstream search each" },
    { flag: '(auth)', desc: '`refresh` uploads admin-signed — requires an admin wallet (PALMYR_POOL_ADMIN_WALLET)' },
    { flag: '(price)', desc: 'Free for `niches`; `refresh` spends ~$0.06 per query from your own wallet (~$0.24 at the default --depth 4)' },
  ],
  series: [
    { flag: '<username>', desc: "Per-post engagement history the SERVER stored — survives this machine" },
    { flag: '--video <id>', desc: 'Full time-series for one video instead of the latest per video' },
    { flag: '--hours <n>', desc: 'Per-video growth over the last n hours' },
    { flag: '(price)', desc: '$0.001 USDC' },
  ],
  monitor: [
    { flag: 'tick | start | stop | status', desc: 'Unattended analytics loop (self-learning)' },
    { flag: '--every <6h|30m>', desc: 'Interval for `start` (default 6h)' },
    { flag: '--account a,b', desc: 'Limit to specific accounts (default: all connected)' },
    { flag: '(price)', desc: 'Free locally; each tick runs `analytics`' },
  ],
}

// ─── Strict unknown-flag guard ───
//
// A typo like `--dubject` used to fall through the parser silently and
// resurface as a confusing "missing required flag" error. Before dispatch,
// main() checks every `--flag` on the argv against the resolved command's
// allowlist and fails fast with the valid options (see rejectUnknownFlags).
//
// A command's allowlist is the union of:
//   - every `--flag` mentioned anywhere in its help table (all subcommands,
//     descriptions and hints included — deliberately lenient so documented
//     aliases and grouped case-arms never false-positive on a valid flag)
//   - EXTRA_FLAGS: accepted-but-undocumented aliases found by auditing every
//     `flags.<x>` read in this file (e.g. phone share reads `--wallet` as an
//     alias for its documented `--with`)
//   - GLOBAL_FLAGS (--json, --help, --token, ...)
//
// Only commands keyed in EXTRA_FLAGS are validated — when adding a new
// command, add its key here (an empty array is fine) or it ships unguarded.
//
// Passthrough audit (nothing needs an exemption):
//   - `compute exec <id> -- <cmd> --any-flag`: everything after a bare `--`
//     is a positional by the time parse() returns, so the guard never sees
//     remote flags. The explicit form carries them inside `--command`/`--arg`
//     string values.
//   - templates (`wallet buy/cohort --template`): strategy fields come from
//     the YAML body, not argv flags.
//   - `chat run`: the intent is a positional/`--intent` string; flags are fixed.

const COMMAND_HELP_TABLES: Record<string, Record<string, Array<{ flag: string; desc: string; hint?: string }>>> = {
  phone: PHONE_HELP,
  email: EMAIL_HELP,
  compute: COMPUTE_HELP,
  card: CARD_HELP,
  domain: DOMAIN_HELP,
  wallet: WALLET_HELP,
  chat: CHAT_HELP,
  twitter: TWITTER_HELP,
  tiktok: TIKTOK_HELP,
}

const EXTRA_FLAGS: Record<string, string[]> = {
  setup: ['keyfile', 'chain'],
  status: [],
  note: [],
  worker: [],
  telemetry: [],
  config: [],
  doctor: [],
  pricing: [],
  health: [],
  email: [],
  card: [],
  phone: ['message'], // sms-status alias for --id
  domain: ['wallet'], // unshare alias for --from
  chat: ['auto-execute'], // alias for --execute
  compute: [
    'id', 'name', // every server-targeting subcommand accepts these next to the positional
    'file', 'label', // ssh-key add aliases
    'generate', 'publicKey', 'ssh-key-file', 'key-path', 'private-key', 'progress', // deploy/wait/setup-ssh key plumbing
    'identity', // ssh alias for --key
    'to', 'new-name', // rename aliases
    'command', 'arg', // exec explicit (non `--`) form
  ],
  wallet: [
    'managed', // create: web-passkey managed wallet flow
    'label', // create/import alias for --name
    'message', // sign-message alias for --msg
    'webhook', // register alias for --webhook-url
    'per-tx', // request-approval alias for --tx
    'take-profit', // buy/cohort alias for --tp
    'progress', // buy/sell/cohort inline progress toggle
    'history', // positions: include closed
    'budget', // live-test spend cap
  ],
  twitter: [
    'email-password', 'emailpw', 'totp', 'authtoken', 'recovery-codes', 'profile-url', // import field aliases
    'id', // schedule cancel / dispute / unregister accept --id
    'path', // post/thread/pfp/banner media alias for --file
    'community-id', // post/schedule alias for --community
    'target', // follow/unfollow alias for --user
    'name', // display-name alias for --display
    'wait', // --no-wait on banner/pfp media ops
    'age-category', 'batch', // pool buy/add filters
    'wallet', // share/unshare alias
  ],
  tiktok: [
    'username', 'login', 'password', 'email', 'email-password', 'emailpw', 'tt-csrf', 'tt-webid',
    'totp-seed', 'totp', 'profile-url', 'force-email', // import field aliases
    'code', 'transfer', // pull hand-off code alias
    'body', 'path', 'when', // draft/post aliases for --caption/--file/--at
    'id', // draft approve/reject accept --id
    'interval', // monitor alias for --every
    'target', 'name', // follow/profile aliases
    'wait', // --no-wait on media ops
    'qr', // connect: explicit form of the default QR hand-off mode (--local is the alternative)
  ],
}

/**
 * Fail fast (exit 2) when the argv carries a `--flag` the resolved command
 * doesn't know. Skipped for unknown commands (the dispatcher's default case
 * owns that error) and when --help is present (help beats strictness).
 */
function rejectUnknownFlags(command: string, subcommand: string, flagKeys: string[]) {
  const extras = EXTRA_FLAGS[command]
  if (extras === undefined) return // unregistered command → `Unknown command` path
  const table = COMMAND_HELP_TABLES[command]
  const allowed = flagNamesFromTable(table)
  for (const f of GLOBAL_FLAG_NAMES) allowed.add(f)
  for (const f of extras) allowed.add(f.toLowerCase())
  const unknown = findUnknownFlags(flagKeys, allowed)
  if (unknown.length === 0) return
  // List the resolved subcommand's documented flags when we have them — the
  // command-wide union is a typo net, not a schema, and can be huge.
  const scoped = table?.[subcommand]
  const valid = [...(scoped ? flagNamesFromTable({ [subcommand]: scoped }) : allowed)]
    .filter((f) => !GLOBAL_FLAG_NAMES.includes(f))
    .sort()
  const where = scoped ? `palmyr ${command} ${subcommand}` : `palmyr ${command}`
  const validStr = valid.length
    ? valid.map((f) => `--${f}`).join(', ')
    : '(none — global flags like --json/--help only)'
  err(
    `Unknown flag: --${unknown[0]}. Valid flags for \`${where}\`: ${validStr}`,
    EXIT.BAD_INPUT,
    {
      unknownFlags: unknown.map((f) => `--${f}`),
      validFlags: valid.map((f) => `--${f}`),
      hint: `Run: palmyr ${command} ${scoped ? `${subcommand} ` : ''}--help`,
    },
  )
}

/**
 * Render a per-command menu (no subcommand given). On a TTY → Ink MenuScreen
 * with the Palmyr aesthetic. In agent mode → flat JSON listing the available
 * subcommands so an agent can drive discovery (e.g. `palmyr phone --json`
 * → `{"command":"phone","subcommands":[{"name":"search",...}, ...]}`).
 */
function showMenu(opts: {
  command: string
  title: string
  subtitle: string
  footerLeft: string
  commands: Array<{ name: string; description: string; hint?: string }>
  fromHome: boolean
}) {
  if (AGENT_MODE) {
    print({ command: opts.command, subcommands: opts.commands })
    return
  }
  render(React.createElement(MenuScreen, {
    version: VERSION,
    title: opts.title,
    subtitle: opts.subtitle,
    footerLeft: opts.footerLeft,
    commands: opts.commands,
    interactive: opts.fromHome,
    onBack: opts.fromHome ? () => {
      process.env.PALMYR_FROM_HOME = '0'
      process.argv = [process.argv[0], process.argv[1]]
      void main()
    } : undefined,
  }))
}

function print(obj: any) {
  const json = JSON.stringify(obj, null, 2)
  // Plain JSON in agent mode (stdout is piped, --json is set, or PALMYR_JSON
  // env is on). On a real TTY without --json, color the keys so humans get a
  // little visual aid — but the structure is still valid JSON either way.
  if (AGENT_MODE) {
    console.log(json)
  } else {
    const colored = json
      .replace(/"([^"]+)":/g, `${t.info}"$1"${t.reset}:`)
      .replace(/: "([^"]+)"/g, `: ${t.success}"$1"${t.reset}`)
      .replace(/: (\d+)/g, `: ${t.warn}$1${t.reset}`)
      .replace(/: (true|false)/g, `: ${t.accent}$1${t.reset}`)
      .replace(/: (null)/g, `: ${t.muted}$1${t.reset}`)
    console.log(colored)
  }
}

/**
 * Compact formatter for chat-run step outputs in the summary line. Picks the
 * most-useful 2-4 fields per step (id, address, status flags) without dumping
 * the entire JSON. Falls back to the full object for unknown shapes.
 */
/**
 * Trim long upstream errors (HTML pages, multi-paragraph stack traces) down
 * to a one-liner the terminal can display without scrolling. Strips HTML
 * tags, collapses whitespace, and clips to ~200 chars with a length hint.
 */
function truncateError(msg: string, max: number = 200): string {
  if (!msg) return '(no error message)'
  const stripped = msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (stripped.length <= max) return stripped
  return `${stripped.slice(0, max)}… [+${stripped.length - max} chars; rerun with --verbose for full body]`
}

function formatStepOutput(output: any): string {
  if (output == null) return '—'
  if (typeof output !== 'object') return String(output)
  // Common shapes we want a clean one-liner for.
  if (output.inbox?.address) {
    const i = output.inbox
    const flags: string[] = []
    if (output.dnsApplied === true) flags.push('dns ✓')
    if (output.mailgunRegistered === true) flags.push(`mailgun=${output.mailgunStatus ?? 'pending'}`)
    if (output.sendingStatus) flags.push(`send: ${output.sendingStatus.split(/ [—-] /)[0]}`)
    return `${i.address} (id ${i.id})${flags.length ? '  ' + flags.join('  ') : ''}`
  }
  if (Array.isArray(output.inboxes)) return `${output.inboxes.length} inbox(es)`
  if (Array.isArray(output.numbers)) return `${output.numbers.length} number(s)`
  if (Array.isArray(output.servers)) return `${output.servers.length} server(s)`
  if (Array.isArray(output.domains)) return `${output.domains.length} domain(s)`
  if (Array.isArray(output.calls)) return `${output.calls.length} call(s)`
  if (Array.isArray(output.sshKeys)) return `${output.sshKeys.length} ssh key(s)`
  // Pull the most-useful keys for unknown single-object shapes.
  const keys = ['id', 'address', 'phoneNumber', 'callControlId', 'serverId', 'ipv4', 'domain', 'status', 'message']
  const parts: string[] = []
  for (const k of keys) {
    const v = output[k]
    if (v !== undefined && v !== null) parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    if (parts.length >= 4) break
  }
  return parts.length ? parts.join('  ') : JSON.stringify(output).slice(0, 200)
}

// ── Clean `chat run` rendering helpers (dead-simple TTY output) ──

// "~45s" / "~3 min" from an ETA in seconds.
function humanEta(sec?: number): string {
  if (!sec || sec <= 0) return '?'
  return sec < 90 ? `~${Math.round(sec)}s` : `~${Math.round(sec / 60)} min`
}

// A card's billing address on one line, for the checkouts that ask for one.
// The billing name is always the issuer's, never the buyer's.
function billingLine(b: any): string {
  if (!b) return ''
  const street = [b.line_1, b.line_2].filter(Boolean).join(' ')
  return [b.name, street, [b.city, b.state, b.zip].filter(Boolean).join(', '), b.country]
    .filter(Boolean)
    .join(' · ')
}

// "18s" / "2m 14s" from a duration in ms.
function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// The single most-useful value from a step output — the one token a human
// wants to see (the domain, the IP, the inbox address, the handle…).
function shortResult(o: any): string {
  if (o == null) return ''
  if (typeof o !== 'object') return String(o)
  if (o.inbox?.address) return String(o.inbox.address)
  const cands = [o.domain, o.address, o.ipv4, o.phoneNumber, o.handle, o.username, o.url, o.tweet_url, o.server?.ipv4, o.server?.id, o.id]
  for (const v of cands) if (v != null && typeof v !== 'object') return String(v)
  if (Array.isArray(o.numbers) && o.numbers[0]?.phoneNumber) return String(o.numbers[0].phoneNumber)
  if (Array.isArray(o.inboxes)) return `${o.inboxes.length} inbox(es)`
  return ''
}

// Human label for a plan step — the planner's description, else a tidy capability.
function stepLabel(s: any): string {
  const d = (s?.description || '').trim()
  return d || String(s?.capability || 'step').replace(/_/g, ' ')
}

// Left-pad to a column without letting long labels blow out the price alignment.
function padLabel(s: string, w = 38): string {
  return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w)
}

// Single source of truth for the top-level command catalog. Used by both the
// Ink help screen and the JSON path so agents and humans see the same surface.
const TOP_LEVEL_COMMANDS: Array<{ name: string; description: string }> = [
  { name: 'chat', description: 'i402 intent layer: describe an outcome, pay USDC, get a plan (run · resume · status · sessions)' },
  { name: 'phone', description: 'search · buy · sms · call' },
  { name: 'email', description: 'create · read · send · delete' },
  { name: 'compute', description: 'plans · deploy · list · renew · delete' },
  { name: 'domain', description: 'check · pricing · buy · dns' },
  { name: 'card', description: 'buy · list · get · refresh' },
  { name: 'wallet', description: 'create · import · list · export · sign · api-key · buy · sell · positions' },
  { name: 'twitter', description: 'X/Twitter accounts: import · buy · login · post · reply · like · follow' },
  { name: 'tiktok', description: 'TikTok accounts: connect · import · post · schedule · follow · like · analytics' },
  { name: 'note', description: 'Append a quick note to your local memory file' },
  { name: 'setup', description: 'Configure wallets + chain preference' },
  { name: 'status', description: 'Show config, wallets, and API health' },
  { name: 'config', description: 'Show current configuration' },
  { name: 'doctor', description: 'Verify system health (cred store, vault, API)' },
  { name: 'pricing', description: 'All service prices' },
  { name: 'health', description: 'API status + version check' },
  { name: 'telemetry', description: 'on · off · status (opt-in anonymous usage stats)' },
]

// ─── Help ───
// Single source of truth for the global-flag catalog so the agent-mode JSON
// help and the human TTY help can't drift. `--max-usdc`, `--token`, etc. are
// honored across commands; surfacing them here keeps scripted discovery honest.
const GLOBAL_FLAGS: Array<{ flag: string; desc: string }> = [
  { flag: '--json', desc: 'Force machine-parseable JSON output (auto-on when stdout isn\'t a TTY)' },
  { flag: '--quiet', desc: 'Suppress decorative log lines' },
  { flag: '--no-color', desc: 'Disable ANSI color (also honors the NO_COLOR env var)' },
  { flag: '--token <api-key>', desc: 'Bearer token for authenticated calls' },
  { flag: '--passphrase <pass>', desc: 'Wallet passphrase. PREFER the PALMYR_WALLET_PASSPHRASE env var — a value on the command line is visible to other processes (ps / Process Explorer) and lands in shell history' },
  { flag: '--max-usdc <USDC>', desc: 'Hard spend ceiling per payment; aborts before signing if exceeded (env: PALMYR_MAX_USDC)' },
]

function help() {
  if (AGENT_MODE) {
    print({
      version: VERSION,
      commands: TOP_LEVEL_COMMANDS,
      flags: {
        global: GLOBAL_FLAGS,
      },
      exitCodes: EXIT_CODE_DOCS,
    })
    return
  }
  // Human TTY help: the Ink MenuScreen render lives in app.tsx. Print the
  // global-flag list + exit-code contract here first so the human path surfaces
  // the same contract agents get — these scroll above the Ink frame.
  console.log(`\n  ${t.accent}global flags${t.reset}`)
  for (const f of GLOBAL_FLAGS) {
    console.log(`  ${t.info}${f.flag.padEnd(22)}${t.reset}${f.desc}`)
  }
  console.log(`\n  ${t.accent}exit codes${t.reset}`)
  for (const e of EXIT_CODE_DOCS) {
    console.log(`  ${t.warn}${String(e.code).padEnd(3)}${t.reset}${t.muted}${e.name.padEnd(12)}${t.reset}${e.description}`)
  }
  render(React.createElement(MenuScreen, {
    version: VERSION,
    title: 'help',
    subtitle: 'Command surface',
    footerLeft: 'Structured JSON output for all commands',
    commands: TOP_LEVEL_COMMANDS,
  }))
}

// ─── Commands ───
// Server-side constant (src/routes/agent-chat.ts ORCHESTRATION_FEE_USDC). Only
// used as the *minimum* balance needed to even ask for a plan — the real gate
// compares plan.totals after the plan lands.
const CHAT_ORCHESTRATION_FEE_USDC = 0.10

/**
 * `chat run` / `chat resume` USDC balance preflight. One RPC balance read on
 * the configured pay rail (same wallet/chain resolution the x402 payment path
 * uses) BEFORE the orchestration fee is signed, so a doomed run never pays
 * anything:
 *
 *   - no usable pay wallet / can't decrypt → abort (the fee payment was
 *     guaranteed to fail anyway; this surfaces the fix earlier and cleaner)
 *   - balance < fee → abort with balance vs required + funding instructions
 *   - RPC hiccup (balance unknowable) → warn on stderr and continue; never
 *     block a run on infrastructure flakiness
 *
 * Returns the balance reading so the caller can gate step execution against
 * plan.totals once the plan lands, or null when the balance couldn't be read.
 * Callers skip entirely on --skip-balance-check / PALMYR_NO_PREFLIGHT=1.
 */
async function chatUsdcPreflight(passphrase?: string): Promise<{ balanceUsdc: number; chain: string; walletAddress: string | null } | null> {
  const { fullPreflight } = await import('./pay-preflight.js')
  const spin = new Spinner()
  spin.start('Checking USDC balance...')
  let report
  try {
    report = await fullPreflight({ passphrase, minUsdc: CHAT_ORCHESTRATION_FEE_USDC })
  } catch (e: any) {
    // The preflight itself must never be a new way to fail a run.
    spin.stop('Balance check skipped', false)
    process.stderr.write(`[palmyr] warning: balance preflight failed (${e?.message ?? e}) — continuing without it.\n`)
    return null
  }
  if (!report.walletId || !report.canDecrypt) {
    spin.stop('No usable pay wallet', false)
    err(report.fix || 'No usable pay wallet. Create one with: palmyr wallet create', EXIT.PAYMENT)
  }
  const balance = report.usdc?.balance ?? null
  if (balance === null) {
    spin.stop('Balance check skipped', false)
    process.stderr.write(`[palmyr] warning: could not read the USDC balance on ${report.payChain} — continuing without the balance preflight.${report.fix ? ` ${report.fix}` : ''}\n`)
    return null
  }
  const short = usdcShortfall(balance, CHAT_ORCHESTRATION_FEE_USDC)
  if (short !== null) {
    spin.stop(`Balance $${balance.toFixed(2)} USDC on ${report.payChain}`, false)
    err(
      insufficientBalanceMessage({
        balanceUsdc: balance,
        requiredUsdc: CHAT_ORCHESTRATION_FEE_USDC,
        chain: report.payChain,
        walletAddress: report.walletAddress,
        context: `the $${CHAT_ORCHESTRATION_FEE_USDC.toFixed(2)} i402 orchestration fee`,
      }),
      EXIT.PAYMENT,
      { balanceUsdc: balance, requiredUsdc: CHAT_ORCHESTRATION_FEE_USDC, shortfallUsdc: short, chain: report.payChain, walletAddress: report.walletAddress },
    )
  }
  spin.stop(`Balance $${balance.toFixed(2)} USDC on ${report.payChain}`, true)
  return { balanceUsdc: balance, chain: report.payChain, walletAddress: report.walletAddress }
}

/**
 * Poll a TikTok operation to a terminal state.
 *
 * Every TikTok browser op is async server-side: the POST returns 202 with an
 * operation_id and NO `success` field. A caller that tests `data.success` on
 * that envelope concludes the op failed — every single time — while the work
 * goes on to succeed in the background. `approve` did exactly that, which is
 * why it always reported failure after the payment had been taken.
 *
 * Returns the terminal op, or null if it was still running when we gave up
 * (the work continues server-side either way).
 */
async function pollTikTokOperation(
  ao: any,
  opId: string,
  opts: { label: string; pollAfterSeconds?: number; timeoutMs?: number; agentMode: boolean },
): Promise<any | null> {
  const intervalMs = Math.max(1, Number(opts.pollAfterSeconds) || 15) * 1000
  // PALMYR_TIKTOK_POLL_TIMEOUT_MS lets a caller choose how long to wait before
  // handing back the operation_id. The work continues server-side regardless,
  // so this is patience, not a deadline on the op.
  const envTimeout = Number(process.env.PALMYR_TIKTOK_POLL_TIMEOUT_MS)
  const deadline = Date.now() + (opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 360_000))
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  if (!opts.agentMode) process.stderr.write(`tiktok ${opts.label}: working… (up to a few min)\n`)
  let attempt = 0
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    attempt++
    let op: any
    try {
      op = await ao.socialTiktokOperation(opId)
    } catch (e: any) {
      if (opts.agentMode) process.stderr.write(JSON.stringify({ event: 'poll', status: 'error', attempt, message: e?.message ?? String(e) }) + '\n')
      continue
    }
    if (opts.agentMode) process.stderr.write(JSON.stringify({ event: 'poll', status: op?.status || 'running', attempt }) + '\n')
    if (op?.done === true || op?.status === 'failed') return op
  }
  return null
}

async function main() {
  const { command, subcommand, positional, flags, flagKeys } = parse(process.argv)
  const fromHome = process.env.PALMYR_FROM_HOME === '1'

  // Reinforce NO_COLOR. The parser turns `--no-color` into `flags.color ===
  // false` (its generic `--no-<x>` handling), so check that form here. The
  // authoritative early set is the module-top raw-argv scan; this is an
  // idempotent backstop that also covers the env var.
  if (flags.color === false || process.env.NO_COLOR) {
    process.env.NO_COLOR = '1'
  }

  // Agent-mode detection: piped stdout (no TTY) or explicit --json. Once set,
  // it drives everything — Ink screens flip to JSON output, Spinner/decorators
  // self-suppress (see ui.ts:setAgentMode), and err() stringifies to stderr.
  // Honor PALMYR_JSON=1 too so agents can opt in via env var when their
  // runtime allocates a TTY they can't easily suppress.
  AGENT_MODE = !process.stdout.isTTY || !!flags.json || process.env.PALMYR_JSON === '1'
  setUiAgentMode(AGENT_MODE)

  // A passphrase passed as a CLI flag is visible in the process list (ps, /proc,
  // Windows Process Explorer) and lands in shell history. Warn once and point at
  // the env var, which keeps non-TTY automation working without exposing the
  // secret. Always to stderr so it never pollutes --json stdout.
  if (flags.passphrase || flags['current-passphrase']) {
    process.stderr.write(
      '[palmyr] warning: a passphrase passed as a CLI flag is visible in the process list and shell history. ' +
      'Prefer PALMYR_WALLET_PASSPHRASE (or PALMYR_WALLET_PASSPHRASE_CURRENT) in the environment.\n'
    )
  }

  if (flags.version) {
    // `--version` follows the universal CLI convention: a bare version string on
    // stdout so wrappers/CI can grep it. Agents that want the richer cli/node/
    // platform report opt in explicitly with --json (or PALMYR_JSON=1).
    if (AGENT_MODE && (!!flags.json || process.env.PALMYR_JSON === '1')) {
      print({
        cliPackageVersion: VERSION,
        version: VERSION, // back-compat alias for the legacy {version} shape
        nodeVersion: process.version,
        platform: process.platform,
      })
    } else {
      console.log(VERSION)
    }
    return
  }
  if (flags.help && !command) { help(); return }

  // No command — show welcome dashboard (agents get a JSON listing of the
  // top-level command surface so they can drive discovery programmatically).
  if (!command) {
    const cfg = loadConfig()
    let apiOk = false
    try { const h = await new Palmyr(cfg.api).health(); apiOk = h.status === 'healthy' } catch {}
    if (AGENT_MODE) {
      print({
        version: VERSION,
        chain: cfg.defaultChain,
        wallets: cfg.wallets || {},
        apiOk,
        commands: TOP_LEVEL_COMMANDS,
      })
      return
    }
    render(React.createElement(Dashboard, {
      version: VERSION,
      chain: cfg.defaultChain,
      wallets: cfg.wallets,
      apiOk,
    }))
    return
  }

  // Fail fast on flag typos before any command logic (and before any paid
  // call). `--help` bypasses the guard: help output beats strictness.
  if (!flags.help) rejectUnknownFlags(command, subcommand, flagKeys)

  // Always ensure ~/.palmyr/ exists on any command
  ensureDirs()

  const config = loadConfig()
  const startTime = Date.now()

  // No first-time banner — agent-first CLI should never pollute output.
  const url = process.env.PALMYR_API || config.api

  // Opt-in telemetry. If the user has explicitly enabled it, queue this run's
  // exit-code + duration on shutdown (sync — async work in 'exit' is dropped)
  // and fire-and-forget any previously-queued events to the API right now.
  // Both no-ops when telemetry is off. Never blocks the user's command —
  // the flush races their work and Node exits once both finish.
  process.on('exit', (code) => {
    telemetryAppendEvent({
      cmd: subcommand ? `${command} ${subcommand}` : command,
      exitCode: code,
      durationMs: Date.now() - startTime,
      cliVersion: VERSION,
      nodeVersion: process.version,
      platform: process.platform,
    })
  })
  void telemetryFlushQueue(url)
  const token = (flags.token as string) || config.apiKey || process.env.PALMYR_TOKEN || process.env.PALMYR_API_KEY
  const passphrase = (flags.passphrase as string) || process.env.PALMYR_WALLET_PASSPHRASE
  const ao = new Palmyr(url, true, token, passphrase)

  try {
    switch (command) {
      case 'setup': {
        ensureDirs()

        const keyfile = flags.keyfile as string
          || process.env.PALMYR_KEYFILE
          || (() => {
            const defaultPath = homedir() + '/.config/solana/id.json'
            if (existsSync(defaultPath)) return defaultPath
            return ''
          })()

        const chain = (flags.chain as string || 'solana') as 'solana' | 'base'

        if (!keyfile) {
          err('No keyfile. Pass --keyfile /path/to/keypair.json --chain solana', EXIT.BAD_INPUT)
        }

        if (!existsSync(keyfile.replace('~', homedir()))) {
          err(`Keyfile not found: ${keyfile}`, EXIT.NOT_FOUND)
        }

        const { addWalletToConfig, getConfiguredChains } = await import('./config.js')
        addWalletToConfig(chain, keyfile)
        const chains = getConfiguredChains()

        if (AGENT_MODE) {
          print({ ok: true, api: url, keyfile, chains, addedChain: chain })
        } else {
          render(React.createElement(SetupScreen, {
            version: VERSION,
            api: url,
            keyfile,
            chains,
            addedChain: chain,
          }))
        }
        log(`setup: keyfile=${keyfile} chain=${chain}`)
        break
      }

      case 'status': {
        const wallets = config.wallets || {}
        let apiOk = false
        try { const h = await ao.health(); apiOk = h.status === 'healthy' } catch {}

        if (AGENT_MODE) {
          print({
            api: config.api,
            apiOk,
            wallets,
            defaultChain: config.defaultChain || 'solana',
          })
        } else {
          render(React.createElement(StatusScreen, {
            version: VERSION,
            api: config.api,
            apiOk,
            wallets,
            defaultChain: config.defaultChain || 'solana',
            interactive: fromHome,
            onBack: fromHome ? () => {
              process.env.PALMYR_FROM_HOME = '0'
              process.argv = [process.argv[0], process.argv[1]]
              void main()
            } : undefined,
          }))
        }
        break
      }

      case 'note': {
        const text = positional.join(' ') || subcommand || ''
        if (!text) err('Usage: palmyr note "your note here"')
        addNote(text)
        if (AGENT_MODE) {
          print({ ok: true, note: text, path: '~/.palmyr/memory/notes.md' })
        } else {
          render(React.createElement(SuccessScreen, { version: VERSION, title: 'note saved', subtitle: text, details: [{ label: 'Path', value: '~/.palmyr/memory/notes.md' }], footerLeft: 'Note saved' }))
        }
        break
      }

      case 'phone': {
        if (!subcommand || (flags.help && !PHONE_HELP[subcommand])) {
          showMenu({
            command: 'phone',
            title: 'phone',
            subtitle: 'Voice and messaging',
            footerLeft: 'Phone operations',
            commands: [
              { name: 'search', description: 'Search available numbers', hint: '--country US' },
              { name: 'buy', description: 'Buy a phone number', hint: '--country US' },
              { name: 'temp', description: 'Lease a disposable receive-only US number for an SMS code', hint: '[--ttl 1800]' },
              { name: 'extend', description: 'Rent another 30 min on a live temp number', hint: '<id>' },
              { name: 'list', description: 'List numbers owned by or shared with your wallet' },
              { name: 'release', description: 'Release a phone number', hint: '--id PHONE_ID' },
              { name: 'transfer-ownership', description: 'Hand a number to another wallet', hint: '--id PHONE_ID --to <wallet>' },
              { name: 'share', description: 'Grant another wallet shared use of a number', hint: '--id PHONE_ID --with <wallet>' },
              { name: 'unshare', description: 'Revoke a wallet’s shared use', hint: '--id PHONE_ID --from <wallet>' },
              { name: 'sms', description: 'Send an SMS', hint: '--id ID --to +1... --body "hi"' },
              { name: 'messages', description: 'Read SMS messages received on a number', hint: '--id PHONE_ID' },
              { name: 'message', description: 'Get one SMS message by id (incl. delivery status)', hint: '--id MESSAGE_ID' },
              { name: 'wait-otp', description: 'Block until an SMS verification code arrives, print the code', hint: '<number-id> [--timeout <s>] [--lookback <s>] [--pattern <regex>]' },
              { name: 'call', description: 'Place a voice call', hint: '--id ID --to +1... --tts "hello"' },
              { name: 'calls', description: 'List calls placed/received on a number', hint: '--id PHONE_ID' },
              { name: 'call-info', description: 'Get details on a single call', hint: '--call CALL_CONTROL_ID' },
              { name: 'speak', description: 'TTS into a live call', hint: '--call ID --text "..." [--voice V]' },
              { name: 'play', description: 'Play an audio URL into a live call', hint: '--call ID --url https://...' },
              { name: 'dtmf', description: 'Send DTMF tones to a live call', hint: '--call ID --digits "1234#"' },
              { name: 'gather', description: 'Collect DTMF input from caller', hint: '--call ID [--min-digits N --max-digits N --timeout MS --prompt "..."]' },
              { name: 'record', description: 'Start recording a live call', hint: '--call ID [--format mp3]' },
              { name: 'record-stop', description: 'Stop recording a live call', hint: '--call ID' },
              { name: 'hangup', description: 'End a live call', hint: '--call ID' },
              { name: 'answer', description: 'Answer an inbound call', hint: '--call ID' },
              { name: 'transfer', description: 'Transfer a live call to another number', hint: '--call ID --to +1...' },
            ],
            fromHome,
          })
          break
        }
        if (flags.help && subcommand && PHONE_HELP[subcommand]) {
          subcommandHelp('phone', subcommand, PHONE_HELP[subcommand])
          break
        }
        switch (subcommand) {
          case 'search': {
            const country = flags.country as string || 'US'
            const data = await ao.phoneSearch(country, flags.limit ? parseInt(flags.limit as string) : undefined)
            // Empty result is a valid response but `{numbers: []}` alone made it
            // ambiguous whether the API failed or the country has no inventory.
            // Add a non-breaking `note` field — agents that already key off
            // `.numbers.length` keep working; new readers get a clear signal.
            if (data && Array.isArray(data.numbers) && data.numbers.length === 0 && !data.note) {
              data.note = `No numbers available for ${country}. Try a different country code (US, GB, CA, DE, etc.).`
            }
            if (AGENT_MODE) return print(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: 'phone search',
              subtitle: `Available numbers · ${country}`,
              footerLeft: `${(data.numbers || []).length} result(s)`,
              records: (data.numbers || []).map((n: any) => ({
                primary: String(n.phoneNumber || 'unknown'),
                secondary: [n.region, n.type].filter(Boolean).join(' · '),
              })),
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.PALMYR_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'buy': {
            const country = flags.country as string
            if (!country) err('--country required')
            const spin = new Spinner()
            spin.start('Provisioning phone number...')
            const data = await ao.phoneBuy(country, flags.area as string)
            spin.stop('Phone number provisioned', true)
            const number = data.phoneNumber || data.phone_number || 'provisioned'
            // Local bookkeeping MUST run in both modes — agents and humans
            // alike rely on the cached number record. (Previously dead behind an
            // unconditional `return print`.)
            addPhone({ id: data.id, number, country, createdAt: new Date().toISOString() })
            log(`phone buy: ${data.phoneNumber || data.phone_number || 'unknown'} (${country})`)
            if (AGENT_MODE) return print(data)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Phone provisioned',
              subtitle: number,
              footerLeft: 'Number ready to use',
              details: [
                { label: 'ID', value: String(data.id || '') },
                { label: 'Country', value: country },
              ],
            }))
            break
          }
          case 'temp': {
            // Disposable, receive-only pooled number. No --country/--area: the
            // server leases a US pool number and owns it to the paying wallet.
            // Only the TTL is tunable. Receive-only — call `phone wait-otp <id>`.
            const ttlRaw = (flags.ttl as string) ?? undefined
            let ttl: number | undefined
            if (ttlRaw != null) {
              ttl = Number(ttlRaw)
              if (!Number.isFinite(ttl) || ttl <= 0) err('--ttl must be a positive number of seconds (default 1800 = 30min, min 300, max 1800)')
            }
            const spin = new Spinner()
            spin.start('Leasing temp number...')
            const data = await ao.phoneTemp(ttl)
            spin.stop('Temp number leased', true)
            return print(data)
          }
          case 'extend': {
            // Rent another 30 min on a live temp lease. Fixed +30min per call,
            // stackable to 24h. Expired leases 404 (no revival); permanent 400.
            const id = (flags.id as string) || positional[0]
            if (!id) err('--id PHONE_ID required (a lease id from `palmyr phone temp`)')
            const spin = new Spinner()
            spin.start('Extending temp number...')
            const data = await ao.phoneExtendTemp(id)
            spin.stop('Temp number extended', true)
            return print(data)
          }
          case 'sms': {
            const id = flags.id as string; const to = flags.to as string; const body = flags.body as string
            if (!id || !to || !body) err('--id, --to, --body required')
            const data = await ao.phoneSms(id, to, body)
            if (AGENT_MODE) return print(data)
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'SMS sent', subtitle: to, details: [{ label: 'To', value: to }], footerLeft: 'Message delivered' }))
            break
          }
          case 'call': {
            const id = flags.id as string; const to = flags.to as string
            if (!id || !to) err('--id, --to required')
            const data = await ao.phoneCall(id, to, flags.tts as string)
            if (AGENT_MODE) return print(data)
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'calling', subtitle: to, details: [{ label: 'To', value: to }, { label: 'Call ID', value: data.callControlId || data.id || '' }], footerLeft: 'Call initiated' }))
            break
          }
          case 'list': {
            const data = await ao.phoneListNumbers()
            return print(data)
          }
          case 'messages': {
            const id = (flags.id as string) || positional[0]
            if (!id) err('--id PHONE_ID required')
            const data = await ao.phoneMessages(id)
            return print(data)
          }
          case 'message':
          case 'sms-status': {
            // Per-message readback. Mirrors `phone call-info` for SMS:
            // the Telnyx webhook updates delivery_status on the row, and this
            // endpoint serves it back. Useful when the immediate sms response
            // is 'queued' and the caller wants to confirm delivery.
            const messageId = (flags.id as string) || (flags.message as string) || positional[0]
            if (!messageId) err('Usage: palmyr phone message <message-id>')
            const data = await ao.phoneMessage(messageId!)
            return print(data)
          }
          case 'wait-otp': {
            // Blocking paid wait for an SMS verification code. The server holds
            // the request (up to --timeout, max 90s) and returns the parsed
            // code — one call instead of hand-rolled polling of `phone messages`.
            const id = (flags.id as string) || positional[0]
            if (!id) err('Usage: palmyr phone wait-otp <number-id> [--timeout <s>] [--lookback <s>] [--pattern <regex>]')
            const opts: { timeoutS?: number; lookbackS?: number; pattern?: string } = {}
            // Validate client-side: the server clamps silently, and a clamped
            // `--timeout 500` waiting 90s while the spinner claims 500s (or
            // `--timeout abc` quietly becoming 60) is worse than an error.
            if (flags.timeout !== undefined) {
              const t = typeof flags.timeout === 'string' ? Number(flags.timeout) : NaN
              if (!Number.isInteger(t) || t < 1 || t > 90) err(`--timeout must be an integer between 1 and 90 seconds (got '${flags.timeout}')`)
              opts.timeoutS = t
            }
            if (flags.lookback !== undefined) {
              const l = typeof flags.lookback === 'string' ? Number(flags.lookback) : NaN
              if (!Number.isInteger(l) || l < 0 || l > 300) err(`--lookback must be an integer between 0 and 300 seconds (got '${flags.lookback}'). Use 0 when reusing a number across signups.`)
              opts.lookbackS = l
            }
            if (flags.pattern) opts.pattern = flags.pattern as string
            if (AGENT_MODE) {
              const data = await ao.phoneWaitOtp(id!, opts)
              return print(data)
            }
            const spin = new Spinner()
            spin.start(`Waiting for verification code (up to ${opts.timeoutS ?? 60}s)...`)
            const data = await ao.phoneWaitOtp(id!, opts)
            const patternNote = data?.pattern_timeout ? ' (custom --pattern exceeded its match budget and was ignored — default extraction was used)' : ''
            if (data && data.found) {
              spin.stop(`Verification code received${patternNote}`, true)
              // Plain code on its own line — easy to copy, easy to pipe.
              console.log(String(data.code))
            } else {
              spin.stop(`No verification code after ${data?.waited_s ?? '?'}s — run again to keep waiting${patternNote}`, false)
            }
            break
          }
          case 'calls': {
            const id = (flags.id as string) || positional[0]
            if (!id) err('--id PHONE_ID required')
            const data = await ao.phoneCalls(id)
            return print(data)
          }
          case 'release': {
            const id = (flags.id as string) || positional[0]
            if (!id) err('--id PHONE_ID required')
            const data = await ao.phoneRelease(id)
            return print(data)
          }
          case 'transfer-ownership': {
            const id = (flags.id as string) || positional[0]
            const to = (flags.to as string) || positional[1]
            if (!id) err('--id PHONE_ID required')
            if (!to) err('--to <wallet> required')
            const data = await ao.phoneTransferOwnership(id, to)
            log(`phone transfer-ownership: ${id} → ${to}`)
            return print(data)
          }
          case 'share': {
            const id = (flags.id as string) || positional[0]
            const withWallet = (flags.with as string) || (flags.wallet as string)
            if (!id) err('--id PHONE_ID required')
            if (!withWallet) err('--with <wallet> required')
            const data = await ao.phoneShare(id, withWallet)
            log(`phone share: ${id} → ${withWallet}`)
            return print(data)
          }
          case 'unshare': {
            const id = (flags.id as string) || positional[0]
            const targetWallet = (flags.from as string) || (flags.wallet as string)
            if (!id) err('--id PHONE_ID required')
            if (!targetWallet) err('--from <wallet> required')
            const data = await ao.phoneUnshare(id, targetWallet)
            log(`phone unshare: ${id} ✗ ${targetWallet}`)
            return print(data)
          }
          case 'call-info': {
            const callId = (flags.call as string) || (flags.id as string) || positional[0]
            if (!callId) err('--call CALL_CONTROL_ID required')
            const data = await ao.phoneCallInfo(callId)
            return print(data)
          }
          case 'speak': {
            const callId = (flags.call as string) || (flags.id as string)
            const text = (flags.text as string) || (flags.tts as string)
            if (!callId || !text) err('--call <id>, --text <text> required')
            const voice = flags.voice as string | undefined
            const language = flags.language as string | undefined
            const data = await ao.phoneSpeak(callId, text, { ...(voice ? { voice } : {}), ...(language ? { language } : {}) })
            return print(data)
          }
          case 'play': {
            const callId = (flags.call as string) || (flags.id as string)
            const audioUrl = (flags.url as string) || (flags['audio-url'] as string)
            if (!callId || !audioUrl) err('--call <id>, --url <https://...> required')
            const data = await ao.phonePlay(callId, audioUrl)
            return print(data)
          }
          case 'dtmf': {
            const callId = (flags.call as string) || (flags.id as string)
            const digits = (flags.digits as string) || positional[0]
            if (!callId || !digits) err('--call <id>, --digits "1234#" required')
            const data = await ao.phoneDtmf(callId, digits)
            return print(data)
          }
          case 'gather': {
            const callId = (flags.call as string) || (flags.id as string)
            if (!callId) err('--call <id> required')
            const parseInt0 = (v: unknown) => (typeof v === 'string' ? parseInt(v, 10) : undefined)
            const opts: {
              minDigits?: number
              maxDigits?: number
              timeoutMillis?: number
              terminatingDigit?: string
              prompt?: string
              promptVoice?: string
            } = {}
            const minDigits = parseInt0(flags['min-digits']); if (minDigits !== undefined && Number.isFinite(minDigits)) opts.minDigits = minDigits
            const maxDigits = parseInt0(flags['max-digits']); if (maxDigits !== undefined && Number.isFinite(maxDigits)) opts.maxDigits = maxDigits
            const timeoutMillis = parseInt0(flags.timeout); if (timeoutMillis !== undefined && Number.isFinite(timeoutMillis)) opts.timeoutMillis = timeoutMillis
            if (flags['terminating-digit']) opts.terminatingDigit = flags['terminating-digit'] as string
            if (flags.prompt) opts.prompt = flags.prompt as string
            if (flags['prompt-voice']) opts.promptVoice = flags['prompt-voice'] as string
            const data = await ao.phoneGather(callId, opts)
            return print(data)
          }
          case 'record': {
            const callId = (flags.call as string) || (flags.id as string)
            if (!callId) err('--call <id> required')
            const data = await ao.phoneRecord(callId, flags.format as string | undefined)
            return print(data)
          }
          case 'record-stop': {
            const callId = (flags.call as string) || (flags.id as string)
            if (!callId) err('--call <id> required')
            const data = await ao.phoneRecordStop(callId)
            return print(data)
          }
          case 'hangup': {
            const callId = (flags.call as string) || (flags.id as string)
            if (!callId) err('--call <id> required')
            const data = await ao.phoneHangup(callId)
            return print(data)
          }
          case 'answer': {
            const callId = (flags.call as string) || (flags.id as string)
            if (!callId) err('--call <id> required')
            const data = await ao.phoneAnswer(callId)
            return print(data)
          }
          case 'transfer': {
            const callId = (flags.call as string) || (flags.id as string)
            const to = flags.to as string
            if (!callId || !to) err('--call <id>, --to <+E.164> required')
            const data = await ao.phoneTransfer(callId, to)
            return print(data)
          }
          default: err(`Unknown phone command: ${subcommand}. Try: search, buy, list, release, transfer-ownership, share, unshare, sms, messages, message, wait-otp, call, calls, call-info, speak, play, dtmf, gather, record, record-stop, hangup, answer, transfer`)
        }
        break
      }

      case 'email': {
        if (!subcommand || (flags.help && !EMAIL_HELP[subcommand])) {
          showMenu({
            command: 'email',
            title: 'email',
            subtitle: 'Inbox operations',
            footerLeft: 'Email operations',
            commands: [
              { name: 'create', description: 'Create an inbox', hint: '--name agent [--domain example.com]' },
              { name: 'temp', description: 'Create a disposable receive-only inbox (auto-expires)', hint: '[--ttl SECONDS]' },
              { name: 'extend', description: 'Rent another 7 days on a live temp inbox ($0.50, stackable)', hint: '--id INBOX_ID' },
              { name: 'list', description: 'List inboxes owned by your wallet' },
              { name: 'status', description: 'Domain verification status (Mailgun)', hint: '<domain>' },
              { name: 'register', description: 'Register / re-register a wallet-owned domain with Mailgun', hint: '<domain>' },
              { name: 'read', description: 'Read inbox messages', hint: '--id INBOX_ID' },
              { name: 'send', description: 'Send an email', hint: '--id ID --to x@y.com --subject ... --body ...' },
              { name: 'threads', description: 'List threads', hint: '--id INBOX_ID' },
              { name: 'delete', description: 'Delete an inbox (inbound mail stops; reads 404)', hint: '--id INBOX_ID' },
            ],
            fromHome,
          })
          break
        }
        if (flags.help && subcommand && EMAIL_HELP[subcommand]) {
          subcommandHelp('email', subcommand, EMAIL_HELP[subcommand])
          break
        }
        switch (subcommand) {
          case 'create': {
            const name = flags.name as string || positional[0]
            const walletInput = flags.wallet as string | undefined
            const domain = flags.domain as string | undefined
            if (!name) err('--name required (e.g. palmyr email create --name hello [--domain example.com])')
            // --wallet accepts three forms: vault id, vault name, or a raw
            // Solana base58 pubkey. Supplying a Solana pubkey turns ON
            // end-to-end encryption (NaCl box, Ed25519→X25519) — only that
            // wallet can read the inbox. E2E is OPT-IN: without a Solana key the
            // inbox is owned by the x402 payer on EITHER chain (Base or Solana)
            // and encrypted server-side with AES-256-GCM, decrypted on read
            // after an ownership proof. We resolve id/name to the vault's Solana
            // address so CLI-created inboxes default to E2E; a Base-paying user
            // still works because one mnemonic-derived vault wallet has both
            // addresses, found client-side without the server reaching for keys.
            let walletAddress: string | undefined
            if (walletInput) {
              const looksLikeSolPubkey = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletInput)
              if (looksLikeSolPubkey) {
                walletAddress = walletInput
              } else {
                const { listVaultWallets } = await import('./vault.js')
                const wallets = listVaultWallets()
                const match = wallets.find(w => w.id === walletInput || w.name === walletInput)
                if (!match) err(`--wallet "${walletInput}" did not match any vault id, name, or look like a Solana pubkey`)
                if (!match!.solanaAddress) err(`Wallet "${walletInput}" has no Solana address. The CLI defaults inboxes to end-to-end encryption, which needs a Solana key. Re-create with: palmyr wallet create`)
                walletAddress = match!.solanaAddress!
              }
            } else {
              // No --wallet: the server defaults the inbox owner to the x402
              // payer on EITHER chain (a Base payer gets an AES, non-E2E inbox —
              // it is no longer rejected). To keep CLI inboxes E2E by default,
              // auto-fill the *paying wallet's* Solana address so the inbox is
              // sealed to a Solana key regardless of which chain paid.
              const cfg = loadConfig() as any
              const payChain = (cfg.defaultPayChain || 'solana') as 'solana' | 'base'
              if (payChain === 'base') {
                const { listVaultWallets } = await import('./vault.js')
                const wallets = listVaultWallets()
                const targetId = cfg.defaultPayWalletId || process.env.PALMYR_PAY_WALLET
                const paying = (targetId && wallets.find(w => w.id === targetId)) || wallets.find(w => w.evmAddress && w.solanaAddress)
                if (paying?.solanaAddress) walletAddress = paying.solanaAddress
                // If no Solana address is reachable, fall through with no
                // walletAddress: the server then owns the inbox to the Base
                // payer with server-side AES (no E2E) rather than erroring.
              }
            }
            const spin = new Spinner()
            spin.start('Creating inbox...')
            const data = await ao.emailCreate(name, walletAddress, domain)
            spin.stop('Inbox created', true)
            return print(data)
          }
          case 'temp': {
            // Disposable, receive-only inbox. No --name/--wallet: the server
            // generates a natural handle on a dedicated inbox domain and owns it
            // to the paying wallet (no E2E — plaintext reads). Only TTL is tunable.
            const ttlRaw = (flags.ttl as string) ?? undefined
            let ttl: number | undefined
            if (ttlRaw != null) {
              ttl = Number(ttlRaw)
              if (!Number.isFinite(ttl) || ttl <= 0) err('--ttl must be a positive number of seconds (default 86400 = 24h, min 300, max 604800)')
            }
            const spin = new Spinner()
            spin.start('Creating temp inbox...')
            const data = await ao.emailTemp(ttl)
            spin.stop('Temp inbox created', true)
            return print(data)
          }
          case 'extend': {
            // Rent another 7 days on a live temp inbox. Fixed +7d per call —
            // no params beyond the id; call again for another week. Expired
            // temp inboxes 404 (no revival) and normal inboxes 400 (no TTL).
            const id = flags.id as string || positional[0]
            if (!id) err('--id INBOX_ID required (a UUID from `palmyr email temp`, e.g. palmyr email extend --id 8b6cf4a2-91d3-4f0e-b2a7-3c5d1e9f6a04)')
            const spin = new Spinner()
            spin.start('Extending temp inbox...')
            const data = await ao.emailExtendTemp(id)
            spin.stop('Temp inbox extended', true)
            return print(data)
          }
          case 'list': {
            const data = await ao.emailListInboxes()
            return print(data)
          }
          case 'status': {
            const domain = (flags.domain as string) || positional[0]
            if (!domain) err('domain required: palmyr email status <domain>')
            const data = await ao.emailDomainStatus(domain)
            return print(data)
          }
          case 'register': {
            const domain = (flags.domain as string) || positional[0]
            if (!domain) err('domain required: palmyr email register <domain>')
            const data = await ao.emailRegisterDomain(domain)
            return print(data)
          }
          case 'read': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id INBOX_ID required')
            const data = await ao.emailRead(id)
            if (AGENT_MODE) return print(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: 'email read',
              subtitle: `Inbox ${data.inbox || id}`,
              footerLeft: `${(data.messages || []).length} message(s)`,
              records: (data.messages || []).map((m: any) => ({
                primary: String(m.subject || '(no subject)'),
                secondary: `${m.direction === 'inbound' ? '←' : '→'} ${m.from || ''}`.trim(),
                status: String(m.timestamp || ''),
              })),
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.PALMYR_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'send': {
            const id = flags.id as string; const to = flags.to as string
            const subject = flags.subject as string; const body = flags.body as string
            if (!id || !to || !subject || !body) err('--id, --to, --subject, --body required')
            const data = await ao.emailSend(id, to, subject, body)
            if (AGENT_MODE) return print(data)
            render(React.createElement(SuccessScreen, { version: VERSION, title: 'email sent', subtitle: to, details: [{ label: 'To', value: to }], footerLeft: 'Email delivered' }))
            break
          }
          case 'threads': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id INBOX_ID required')
            const data = await ao.emailThreads(id)
            if (AGENT_MODE) return print(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: 'email threads',
              subtitle: 'Conversation threads',
              footerLeft: `${(data.threads || []).length} thread(s)`,
              records: (data.threads || []).map((t: any) => ({
                primary: String(t.subject || '(no subject)'),
                secondary: `${t.message_count || 0} msg(s)`,
              })),
            }))
            break
          }
          case 'delete': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id INBOX_ID required (a UUID from `palmyr email list`, e.g. palmyr email delete --id 8b6cf4a2-91d3-4f0e-b2a7-3c5d1e9f6a04)')
            const spin = new Spinner()
            spin.start('Deleting inbox...')
            const data = await ao.emailDelete(id)
            spin.stop('Inbox deleted', true)
            return print(data)
          }
          default: err(`Unknown email command: ${subcommand}. Try: create, temp, extend, list, status, register, read, send, threads, delete`)
        }
        break
      }

      case 'compute': {
        if (!subcommand || (flags.help && !COMPUTE_HELP[subcommand])) {
          showMenu({
            command: 'compute',
            title: 'compute',
            subtitle: 'Server operations',
            footerLeft: 'Compute operations',
            commands: [
              { name: 'plans', description: 'List VPS plans (live from Hetzner)', hint: '[--location fsn1]' },
              { name: 'locations', description: 'List Hetzner datacenters + per-location server-type availability' },
              { name: 'install-recipes', description: 'List available agent install recipes (hermes, openclaw, ...)' },
              { name: 'ssh-key', description: 'Manage Hetzner SSH keys', hint: 'add <pubkey-file> | list | delete <id>' },
              { name: 'deploy', description: 'Deploy a VPS (golden path: auto-key, wait, verified SSH)', hint: '--type cx23 [--install hermes] [--location fsn1] [--no-wait]' },
              { name: 'wait', description: 'Block until status=running, port 22 open, SSH verified, installs done', hint: '<name|id> [--install hermes] [--key <path>] [--wait-timeout <sec>]' },
              { name: 'ssh', description: 'SSH into a deployed VPS by name or id', hint: '<name|id>' },
              { name: 'exec', description: 'Run a single command on a freshly-deployed VPS (pre-handoff)', hint: '<name|id> -- <command> [args...]' },
              { name: 'rename', description: 'Rename a deployed VPS (metadata-only, no reboot)', hint: '<name|id> <new-name>' },
              { name: 'reset-password', description: 'Rotate the root password (Hetzner-side)', hint: '<name|id>' },
              { name: 'console', description: 'Get a noVNC console URL (break-glass)', hint: '<name|id>' },
              { name: 'reboot', description: 'Reboot a server', hint: '<name|id>' },
              { name: 'setup-ssh', description: 'Inject your SSH key into a deployed VPS post-hoc', hint: '<id> --pubkey-file ~/.ssh/id_ed25519.pub' },
              { name: 'list', description: 'List servers' },
              { name: 'delete', description: 'Delete a server', hint: '--id SERVER_ID' },
            ],
            fromHome,
          })
          break
        }
        if (flags.help && subcommand && COMPUTE_HELP[subcommand]) {
          subcommandHelp('compute', subcommand, COMPUTE_HELP[subcommand])
          break
        }
        switch (subcommand) {
          case 'plans': {
            // --location filters to types deployable in that location. Each
            // plan's response also carries `availableLocations[]` so callers
            // without a preference can see where each type runs.
            const location = flags.location as string | undefined
            const data = await ao.computePlans(location ? { location } : {})
            return print(data)
          }
          case 'locations': {
            // Free discovery — list Hetzner locations + per-location server
            // type availability. Useful when the default location is
            // capacity-constrained or doesn't carry the type you want.
            const data = await ao.computeLocations()
            return print(data)
          }
          case 'ssh-key': {
            // Subcommand layout: `compute ssh-key add <pubkey-file>` | `list` | `delete <id>`
            // We piggy-back on the parser's `positional` array — `add` consumes
            // positional[0] as the file path, `delete` consumes it as the ID.
            const op = positional[0]
            const arg = positional[1]
            if (!op || op === 'list') {
              const data = await ao.computeSshKeyList()
              return print(data)
            }
            if (op === 'add') {
              const pubkeyFile = arg || (flags.file as string) || (flags['pubkey-file'] as string)
              if (!pubkeyFile) err('Usage: palmyr compute ssh-key add <pubkey-file> [--name "label"]', EXIT.BAD_INPUT)
              const fullPath = pubkeyFile.replace('~', homedir())
              if (!existsSync(fullPath)) err(`Public key file not found: ${pubkeyFile}`, EXIT.NOT_FOUND)
              const publicKey = readFileSync(fullPath, 'utf8').trim()
              const name = (flags.name as string) || (flags.label as string) ||
                (publicKey.split(/\s+/)[2] || `key-${Date.now()}`)
              const data = await ao.computeSshKeyAdd(name, publicKey)
              return print(data)
            }
            if (op === 'delete' || op === 'remove' || op === 'rm') {
              const id = arg || (flags.id as string)
              if (!id) err('Usage: palmyr compute ssh-key delete <id>', EXIT.BAD_INPUT)
              const data = await ao.computeSshKeyDelete(id)
              return print(data)
            }
            err(`Unknown ssh-key subcommand: ${op}. Try: add, list, delete`, EXIT.BAD_INPUT)
            break
          }
          case 'deploy': {
            const csshMod = await import('./compute-ssh.js')
            const name = flags.name as string || 'agent-' + Date.now()
            const type = flags.type as string || 'cx23'

            // SSH-key resolution priority (most explicit wins):
            //   1. --generate-ssh-key      → fresh keypair, saved locally, pubkey inline
            //   2. --pubkey-file <path>    → read file, send pubkey inline
            //   3. --pubkey "ssh-..."      → send pubkey inline as-is
            //   4. --ssh-key <id>          → numeric Hetzner ID, sent as sshKeyIds[]
            // 1–3 all use cloud-init inline; 4 uses Hetzner's pre-uploaded key
            // mechanism. They're mutually exclusive — the user who passes
            // multiple gets a clear error rather than silent precedence games.
            //
            // GOLDEN PATH: with no key flag at all, we auto-generate one. The
            // alternative ("deploy returns and you can't SSH") was the agent's
            // top complaint. `--no-generate-ssh-key` opts out (e.g. user wants
            // to attach a key after the fact via setup-ssh).
            let wantGenerate = flags['generate-ssh-key'] === true || flags.generate === true
            const pubkeyInline = (flags.pubkey as string) || (flags.publicKey as string)
            const pubkeyFile = (flags['pubkey-file'] as string) || (flags['ssh-key-file'] as string)
            const sshKeyIdRaw = flags['ssh-key'] as string | undefined
            const explicitNoGenerate = flags['generate-ssh-key'] === false || flags.generate === false

            const keySources = [wantGenerate, !!pubkeyInline, !!pubkeyFile, !!sshKeyIdRaw].filter(Boolean).length
            if (keySources > 1) {
              err('Pass only one of: --generate-ssh-key, --pubkey, --pubkey-file, --ssh-key <id>', EXIT.BAD_INPUT)
            }
            if (keySources === 0 && !explicitNoGenerate) {
              wantGenerate = true
            }

            let sshPublicKey: string | undefined
            let sshKeyIds: number[] | undefined
            let generatedKeyMeta: { privateKeyPath: string; publicKeyPath: string } | undefined

            if (sshKeyIdRaw) {
              const n = Number(sshKeyIdRaw)
              if (!Number.isFinite(n) || n <= 0) err(`--ssh-key must be a numeric Hetzner key ID (got "${sshKeyIdRaw}"). Run \`palmyr compute ssh-key list\` to find it, or \`compute ssh-key add <pubkey-file>\` to upload one.`, EXIT.BAD_INPUT)
              sshKeyIds = [n]
            } else if (pubkeyFile) {
              const fullPath = pubkeyFile.replace('~', homedir())
              if (!existsSync(fullPath)) err(`Public key file not found: ${pubkeyFile}`, EXIT.NOT_FOUND)
              sshPublicKey = readFileSync(fullPath, 'utf8').trim()
            } else if (pubkeyInline) {
              sshPublicKey = pubkeyInline.trim()
            } else if (wantGenerate) {
              // Generated keys are namespaced by server NAME (we don't have an
              // ID yet at this point). The directory gets renamed to use the
              // ID once the deploy returns, so cached lookups by either work.
              try {
                const kp = csshMod.generateKeypair(name)
                sshPublicKey = kp.publicKey
                generatedKeyMeta = { privateKeyPath: kp.privateKeyPath, publicKeyPath: kp.publicKeyPath }
              } catch (e: any) {
                err(`--generate-ssh-key failed: ${e.message}`, EXIT.GENERAL)
              }
            }

            // Resolve the install list. `--install hermes` or `--install hermes,openclaw`
            // overrides the default. `--no-install` (or `--install ""`) skips
            // cloud-init entirely (vanilla Ubuntu, password auth on). With no
            // flag at all, the server defaults to OpenClaw — same behavior the
            // CLI has shipped since v0.5.
            const installRaw = flags.install
            let installRequested: string[] | undefined
            if (installRaw === false) {
              // `--no-install` → empty array (vanilla Ubuntu).
              installRequested = []
            } else if (typeof installRaw === 'string') {
              installRequested = installRaw.split(',').map(s => s.trim()).filter(Boolean)
            } // else: leave undefined → server keeps the legacy default.

            // --location overrides the server's default datacenter. Server
            // pre-validates type+location compatibility BEFORE x402 settles,
            // so a typo or mismatch fails as 400 with a clear hint instead
            // of burning $6 on Hetzner's 422.
            const location = flags.location as string | undefined

            const spin = new Spinner()
            spin.start('Deploying VPS...')
            let data: any
            try {
              data = await ao.computeDeploy(name, type, {
                ...(sshPublicKey ? { sshPublicKey } : {}),
                ...(sshKeyIds ? { sshKeyIds } : {}),
                ...(installRequested !== undefined ? { install: installRequested } : {}),
                ...(location ? { location } : {}),
              })
            } catch (e: any) {
              spin.stop('VPS deploy failed', false)
              // Specific server-side validation errors map to BAD_INPUT (2)
              // so shell scripts can branch — they're user-fixable, not
              // transient or payment-related.
              const msg = String(e?.message || '')
              if (/install recipe/i.test(msg)) {
                err(`${e.message} Run \`palmyr compute install-recipes --json\` to list available recipes.`, EXIT.BAD_INPUT)
              }
              if (/Type not available in location|Invalid location/i.test(msg)) {
                err(`${e.message} Run \`palmyr compute locations --json\` to see what's deployable where.`, EXIT.BAD_INPUT)
              }
              if (/Invalid server name/i.test(msg)) {
                err(`${e.message}`, EXIT.BAD_INPUT)
              }
              throw e
            }
            spin.stop('VPS deployed', true)

            // Golden-path default: --wait is ON unless the user explicitly opts
            // out (`--no-wait`). The deploy contract is "return when SSH
            // works", and a plain `compute deploy` without --wait was a frequent
            // foot-gun (looks successful, isn't yet usable). Users who want
            // fire-and-forget deploys should pass --no-wait explicitly.
            const wantWait = flags.wait !== false
            // The marker file gate (gate 4) only runs when the deploy actually
            // requested an install. Use whatever the SERVER echoed back —
            // `data.installs` reflects the resolved list (including any legacy
            // default), independent of what the CLI inferred.
            const expectedInstalls: string[] = Array.isArray(data?.installs) ? data.installs : []
            // Bigger default budget when an install is in flight. Hermes pulls
            // Python 3.11 + a couple hundred MB of pip packages on a fresh box;
            // 240s is too tight, 600s is comfortable.
            const defaultTimeout = expectedInstalls.length > 0 ? 600 : 240
            const waitTimeoutSec = flags['wait-timeout']
              ? Math.max(30, Math.min(900, parseInt(String(flags['wait-timeout']), 10)))
              : defaultTimeout
            // Resolve the local key path for the SSH credential probe. Only
            // available when the user supplied a key on disk (--pubkey-file or
            // --generate-ssh-key) OR explicitly told us where the matching
            // private key lives (--key-path) when using --ssh-key <id>.
            const explicitKeyPath = (flags['key-path'] as string) || (flags['private-key'] as string)
            const localKeyPath = generatedKeyMeta?.privateKeyPath
              || (pubkeyFile ? pubkeyFile.replace(/\.pub$/, '').replace('~', homedir()) : undefined)
              || (explicitKeyPath ? explicitKeyPath.replace('~', homedir()) : undefined)

            // --ssh-key <id> uploads a server-side key but doesn't tell us where
            // the matching private key lives on this machine. Without
            // --key-path, the SSH readiness gate later silently skips and the
            // deploy reports `ssh: skipped` while still marking the server as
            // "ready" — a real foot-gun (dogfood report 2026-05-25 hit this
            // exact path). Be loud about it now, before anyone pays.
            if (sshKeyIds && !localKeyPath) {
              const msg =
                'Warning: --ssh-key <id> uploaded the public key server-side, ' +
                'but no matching private key was passed to this CLI. ' +
                'SSH readiness cannot be verified locally — `compute wait` and the ' +
                'inline --wait check will skip the SSH gate. Pass ' +
                '`--key-path /path/to/private_key` (or `--private-key`) to ' +
                'enable the verification.'
              if (AGENT_MODE) {
                process.stderr.write(JSON.stringify({ event: 'warning', code: 'ssh_key_no_local_key', message: msg }) + '\n')
              } else {
                process.stderr.write(`\n${msg}\n\n`)
              }
            }

            // Progress events to stderr — default ON in agent mode so a
            // long deploy isn't a 10-minute silence. Pass --no-progress to
            // opt out. Stdout still gets one final JSON object, so jq
            // pipelines on stdout aren't disturbed either way.
            //
            // We only emit when --wait is in effect; without --wait the
            // deploy returns immediately and stdout already has everything,
            // so stderr noise would be redundant.
            const wantProgress = flags.progress !== false
            const emitProgress = (event: { stage: string; message: string }) => {
              if (AGENT_MODE && wantProgress) {
                process.stderr.write(JSON.stringify({ event: 'progress', ...event }) + '\n')
              }
            }
            // Emit a `created` ack right after the deploy returns from the
            // API, before the readiness chain starts. Agents watching
            // stderr now know the server got provisioned within seconds —
            // any subsequent silence is the install running, not us hung.
            if (AGENT_MODE && wantProgress && data?.ipv4) {
              process.stderr.write(JSON.stringify({
                event: 'created',
                id: data.id,
                name: data.name,
                ipv4: data.ipv4,
                installs: expectedInstalls,
                waitTimeoutSec,
              }) + '\n')
            }

            // Persist a local cache entry IMMEDIATELY — before the readiness
            // chain. Issue #85: if --wait hangs/times out, a follow-up
            // `compute wait <id>` or `compute ssh <id>` would otherwise find
            // nothing in cache and silently skip the SSH + install gates.
            // Saving here means the cache always has the server's IP, name,
            // and key path, even when the wait portion of the deploy fails.
            try {
              csshMod.saveDeployedServer({
                id: String(data.id || ''),
                name: String(data.name || name),
                ipv4: data.ipv4 ?? null,
                serverType: String(data.serverType || type),
                sshPrivateKeyPath: localKeyPath && existsSync(localKeyPath) ? localKeyPath : undefined,
                sshKeyIds,
                deployedAt: new Date().toISOString(),
              })
            } catch {}

            let finalData: any = data
            let readiness: any = undefined
            if (wantWait && data?.id) {
              const spin2 = new Spinner()
              spin2.start('Waiting: status=running…')
              const result = await csshMod.waitForReady({
                getStatus: async () => {
                  const s = await ao.computeGet(String(data.id))
                  return { status: s.status || 'unknown', ipv4: s.ipv4 ?? null }
                },
                keyPath: localKeyPath && existsSync(localKeyPath) ? localKeyPath : undefined,
                timeoutMs: waitTimeoutSec * 1000,
                expectedInstalls,
                onProgress: ev => {
                  spin2.update(`Waiting: ${ev.message}`)
                  emitProgress(ev)
                },
              })
              readiness = {
                ready: result.ready,
                checks: result.checks,
                elapsedMs: result.elapsedMs,
                ...(result.skipReasons ? { skipReasons: result.skipReasons } : {}),
                ...(result.reason ? { reason: result.reason } : {}),
                ...(result.installStatus ? { installStatus: result.installStatus } : {}),
                ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
              }
              if (result.ready) {
                const passed = ['status=running', 'port22=open']
                if (result.checks.ssh === 'pass') passed.push('ssh=verified')
                if (result.checks.installs === 'pass') passed.push(`installs=${expectedInstalls.join('+')}`)
                spin2.stop(`Server ready in ${(result.elapsedMs / 1000).toFixed(1)}s (${passed.join(', ')})`, true)
              } else {
                spin2.stop(`Wait incomplete: ${result.reason}`, false)
              }
              finalData = {
                ...data,
                status: result.status ?? data.status,
                ipv4: result.ip ?? data.ipv4,
              }
            }

            // Refresh the cache entry if --wait found a different IP than
            // the create call returned (Hetzner sometimes assigns the v4
            // post-provisioning). Only fires when wait actually ran;
            // otherwise the pre-wait save above is already authoritative.
            if (wantWait && finalData.ipv4 !== data.ipv4) {
              try {
                csshMod.saveDeployedServer({
                  id: String(finalData.id || data.id || ''),
                  name: String(finalData.name || data.name || name),
                  ipv4: (finalData.ipv4 || data.ipv4) ?? null,
                  serverType: String(finalData.serverType || data.serverType || type),
                  sshPrivateKeyPath: localKeyPath && existsSync(localKeyPath) ? localKeyPath : undefined,
                  sshKeyIds,
                  deployedAt: new Date().toISOString(),
                })
              } catch {}
            }

            // Surface where the generated key landed in the response so users
            // (especially agents in non-TTY runs) know what to ssh -i. When we
            // know a working key, also include a top-level `sshCommand` —
            // that's the literal "usable SSH command" the deploy contract
            // promises when --wait succeeds.
            const ip = finalData.ipv4 || data.ipv4
            if (generatedKeyMeta) {
              finalData = {
                ...finalData,
                generatedKey: {
                  privateKeyPath: generatedKeyMeta.privateKeyPath,
                  publicKeyPath: generatedKeyMeta.publicKeyPath,
                  hint: `ssh -i "${generatedKeyMeta.privateKeyPath}" root@${ip || '<ip>'}`,
                },
              }
            }
            if (localKeyPath && ip) {
              finalData.sshCommand = csshMod.buildSshCommand(ip, localKeyPath)
            }
            if (readiness) finalData.readiness = readiness
            return print(finalData)
          }
          case 'wait': {
            // `compute wait <name|id> [--key <path>] [--wait-timeout <sec>] [--install <name>]`
            // — run the readiness chain against an existing server. Useful when
            // the user deployed without --wait, or the deploy --wait timed out
            // and they want to retry without redeploying. Pass --install to
            // also gate on the install marker file (gate 4).
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: palmyr compute wait <name|id> [--key <path>] [--wait-timeout <sec>] [--install hermes,...]', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            // Resolve the server id — cache first (to skip a paid round-trip
            // when possible), but accept a numeric arg as the id directly.
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache. Pass the numeric id as the first arg, or run 'palmyr compute list' to refresh.`, EXIT.NOT_FOUND)
            const explicitKeyPath = (flags.key as string) || (flags['key-path'] as string) || (flags['private-key'] as string)
            const keyPath = (explicitKeyPath ? explicitKeyPath.replace('~', homedir()) : cached?.sshPrivateKeyPath)
            const installRaw = flags.install
            const expectedInstalls: string[] = typeof installRaw === 'string'
              ? installRaw.split(',').map(s => s.trim()).filter(Boolean)
              : []
            const defaultTimeout = expectedInstalls.length > 0 ? 600 : 240
            const waitTimeoutSec = flags['wait-timeout']
              ? Math.max(30, Math.min(900, parseInt(String(flags['wait-timeout']), 10)))
              : defaultTimeout
            const wantProgressWait = flags.progress !== false
            const spin = new Spinner()
            spin.start('Probing readiness…')
            const result = await csshMod.waitForReady({
              getStatus: async () => {
                const s = await ao.computeGet(serverId)
                return { status: s.status || 'unknown', ipv4: s.ipv4 ?? null }
              },
              keyPath: keyPath && existsSync(keyPath) ? keyPath : undefined,
              timeoutMs: waitTimeoutSec * 1000,
              expectedInstalls,
              onProgress: ev => {
                spin.update(`Probing: ${ev.message}`)
                if (AGENT_MODE && wantProgressWait) {
                  process.stderr.write(JSON.stringify({ event: 'progress', ...ev }) + '\n')
                }
              },
            })
            spin.stop(result.ready ? `Ready in ${(result.elapsedMs / 1000).toFixed(1)}s` : `Not ready: ${result.reason}`, result.ready)
            const out: any = {
              id: serverId,
              ready: result.ready,
              status: result.status,
              ipv4: result.ip,
              checks: result.checks,
              elapsedMs: result.elapsedMs,
              ...(result.skipReasons ? { skipReasons: result.skipReasons } : {}),
              ...(result.reason ? { reason: result.reason } : {}),
              ...(result.installStatus ? { installStatus: result.installStatus } : {}),
              ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
            }
            if (keyPath && result.ip) out.sshCommand = csshMod.buildSshCommand(result.ip, keyPath)
            // Exit with NOT_FOUND if any gate failed so shell scripts can
            // branch on $?. Stdout still gets the full report so callers
            // capturing JSON can inspect which check tripped.
            if (!result.ready) {
              print(out)
              process.exit(EXIT.NOT_FOUND)
            }
            return print(out)
          }
          case 'install-recipes':
          case 'recipes': {
            // Free discovery endpoint — list available agent install recipes.
            // Agents call this to know what they can pass to --install.
            const data = await ao.computeInstallRecipes()
            return print(data)
          }
          case 'ssh': {
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: palmyr compute ssh <name|id>', EXIT.BAD_INPUT)
            // Local cache first — free, instant. Server-side fallback is
            // available but not auto-triggered: it would cost 0.01 USDC and
            // we'd rather make the user opt in than charge them silently.
            const cached = csshMod.findCachedServer(target)
            if (!cached?.ipv4) {
              err(
                `Server "${target}" not in local cache. ` +
                `Either run 'palmyr compute list --json' first, ` +
                `or use the explicit IP: ssh root@<ip>.`,
                EXIT.NOT_FOUND,
              )
            }
            const keyPath = cached.sshPrivateKeyPath || (flags.key as string) || (flags.identity as string)
            if (AGENT_MODE) {
              return print({
                id: cached.id,
                name: cached.name,
                ipv4: cached.ipv4,
                command: csshMod.buildSshCommand(cached.ipv4!, keyPath),
                privateKeyPath: keyPath,
              })
            }
            // TTY mode: hand the terminal over to ssh and exit with its code.
            const code = csshMod.spawnInteractiveSsh(cached.ipv4!, keyPath)
            process.exit(code)
          }
          case 'setup-ssh': {
            const id = (flags.id as string) || positional[0]
            if (!id) err('--id SERVER_ID required (or pass it as the first positional arg)', EXIT.BAD_INPUT)
            let pubkey = (flags.pubkey as string) || (flags.publicKey as string)
            const pubkeyFile = (flags['pubkey-file'] as string) || (flags['ssh-key-file'] as string)
            if (!pubkey && pubkeyFile) {
              try {
                pubkey = readFileSync(pubkeyFile.replace('~', homedir()), 'utf8').trim()
              } catch (e: any) {
                err(`Could not read --pubkey-file ${pubkeyFile}: ${e.message}`, EXIT.NOT_FOUND)
              }
            }
            if (!pubkey) err('--pubkey "ssh-ed25519 AAAA..." (or --pubkey-file ~/.ssh/id_ed25519.pub) required', EXIT.BAD_INPUT)
            const data = await ao.computeSetupSsh(id, pubkey)
            return print(data)
          }
          case 'list': {
            const data = await ao.computeList()
            return print(data)
          }
          case 'renew': {
            // Accepts a friendly name from the local cache or a numeric
            // Hetzner id, same as rename/exec.
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: palmyr compute renew <name|id>', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache. Pass the numeric id, or run 'palmyr compute list' to refresh.`, EXIT.NOT_FOUND)
            const data = await ao.computeRenew(serverId)
            return print(data)
          }
          case 'restore': {
            // A terminated server is gone from the local cache's point of
            // view, so this one takes the numeric id straight from the
            // termination notice.
            const id = (flags.id as string) || positional[0]
            if (!id) err('Usage: palmyr compute restore <id>', EXIT.BAD_INPUT)
            const data = await ao.computeRestore(id)
            return print(data)
          }
          case 'delete': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id SERVER_ID required')
            if (!flags.confirm) {
              err(
                `This permanently destroys server "${id}" and all its data. Hetzner billing stops, but the disk is wiped and cannot be recovered.\n\n` +
                '  Re-run with --confirm to proceed:\n' +
                `  palmyr compute delete ${id} --confirm`,
                EXIT.BAD_INPUT,
              )
            }
            const data = await ao.computeDelete(id)
            try {
              const csshMod = await import('./compute-ssh.js')
              csshMod.removeCachedServer(id)
            } catch {}
            return print(data)
          }
          case 'rename': {
            // `compute rename <name|id> <new-name>` — wraps PUT /servers/:id.
            // We resolve the source from the local cache (so the user can
            // refer to a friendly name) but if it's a numeric Hetzner id we
            // accept that directly. The server validates the new name
            // pre-payment so an invalid one bounces as 400 without charging.
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            const newName = positional[1] || (flags.to as string) || (flags['new-name'] as string)
            if (!target || !newName) {
              err('Usage: palmyr compute rename <name|id> <new-name>', EXIT.BAD_INPUT)
            }
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache. Pass numeric Hetzner id or run 'palmyr compute list' first.`, EXIT.NOT_FOUND)
            let data: any
            try {
              data = await ao.computeRename(serverId, newName)
            } catch (e: any) {
              const msg = String(e?.message || '')
              if (/Invalid server name/i.test(msg)) {
                err(msg, EXIT.BAD_INPUT)
              }
              throw e
            }
            // Preserve the rest of the cache entry (ipv4, key path, sshKeyIds,
            // deployedAt) — only the name changes. Use the OLD cached entry
            // as the base, drop both the old name and the old id-keyed entry,
            // then write the renamed one.
            try {
              if (cached) {
                csshMod.removeCachedServer(cached.id)
                csshMod.saveDeployedServer({ ...cached, name: data.name || newName })
              }
            } catch {}
            return print(data)
          }
          case 'exec': {
            // Usage: palmyr compute exec <name|id> -- <command> [args...]
            // Or:    palmyr compute exec <name|id> --command "..." --arg "..." --arg "..."
            // The double-dash form is the natural one for shells that already
            // know how to split argv; the explicit form lets agents that build
            // arrays JSON-encode args without shell-splitting.
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: palmyr compute exec <name|id> -- <command> [args...]', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache. Pass numeric id, or run 'palmyr compute list' first.`, EXIT.NOT_FOUND)

            // Pull command + args from the remaining argv after the target.
            // Bare `--` is a conventional separator; argv after it is treated
            // as remote-shell argv.
            let command: string | undefined
            let args: string[] = []
            const rest = positional.slice(1)
            if (rest.length > 0) {
              command = rest[0]
              args = rest.slice(1)
            } else if (flags.command) {
              command = String(flags.command)
              const argFlag = flags.arg
              args = Array.isArray(argFlag) ? argFlag.map(String) : argFlag ? [String(argFlag)] : []
            }
            if (!command) err('No command. Try: palmyr compute exec my-vps -- systemctl status openclaw', EXIT.BAD_INPUT)
            const timeoutSec = flags.timeout ? Math.max(1, Math.min(120, parseInt(String(flags.timeout), 10))) : undefined
            const data = await ao.computeExec(serverId, command, args, timeoutSec ? { timeoutSec } : {})
            return print(data)
          }
          case 'reset-password':
          case 'reset_password': {
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: palmyr compute reset-password <name|id>', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache.`, EXIT.NOT_FOUND)
            const data = await ao.computeAction(serverId, 'reset_password')
            return print(data)
          }
          case 'console':
          case 'request-console': {
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err('Usage: palmyr compute console <name|id>', EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache.`, EXIT.NOT_FOUND)
            const data = await ao.computeAction(serverId, 'request_console')
            return print(data)
          }
          case 'reboot':
          case 'poweroff':
          case 'poweron':
          case 'reset':
          case 'rebuild': {
            const csshMod = await import('./compute-ssh.js')
            const target = positional[0] || (flags.id as string) || (flags.name as string)
            if (!target) err(`Usage: palmyr compute ${subcommand} <name|id>`, EXIT.BAD_INPUT)
            const cached = csshMod.findCachedServer(target)
            const serverId = cached?.id || (/^\d+$/.test(target) ? target : null)
            if (!serverId) err(`Server "${target}" not in local cache.`, EXIT.NOT_FOUND)
            // `rebuild` re-images the server from scratch — every byte on disk is
            // destroyed. Gate it behind --confirm like the other irreversible
            // siblings. reboot/poweroff/poweron/reset are recoverable, so they
            // stay one-shot.
            if (subcommand === 'rebuild' && !flags.confirm) {
              err(
                `This re-images server "${target}" from a fresh OS image — ALL data on disk is destroyed irreversibly.\n\n` +
                '  Re-run with --confirm to proceed:\n' +
                `  palmyr compute rebuild ${target} --confirm`,
                EXIT.BAD_INPUT,
              )
            }
            const opts = subcommand === 'rebuild' && flags.image ? { image: String(flags.image) } : {}
            const data = await ao.computeAction(serverId, subcommand, opts)
            return print(data)
          }
          default: err(`Unknown compute command: ${subcommand}. Try: plans, locations, install-recipes, ssh-key, deploy, wait, ssh, exec, rename, reset-password, console, reboot, poweroff, poweron, reset, rebuild, setup-ssh, list, delete`)
        }
        break
      }

      case 'card': {
        if (!subcommand || (flags.help && !CARD_HELP[subcommand])) {
          showMenu({
            command: 'card',
            title: 'card',
            subtitle: 'Prepaid Visa cards with exact balances',
            footerLeft: 'Card operations',
            commands: [
              { name: 'buy', description: 'Buy a USA prepaid Visa card', hint: '--amount 20' },
              { name: 'list', description: 'List your cards (status, last4, balance)', hint: '' },
              { name: 'get', description: 'Card number / CVV / expiry (owner-only)', hint: '--id <card_id>' },
              { name: 'refresh', description: 'Live balance + transactions', hint: '--id <card_id>' },
            ],
            fromHome,
          })
          break
        }
        if (flags.help && subcommand && CARD_HELP[subcommand]) {
          subcommandHelp('card', subcommand, CARD_HELP[subcommand])
          break
        }
        switch (subcommand) {
          case 'buy': {
            const amount = Number(flags.amount ?? positional[0])
            if (!Number.isFinite(amount) || amount <= 0) err('--amount <usd> required (e.g. palmyr card buy --amount 20)')
            const noWait = flags.wait === false
            const skipDetails = flags.details === false
            const ndjson = AGENT_MODE
            const spin = new Spinner()
            spin.start(`Buying $${amount} prepaid card...`)

            const initial = await ao.cardBuy(amount)
            const opId = initial?.operation_id || initial?.card_id
            if (!opId) {
              spin.stop('Unexpected response', false)
              return print(initial)
            }
            const pollUrl = initial.poll_url || `/cards/operations/${opId}`
            const pollAfter = Math.max(1, Number(initial.poll_after_seconds) || 3)

            if (noWait) {
              spin.stop('Card purchase started', true)
              log(`card buy (async): $${amount} op=${opId}`)
              if (AGENT_MODE) return print(initial)
              render(React.createElement(SuccessScreen, {
                version: VERSION,
                title: 'Card purchase started',
                subtitle: `$${amount} prepaid Visa`,
                footerLeft: 'Polling skipped (--no-wait)',
                details: [
                  { label: 'Card', value: String(opId) },
                  { label: 'Poll', value: `GET ${pollUrl} (free)` },
                  { label: 'Status', value: initial.status || 'pending' },
                ],
              }))
              break
            }

            // Poll loop — the poll route is FREE, so a tight ~3s cadence is
            // fine. Cards are typically ready in ~10s; cap at 90s.
            const POLL_TIMEOUT_MS = 90_000
            const intervalMs = pollAfter * 1000
            const deadline = Date.now() + POLL_TIMEOUT_MS
            const maxAttempts = Math.ceil(POLL_TIMEOUT_MS / intervalMs) + 1
            const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

            let final: any = null
            let attempt = 0
            while (attempt < maxAttempts && Date.now() < deadline) {
              await sleep(intervalMs)
              attempt++
              let op: any
              try {
                op = await ao.cardOperation(opId)
              } catch (e: any) {
                if (ndjson) process.stderr.write(JSON.stringify({ event: 'poll', status: 'error', attempt, message: e?.message ?? String(e) }) + '\n')
                else spin.update(`polling… (attempt ${attempt}, retrying after error)`)
                continue
              }
              const status = op?.status || 'pending'
              if (ndjson) process.stderr.write(JSON.stringify({ event: 'poll', status, attempt }) + '\n')
              else spin.update(`${status}… (attempt ${attempt})`)
              if (op?.done === true || status === 'ready' || status === 'failed') {
                final = op
                break
              }
            }

            if (!final) {
              spin.stop('Still provisioning — purchase continues server-side', false)
              log(`card buy (pending): $${amount} op=${opId}`)
              const pendingOut = {
                operation_id: opId,
                card_id: opId,
                status: 'pending',
                done: false,
                poll_url: pollUrl,
                message: `Timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s of polling. The purchase continues server-side — re-check with GET ${pollUrl} (free), then fetch details with: palmyr card get --id ${opId}`,
              }
              if (AGENT_MODE) return print(pendingOut)
              render(React.createElement(SuccessScreen, {
                version: VERSION,
                title: 'Card still provisioning',
                subtitle: `$${amount} prepaid Visa`,
                footerLeft: 'Re-check later — it continues server-side',
                details: [
                  { label: 'Card', value: String(opId) },
                  { label: 'Poll', value: `GET ${pollUrl}` },
                ],
              }))
              break
            }

            if (final.status === 'failed') {
              spin.stop('Card purchase failed', false)
              log(`card buy (failed): $${amount} op=${opId} refund=${final.refund_status || 'unknown'}`)
              if (AGENT_MODE) {
                print(final)
                process.stderr.write(JSON.stringify({ error: final.error || 'card purchase failed', error_code: final.error_code, refund_status: final.refund_status, exitCode: EXIT.GENERAL }) + '\n')
                process.exit(EXIT.GENERAL)
              }
              const refundLine = final.refund_status === 'sent'
                ? 'Refund sent automatically'
                : final.refund_status === 'manual_needed'
                  ? 'Refund needs manual review — contact support'
                  : final.refund_status === 'failed'
                    ? 'Automatic refund failed — contact support'
                    : 'Refund status unknown'
              render(React.createElement(ErrorScreen, {
                version: VERSION,
                title: 'Card purchase failed',
                message: `${final.error || 'Purchase failed'}${final.error_code ? ` (${final.error_code})` : ''}. ${refundLine}.`,
                footerLeft: refundLine,
              }))
              process.exit(EXIT.GENERAL)
            }

            // ── Ready. Fetch the actual card details (0.01 USDC) unless opted out.
            spin.stop(`Card ready — $${final.available_balance ?? amount} loaded`, true)
            log(`card buy: $${amount} op=${opId} last4=${final.last4 || '????'}`)
            if (skipDetails) {
              const out = { ...final, message: `Card ready. Fetch the number with: palmyr card get --id ${opId}` }
              if (AGENT_MODE) return print(out)
              render(React.createElement(SuccessScreen, {
                version: VERSION,
                title: 'Card ready',
                subtitle: `$${amount} prepaid Visa •••• ${final.last4 || ''}`,
                footerLeft: 'US merchants only · non-reloadable',
                details: [
                  { label: 'Card', value: String(opId) },
                  { label: 'Details', value: `palmyr card get --id ${opId}` },
                ],
              }))
              break
            }
            const details = await ao.cardGet(String(opId))
            if (AGENT_MODE) return print(details)
            const c = details?.card || {}
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Card ready',
              subtitle: `$${details.available_balance ?? amount} prepaid Visa`,
              footerLeft: 'US merchants only · non-reloadable · spend until depleted',
              details: [
                { label: 'Number', value: String(c.card_number || '') },
                { label: 'Expiry', value: `${c.exp_month || '??'}/${c.exp_year || '????'}` },
                { label: 'CVV', value: String(c.cvv || '') },
                ...(c.billing_address ? [{ label: 'Billing', value: billingLine(c.billing_address) }] : []),
                { label: 'Balance', value: `$${details.available_balance ?? amount}` },
                { label: 'Card id', value: String(opId) },
              ],
            }))
            break
          }
          case 'list': {
            const data = await ao.cardList()
            if (AGENT_MODE) return print(data)
            const cards = data?.cards || []
            console.log(`\n  ${t.accent}your cards${t.reset} — ${t.muted}${data.owner}${t.reset}\n`)
            if (cards.length === 0) {
              console.log(`  ${t.muted}No cards yet. Try: palmyr card buy --amount 20${t.reset}\n`)
              return
            }
            for (const r of cards) {
              const statusColor = r.status === 'ready' ? t.success : r.status === 'failed' ? t.error : t.warn
              const last4 = r.last4 ? `•••• ${r.last4}` : '•••• ····'
              const bal = r.available_balance != null ? `$${r.available_balance}` : '—'
              console.log(`  ${last4}  ${statusColor}${(r.status + '          ').slice(0, 12)}${t.reset} ${t.warn}${bal.padStart(9)}${t.reset}  ${t.muted}${r.card_id}${t.reset}`)
            }
            console.log(`\n  ${t.muted}${cards.length} card(s)${t.reset}\n`)
            return
          }
          case 'get': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id <card_id> required')
            const data = await ao.cardGet(id)
            if (AGENT_MODE) return print(data)
            if (data?.status && data.status !== 'ready') {
              console.log(`\n  ${t.warn}Card not ready${t.reset} — status: ${data.status}${data.error ? ` (${data.error})` : ''}\n`)
              return
            }
            const c = data?.card || {}
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Card details',
              subtitle: `$${data.available_balance ?? data.card_usd} prepaid Visa`,
              footerLeft: 'US merchants only · non-reloadable',
              details: [
                { label: 'Number', value: String(c.card_number || '') },
                { label: 'Expiry', value: `${c.exp_month || '??'}/${c.exp_year || '????'}` },
                { label: 'CVV', value: String(c.cvv || '') },
                ...(c.billing_address ? [{ label: 'Billing', value: billingLine(c.billing_address) }] : []),
                { label: 'Balance', value: `$${data.available_balance ?? '—'}` },
              ],
            }))
            break
          }
          case 'refresh': {
            const id = flags.id as string || positional[0]
            if (!id) err('--id <card_id> required')
            const data = await ao.cardRefresh(id)
            if (AGENT_MODE) return print(data)
            console.log(`\n  ${t.accent}card balance${t.reset} — ${t.warn}$${data.available_balance ?? '—'}${t.reset}${data.hint ? `\n  ${t.muted}${data.hint}${t.reset}` : ''}\n`)
            const txs = data?.transactions || []
            for (const tx of txs.slice(0, 15)) {
              const amt = tx.is_credit ? `+$${tx.amount}` : `-$${tx.amount}`
              console.log(`  ${(tx.date || '').slice(0, 10)}  ${tx.is_credit ? t.success : t.error}${amt.padStart(10)}${t.reset}  ${t.muted}${tx.description || tx.merchant || ''}${t.reset}`)
            }
            if (txs.length) console.log(`\n  ${t.muted}${txs.length} transaction(s)${t.reset}\n`)
            return
          }
          default:
            err(`Unknown card subcommand: ${subcommand}. Try: buy, list, get, refresh`)
        }
        break
      }
      case 'domain': {
        if (!subcommand || (flags.help && !DOMAIN_HELP[subcommand])) {
          showMenu({
            command: 'domain',
            title: 'domain',
            subtitle: 'Naming and DNS',
            footerLeft: 'Domain operations',
            commands: [
              { name: 'check', description: 'Check availability', hint: '--name example.dev' },
              { name: 'pricing', description: 'Get TLD pricing', hint: '--name example' },
              { name: 'buy', description: 'Register a domain', hint: '--name example.dev' },
              { name: 'list', description: 'List domains owned or shared with your wallet', hint: '' },
              { name: 'dns', description: 'Read DNS records', hint: '--name example.dev' },
              { name: 'dns set', description: 'Replace all DNS records', hint: '--name example.dev --records \'[...]\'' },
              { name: 'dns add', description: 'Add or update one record, keep the rest', hint: '--name example.dev --type A --host www --value 1.2.3.4' },
              { name: 'transfer-ownership', description: 'Transfer domain to another wallet', hint: '--name example.dev --to <wallet>' },
              { name: 'share', description: 'Grant another wallet shared access', hint: '--name example.dev --with <wallet>' },
              { name: 'unshare', description: 'Revoke a wallet’s shared access', hint: '--name example.dev --from <wallet>' },
            ],
            fromHome,
          })
          break
        }
        if (flags.help && subcommand && DOMAIN_HELP[subcommand]) {
          subcommandHelp('domain', subcommand, DOMAIN_HELP[subcommand])
          break
        }
        switch (subcommand) {
          case 'check': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.com required')
            const data = await ao.domainCheck(name)
            // Multi-TLD response: render a table when interactive, JSON otherwise.
            if (Array.isArray(data?.results)) {
              if (AGENT_MODE) return print(data)
              console.log(`\n  ${t.accent}domain check${t.reset} — ${t.info}${data.query}${t.reset}\n`)
              const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length))
              const dLen = Math.max(...data.results.map((r: any) => r.domain.length), 6)
              for (const r of data.results) {
                const mark = r.available ? `${t.success}✓${t.reset}` : `${t.error}✗${t.reset}`
                const status = r.available ? `${t.success}available${t.reset}` : `${t.muted}taken${t.reset}    `
                const price = r.available ? `${t.warn}$${r.price}${t.reset}` : `${t.muted}—${t.reset}`
                console.log(`  ${mark}  ${pad(r.domain, dLen + 2)} ${status}   ${price}`)
              }
              console.log('')
              return
            }
            if (AGENT_MODE) return print(data)
            render(React.createElement(DomainCheckScreen, {
              version: VERSION,
              domain: name,
              available: !!data.available,
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.PALMYR_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'pricing': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain required')
            const data = await ao.domainPricing(name)
            if (AGENT_MODE) return print(data)
            const items = Object.entries(data.tlds || data.pricing || data).map(([tld, price]) => ({
              tld,
              price: String(price),
            }))
            render(React.createElement(DomainPricingScreen, {
              version: VERSION,
              query: name,
              items,
              interactive: fromHome,
              onBack: fromHome ? () => {
                process.env.PALMYR_FROM_HOME = '0'
                process.argv = [process.argv[0], process.argv[1]]
                void main()
              } : undefined,
            }))
            break
          }
          case 'buy': {
            const name = flags.name as string || positional[0]
            if (!name) err('--name domain.dev required')
            // Registration is async: POST returns 202 with an operation_id, and
            // the registrar order completes in the background. We poll the
            // operation to completion unless the caller opts out with --no-wait.
            // `--no-wait` parses to flags.wait === false (see the no- prefix in
            // parse()); default (undefined) means poll until done.
            const noWait = flags.wait === false
            const ndjson = AGENT_MODE // mirror compute/trade: NDJSON progress → stderr, final JSON → stdout
            const spin = new Spinner()
            spin.start('Registering domain...')

            const initial = await ao.domainBuy(name)

            // Legacy/sync path: a server that still returns 201 with the
            // registered domain and no operation_id is treated as already-done.
            const opId = initial?.operation_id
            const looksDone = initial?.done === true || initial?.status === 'active'
            if (!opId || looksDone) {
              spin.stop('Domain registered', true)
              const final = initial
              const domain = final?.domain || name
              addDomain({ domain, createdAt: new Date().toISOString() })
              log(`domain buy: ${domain}`)
              if (AGENT_MODE) return print(final)
              render(React.createElement(SuccessScreen, {
                version: VERSION,
                title: 'Domain registered',
                subtitle: domain,
                footerLeft: 'Domain secured',
                details: [{ label: 'Domain', value: domain }],
              }))
              break
            }

            // We have an async operation. Surface the handle so it's never lost,
            // even if polling times out or the user opted out.
            const pollUrl = initial.poll_url || `/domains/operations/${opId}`
            const pollAfter = Math.max(1, Number(initial.poll_after_seconds) || 5)

            if (noWait) {
              // Hand back the operation handle and exit cleanly. Registration
              // continues server-side; the user re-checks with the poll_url.
              spin.stop('Registration started', true)
              log(`domain buy (async): ${name} op=${opId}`)
              if (AGENT_MODE) return print(initial)
              render(React.createElement(SuccessScreen, {
                version: VERSION,
                title: 'Registration started',
                subtitle: name,
                footerLeft: 'Polling skipped (--no-wait)',
                details: [
                  { label: 'Domain', value: initial.domain || name },
                  { label: 'Operation', value: opId },
                  { label: 'Poll', value: `palmyr domain buy is async — GET ${pollUrl}` },
                  { label: 'Status', value: initial.status || 'pending' },
                ],
              }))
              break
            }

            // Poll loop. Hard caps prevent an infinite loop even if the server
            // never reports done: an overall ~120s deadline AND a max-attempt
            // ceiling derived from it. Each GET costs 0.01 USDC, so we keep the
            // interval at ~5s (don't hammer).
            const POLL_TIMEOUT_MS = 120_000
            const intervalMs = pollAfter * 1000
            const deadline = Date.now() + POLL_TIMEOUT_MS
            const maxAttempts = Math.ceil(POLL_TIMEOUT_MS / intervalMs) + 1
            const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

            let final: any = null
            let attempt = 0
            while (attempt < maxAttempts && Date.now() < deadline) {
              // Wait first — the server told us nothing is ready before
              // poll_after_seconds, so there's no point polling immediately.
              await sleep(intervalMs)
              attempt++
              let op: any
              try {
                op = await ao.domainOperation(opId)
              } catch (e: any) {
                // Transient poll failure (network/CDN). Don't abort the whole
                // registration over one bad GET — note it and keep polling
                // until the deadline.
                if (ndjson) process.stderr.write(JSON.stringify({ event: 'poll', status: 'error', attempt, message: e?.message ?? String(e) }) + '\n')
                else spin.update(`polling… (attempt ${attempt}, retrying after error)`)
                continue
              }
              const status = op?.status || 'pending'
              if (ndjson) process.stderr.write(JSON.stringify({ event: 'poll', status, attempt }) + '\n')
              else spin.update(`${status === 'registering' ? 'registering' : status}… (attempt ${attempt})`)
              if (op?.done === true || status === 'active' || status === 'failed') {
                final = op
                break
              }
            }

            // ── Timeout: still pending after the cap. Not a failure — the
            // registration continues server-side. Communicate the handle and
            // exit 0.
            if (!final) {
              spin.stop('Still pending — registration continues server-side', false)
              log(`domain buy (pending): ${name} op=${opId}`)
              const pendingOut = {
                operation_id: opId,
                status: 'pending',
                done: false,
                domain: initial.domain || name,
                poll_url: pollUrl,
                message: `Timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s of polling. Registration is still in progress — re-check with GET ${pollUrl}.`,
              }
              if (AGENT_MODE) return print(pendingOut)
              render(React.createElement(SuccessScreen, {
                version: VERSION,
                title: 'Registration still pending',
                subtitle: initial.domain || name,
                footerLeft: 'Re-check later — it continues server-side',
                details: [
                  { label: 'Operation', value: opId },
                  { label: 'Poll', value: `GET ${pollUrl}` },
                  { label: 'Status', value: 'pending' },
                ],
              }))
              break
            }

            // ── Failed: render the error + automatic-refund status. Exit with
            // the operation-failure code (EXIT.GENERAL — the convention used by
            // trade buy/sell and other async ops). The x402 payment itself
            // settled; the registrar order failed and was auto-refunded, so
            // EXIT.PAYMENT would be misleading here.
            if (final.status === 'failed' || (final.done === true && final.status !== 'active')) {
              spin.stop('Registration failed', false)
              log(`domain buy (failed): ${name} op=${opId} refund=${final.refund_status || 'unknown'}`)
              if (AGENT_MODE) {
                // Keep stdout a single clean final JSON object; signal failure
                // on stderr + via exit code (don't route through err(), which
                // would replace the final object on stdout).
                print(final)
                process.stderr.write(JSON.stringify({ error: final.error || 'domain registration failed', error_code: final.error_code, refund_status: final.refund_status, exitCode: EXIT.GENERAL }) + '\n')
                process.exit(EXIT.GENERAL)
              }
              const refundLine = final.refund_status === 'sent'
                ? 'Refund sent automatically'
                : final.refund_status === 'manual_needed'
                  ? 'Refund needs manual review — contact support'
                  : final.refund_status === 'failed'
                    ? 'Automatic refund failed — contact support'
                    : 'Refund status unknown'
              render(React.createElement(ErrorScreen, {
                version: VERSION,
                title: 'Domain registration failed',
                message: `${final.error || 'Registration failed'}${final.error_code ? ` (${final.error_code})` : ''}. ${refundLine}.`,
                footerLeft: refundLine,
              }))
              process.exit(EXIT.GENERAL)
            }

            // ── Success.
            spin.stop('Domain registered', true)
            const domain = final.domain || name
            addDomain({ domain, createdAt: new Date().toISOString() })
            log(`domain buy: ${domain}`)
            if (AGENT_MODE) return print(final)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Domain registered',
              subtitle: domain,
              footerLeft: 'Domain secured',
              details: [
                { label: 'Domain', value: domain },
                ...(final.expiresAt ? [{ label: 'Expires', value: String(final.expiresAt).slice(0, 10) }] : []),
              ],
            }))
            break
          }
          case 'list': {
            const data = await ao.domainList()
            if (AGENT_MODE) return print(data)
            const domains = data?.domains || []
            console.log(`\n  ${t.accent}your domains${t.reset} — ${t.muted}${data.owner}${t.reset}\n`)
            if (domains.length === 0) {
              console.log(`  ${t.muted}No domains yet. Try: palmyr domain buy --name example.xyz${t.reset}\n`)
              return
            }
            const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length))
            const dLen = Math.max(...domains.map((r: any) => r.domain.length), 6)
            for (const r of domains) {
              const exp = (r.expires_at || '').slice(0, 10)
              const statusColor = r.status === 'active' ? t.success : r.status === 'pending' ? t.warn : t.error
              console.log(`  ${pad(r.domain, dLen + 2)} ${statusColor}${pad(r.status, 8)}${t.reset} ${t.muted}expires ${exp}${t.reset}`)
            }
            console.log(`\n  ${t.muted}${domains.length} domain(s)${t.reset}\n`)
            return
          }
          case 'transfer-ownership': {
            const name = flags.name as string || positional[0]
            const to = flags.to as string || positional[1]
            if (!name) err('--name domain.dev required')
            if (!to) err('--to <wallet> required')
            if (!flags.confirm) {
              const tail = to.slice(-6)
              err(
                `This hands "${name}" to a wallet ending in …${tail}. You lose ownership immediately and irreversibly.\n\n` +
                '  Re-run with --confirm to proceed:\n' +
                `  palmyr domain transfer-ownership --name ${name} --to ${to} --confirm`,
                EXIT.BAD_INPUT,
              )
            }
            const data = await ao.domainTransferOwnership(name, to)
            return print(data)
          }
          case 'share': {
            const name = (flags.name as string) || positional[0]
            const withWallet = (flags.with as string) || (flags.wallet as string)
            if (!name) err('--name domain.dev required')
            if (!withWallet) err('--with <wallet> required')
            const data = await ao.domainShare(name, withWallet)
            log(`domain share: ${name} → ${withWallet}`)
            return print(data)
          }
          case 'unshare': {
            const name = (flags.name as string) || positional[0]
            const targetWallet = (flags.from as string) || (flags.wallet as string)
            if (!name) err('--name domain.dev required')
            if (!targetWallet) err('--from <wallet> required')
            const data = await ao.domainUnshare(name, targetWallet)
            log(`domain unshare: ${name} ✗ ${targetWallet}`)
            return print(data)
          }
          case 'dns': {
            // `dns` reads; `dns set` replaces the zone; `dns add` upserts one
            // row. The action, when present, takes the first positional slot,
            // so the domain shifts one along.
            const action = String(positional[0] || '').toLowerCase()
            const isWrite = action === 'set' || action === 'add'
            const name = (flags.name as string) || (isWrite ? positional[1] : positional[0])
            if (!name) err(`--name domain.dev required`)

            if (!isWrite) {
              if (action) {
                err(`Unknown dns action: ${action}. Use \`palmyr domain dns --name ${name}\` to read, or \`dns set\` / \`dns add\` to write.`)
              }
              const data = await ao.domainDns(name)
              if (AGENT_MODE) return print(data)
              // The read endpoint answers with the array at the top level; the
              // write endpoint wraps it in { records }. Normalise both.
              const records = dnsRecordsOf(data)
              render(React.createElement(RecordsScreen, {
                version: VERSION,
                title: 'domain dns',
                subtitle: name,
                footerLeft: `${records.length} record(s)`,
                records: records.map((r: any) => ({
                  primary: String(r.type || 'record'),
                  secondary: `${r.name || '@'} → ${r.value || ''}`,
                })),
              }))
              break
            }

            const parsed = parseDnsRecords(flags as any)
            if (!parsed.ok) err(parsed.error)
            const rows = parsed.records as DnsRecordInput[]
            let data: any
            if (action === 'add') {
              // Upsert each row in turn so several --records entries merge into
              // the zone instead of the last one winning.
              for (const r of rows) data = await ao.domainDnsAdd(name, r)
            } else {
              data = await ao.domainDnsSet(name, rows)
            }
            if (AGENT_MODE) return print(data)
            const written = dnsRecordsOf(data)
            render(React.createElement(RecordsScreen, {
              version: VERSION,
              title: `domain dns ${action}`,
              subtitle: name,
              footerLeft: `${written.length} record(s) now live`,
              records: written.map((r: any) => ({
                primary: String(r.type || 'record'),
                secondary: `${r.name || '@'} → ${r.value || ''}`,
              })),
            }))
            break
          }
          default: err(`Unknown domain command: ${subcommand}. Try: check, pricing, buy, list, dns, transfer-ownership, share, unshare`)
        }
        break
      }

      case 'wallet': {
        if (!subcommand || (flags.help && !WALLET_HELP[subcommand])) {
          showMenu({
            command: 'wallet',
            title: 'wallet',
            subtitle: 'Non-custodial HD wallet',
            footerLeft: 'Solana + Base wallet operations',
            commands: [
              { name: 'create', description: 'Create one or many wallets', hint: '[--tag X --count 100] [--solana|--base]' },
              { name: 'import', description: 'Import from mnemonic', hint: '--mnemonic "..." [--tag X]' },
              { name: 'list', description: 'List all wallets', hint: '[--tag <name>]' },
              { name: 'info', description: 'Wallet details', hint: 'WALLET_ID' },
              { name: 'addresses', description: 'Show all chain addresses', hint: 'WALLET_ID' },
              { name: 'tags', description: 'List wallet tags with counts' },
              { name: 'tag', description: 'Assign / change / clear a wallet tag', hint: 'WALLET_ID TAG | WALLET_ID --clear' },
              { name: 'tag-delete', description: 'Cascade-delete every wallet under a tag', hint: 'TAG --confirm' },
              { name: 'sign-message', description: 'Sign a message', hint: 'WALLET_ID --chain evm --msg "hello"' },
              { name: 'export', description: 'Export mnemonic for backup', hint: 'WALLET_ID --confirm' },
              { name: 'rekey', description: 'Add or rotate the passphrase fallback (durable across OS-keychain loss)', hint: 'WALLET_ID --passphrase <p>' },
              { name: 'register', description: 'Register this wallet as an agent on the server (signs a wallet-control proof) → aos_ token', hint: 'WALLET_ID [--name agent] [--chain solana|base]' },
              { name: 'api-key', description: 'Create agent API key', hint: 'WALLET_ID --name my-agent' },
              { name: 'config', description: 'Get agent config', hint: 'WALLET_ID' },
              { name: 'use', description: 'Set default pay wallet', hint: 'WALLET_ID' },
              { name: 'buy', description: 'Open a trading position', hint: 'solana <CA> --amount 0.5sol --thesis "..."' },
              { name: 'cohort', description: 'Split a buy across N derived wallets with jitter (Phase 4c)', hint: 'buy <CHAIN> <CA> --total ... --split N' },
              { name: 'template', description: 'Manage YAML strategy templates', hint: 'list | show <name> | path <name> | delete <name>' },
              { name: 'positions', description: 'List open (and optionally closed) positions', hint: '[--chain X] [--wallet Y] [--all] [--history]' },
              { name: 'position', description: 'Show details for a single position', hint: '<CA>' },
              { name: 'sell', description: 'Sell part or all of a position', hint: 'solana <CA> --percent 50 --reason "..."' },
              { name: 'sync', description: 'Reconcile open positions against chain, refresh unrealized PnL' },
              { name: 'pnl', description: 'Aggregate realized + unrealized PnL', hint: '[--by wallet|chain] [--since DATE]' },
              { name: 'journal', description: 'Append or read trade journal entries', hint: 'add <CA> --note "..." | show' },
              { name: 'watch', description: 'Maintain a watchlist of CAs to monitor', hint: 'add <CA> --trigger "..." | list' },
              { name: 'brief', description: 'Show thesis + PnL brief for a position', hint: '<CA>' },
              { name: 'doctor', description: 'Health check for the wallet-trading subsystem', hint: '[--wallet <ref>]' },
              { name: 'pay-preflight', description: 'Check the x402 pay flow is ready (chain, wallet, signing, USDC balance)', hint: '[--chain solana|base] [--min-usdc N]' },
              { name: 'smoke-test', description: 'End-to-end validation of wallet trading on Solana + Base', hint: '--wallet <ref> [--chain solana|base|all]' },
              { name: 'readiness', description: 'Go/no-go autonomous-trading readiness — sign, gas, quotes, daemon, open positions', hint: '--wallet <ref>' },
              { name: 'live-test', description: 'Execute tiny real round trips on Solana + Base, verify no leftover positions', hint: '--wallet <ref> --budget Nusdc [--chain ...]' },
              { name: 'daemon', description: 'Auto-monitor positions for trigger-based exits', hint: 'tick | start [--auto] | stop | status' },
              { name: 'triggers', description: 'List pending trigger fires from the daemon', hint: '[--ca X] [--since ISO] [--clear]' },
              { name: 'trading-keystore', description: 'Encrypted BIP39 keystore for HD-derived trading wallets', hint: 'init | list | status | derive | export' },
              { name: 'evm-quote', description: 'EVM swap quote via ParaSwap', hint: '<SRC> <DST> --amount <raw> [--chain base]' },
            ],
            fromHome,
          })
          break
        }

        // Per-subcommand --help
        if (flags.help && subcommand && WALLET_HELP[subcommand]) {
          subcommandHelp('wallet', subcommand, WALLET_HELP[subcommand])
          break
        }

        switch (subcommand) {
          case 'create': {
            const isManaged = !!flags.managed
            const tagRaw = (flags.tag as string | undefined) || undefined
            const countRaw = flags.count
            const count = countRaw !== undefined ? parseInt(String(countRaw), 10) : 1
            if (!Number.isFinite(count) || count < 1) err('--count must be a positive integer', EXIT.BAD_INPUT)

            // Chain filter: --solana / --base. Default (neither) → both chains.
            const wantSol = !!flags.solana
            const wantBase = !!flags.base
            const chains = (wantSol && !wantBase) ? ['solana' as const]
                         : (wantBase && !wantSol) ? ['base' as const]
                         : ['solana' as const, 'base' as const]

            // Passphrase resolution — recoverable-by-default.
            // Three paths:
            //   1. `--passphrase <p>` or `PALMYR_WALLET_PASSPHRASE` env → seal with scrypt
            //   2. `--session-only` → explicit opt-out, OS-keychain-only (warned)
            //   3. nothing + TTY → interactive prompt
            //   4. nothing + non-TTY → error with the three options
            // Session-only wallets are recoverable ONLY from this machine's OS
            // keychain; reboot / keyring change / host migration breaks them
            // permanently. We pushed agents into that foot-gun in 1.8.2 and
            // earlier; 1.8.3 forces the choice up front.
            const sessionOnly = !!flags['session-only']
            let passphrase = (flags.passphrase as string | undefined) || process.env.PALMYR_WALLET_PASSPHRASE || undefined
            let generatedPassphrase = false
            if (passphrase && sessionOnly) {
              err('Pass either --passphrase / PALMYR_WALLET_PASSPHRASE OR --session-only, not both.', EXIT.BAD_INPUT)
            }
            if (!passphrase && !sessionOnly) {
              if (process.stdin.isTTY) {
                const { promptNewPassphrase } = await import('./passphrase-prompt.js')
                if (!AGENT_MODE) process.stderr.write(
                  '\n  Wallet creation needs a passphrase fallback so the wallet survives a reboot / OS-keychain change / host migration.\n' +
                  '  (Re-run with --session-only to opt out — ephemeral wallets only.)\n\n'
                )
                passphrase = await promptNewPassphrase('vault wallet')
              } else {
                // Non-TTY (agent / piped stdin): the headline command must not
                // dead-end on a prompt we can't render. Auto-generate a
                // recoverable passphrase fallback and surface it in the output,
                // so the wallet survives a reboot / OS-keychain change / host
                // migration. `--session-only` stays the explicit opt-out.
                // Recoverable-by-default: the wallet is decryptable via this
                // phrase OR this machine's OS-keychain session secret.
                passphrase = randomBytes(24).toString('base64url')
                generatedPassphrase = true
                // LOUD, mode-independent recovery note (to stderr — never
                // pollutes --json stdout). Include the phrase itself so an agent
                // that only captures stderr still has it: a funded wallet must
                // not become unrecoverable just because stdout JSON was dropped.
                process.stderr.write(
                  '\n  No passphrase supplied — generated a recoverable fallback. SAVE IT:\n' +
                  `      ${passphrase}\n` +
                  '  The wallet is decryptable via this phrase OR this machine\'s OS keychain.\n' +
                  '  Re-run with --session-only to opt out of the fallback.\n\n'
                )
              }
            }

            // ─── Bulk path ───
            if (count > 1) {
              if (isManaged) err('Bulk wallet creation only supports unmanaged wallets — managed wallets need per-wallet passkey setup.', EXIT.BAD_INPUT)
              if (!tagRaw) err('--tag is required when --count > 1', EXIT.BAD_INPUT)
              if (count > 500) err('--count must be ≤ 500 per call', EXIT.BAD_INPUT)
              const prefix = (flags['name-prefix'] as string) || tagRaw

              const { createLocalWalletsBatch } = await import('./vault.js')
              const { storeSecretsBatch } = await import('./credential-store.js')

              // Progress to stderr so JSON on stdout stays clean
              if (!AGENT_MODE) process.stderr.write(`creating ${count} wallets under tag "${tagRaw}"${passphrase ? ' (+ passphrase fallback)' : ' (session-only)'}...\n`)
              const results = createLocalWalletsBatch(prefix, count, 'unmanaged', { tag: tagRaw, chains, passphrase })

              if (!AGENT_MODE) process.stderr.write(`sealing ${count} session secrets in OS credential store...\n`)
              // Keychain failure is non-fatal IFF a passphrase fallback was
              // written — the wallets are still recoverable via the env var.
              let keychainStoreWarning: string | null = null
              try {
                storeSecretsBatch(results.map(r => ({ account: r.id, secret: r.sessionSecret })))
              } catch (e: any) {
                if (passphrase) {
                  keychainStoreWarning = e?.message || 'keychain store failed'
                  if (!AGENT_MODE) process.stderr.write(`  warning: OS keychain unavailable (${keychainStoreWarning}); wallets remain decryptable via PALMYR_WALLET_PASSPHRASE\n`)
                } else {
                  throw e
                }
              }

              if (sessionOnly && !AGENT_MODE) emitSessionOnlyWarning(process.stderr.write.bind(process.stderr))
              log(`wallet create: ${count} wallets under tag "${tagRaw}" (chains=${chains.join(',')}, mode=${passphrase ? 'passphrase' : 'session-only'}${keychainStoreWarning ? ', keychain=failed' : ''})`)

              if (AGENT_MODE) {
                print({
                  count: results.length,
                  tag: tagRaw,
                  chains,
                  recoverable: !!passphrase,
                  ...(generatedPassphrase ? { recoveryPassphrase: passphrase } : {}),
                  ...(keychainStoreWarning ? { keychainWarning: keychainStoreWarning } : {}),
                  funding: {
                    note: 'Fund each wallet with USDC on Base or Solana (gas is sponsored). ~$3 minimum for a first paid action.',
                    verify: 'palmyr wallet pay-preflight --wallet <id>',
                  },
                  wallets: results.map(r => ({
                    id: r.id,
                    name: r.name,
                    mode: r.mode,
                    tag: r.tag,
                    chains: r.chains,
                    solana: r.solanaAddress,
                    base: r.evmAddress,
                  })),
                })
              } else {
                console.log(`\n  ${t.success}✔${t.reset} Created ${count} wallets under tag ${t.accent}${tagRaw}${t.reset}`)
                console.log(`  ${t.muted}chains:${t.reset} ${chains.join(', ')}`)
                console.log(`  ${t.muted}names: ${t.reset}${results[0].name} … ${results[results.length - 1].name}`)
                console.log(`  ${t.muted}recoverable:${t.reset} ${passphrase ? 'yes (passphrase fallback set)' : 'NO — session-only'}`)
                if (generatedPassphrase) {
                  console.log(`\n  ${t.warn}Recovery passphrase (save this):${t.reset} ${passphrase}`)
                  console.log(`  ${t.muted}Decrypts every wallet in this tag if the OS keychain is lost. Reuse via PALMYR_WALLET_PASSPHRASE.${t.reset}`)
                }
                console.log(`\n  ${t.muted}Fund with USDC on Base or Solana (gas sponsored) — ~$3 for a first paid action.${t.reset}`)
                console.log(`  ${t.muted}List them:    ${t.reset}palmyr wallet list --tag ${tagRaw}`)
                console.log(`  ${t.muted}Delete all:   ${t.reset}palmyr wallet tag-delete ${tagRaw} --confirm\n`)
              }
              break
            }

            // ─── Single-create path ───
            // Accept --name (primary) or --label (alias)
            const name = (flags.name as string) || (flags.label as string) || 'My Wallet'
            const mode = isManaged ? 'managed' as const : 'unmanaged' as const

            // Create locally — no server needed for the key material
            const { createLocalWallet } = await import('./vault.js')
            const w = createLocalWallet(name, mode, { tag: tagRaw, chains, passphrase })

            // Store session secret in OS credential store. Keychain failure is
            // non-fatal when a passphrase fallback was written.
            const { storeSecret } = await import('./credential-store.js')
            let keychainStoreWarning: string | null = null
            try {
              storeSecret(w.id, w.sessionSecret)
            } catch (e: any) {
              if (passphrase) {
                keychainStoreWarning = e?.message || 'keychain store failed'
                if (!AGENT_MODE) process.stderr.write(`  warning: OS keychain unavailable (${keychainStoreWarning}); wallet remains decryptable via PALMYR_WALLET_PASSPHRASE\n`)
              } else {
                throw e
              }
            }

            if (sessionOnly && !AGENT_MODE) emitSessionOnlyWarning(process.stderr.write.bind(process.stderr))
            log(`wallet create: ${w.id} (${mode}${tagRaw ? `, tag=${tagRaw}` : ''}, chains=${chains.join(',')}, mode=${passphrase ? 'passphrase' : 'session-only'}${keychainStoreWarning ? ', keychain=failed' : ''})`)

            // For managed wallets, register metadata with the server to get a setup link
            let setupLink: string | undefined
            if (isManaged) {
              try {
                const headers: Record<string, string> = { 'Content-Type': 'application/json' }
                const res = await fetch(ao.api + '/wallet/register-managed', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    walletId: w.id,
                    name: w.name,
                    solanaAddress: w.solanaAddress,
                    evmAddress: w.evmAddress,
                  }),
                })
                const data = await res.json() as any
                if (!res.ok || data.error) {
                  throw new Error(data.error || `HTTP ${res.status}`)
                }
                setupLink = ao.api + data.setupLink
              } catch (e: any) {
                err(`Failed to register managed wallet with server: ${e.message}`, EXIT.NETWORK)
              }
            }

            // TTY → nice TUI. Piped → JSON with setupLink included.
            if (!AGENT_MODE) {
              render(React.createElement(WalletCreateScreen, {
                version: VERSION,
                id: w.id,
                name: w.name,
                mode: w.mode,
                solana: w.solanaAddress,
                base: w.evmAddress,
                tag: w.tag,
              }))
              if (setupLink) {
                console.log(`\n  ${t.accent}Setup link${t.reset} — send to the human who will manage this wallet:`)
                console.log(`  ${t.info}${setupLink}${t.reset}\n`)
                console.log(`  ${t.muted}They'll register a passkey and set spending limits. Takes 30 seconds.${t.reset}\n`)
              }
              if (generatedPassphrase) {
                console.log(`\n  ${t.warn}Recovery passphrase (save this):${t.reset} ${passphrase}`)
                console.log(`  ${t.muted}Decrypts this wallet if the OS keychain is lost. Reuse via PALMYR_WALLET_PASSPHRASE.${t.reset}`)
              }
              console.log(`\n  ${t.muted}Fund with USDC on Base or Solana (gas sponsored) — ~$3 for your first paid action.${t.reset}`)
              console.log(`  ${t.muted}Check readiness: ${t.reset}palmyr wallet pay-preflight --wallet ${w.id}\n`)
            } else {
              print({
                ...w,
                setupLink,
                recoverable: !!passphrase,
                ...(generatedPassphrase ? { recoveryPassphrase: passphrase } : {}),
                ...(keychainStoreWarning ? { keychainWarning: keychainStoreWarning } : {}),
                funding: {
                  note: 'Fund this wallet with USDC on Base or Solana (gas is sponsored). ~$3 minimum for your first paid action.',
                  verify: `palmyr wallet pay-preflight --wallet ${w.id}`,
                },
              })
            }
            break
          }
          case 'import': {
            const mnemonic = flags.mnemonic as string
            if (!mnemonic) err('--mnemonic "your twelve words..." required')
            const name = (flags.name as string) || (flags.label as string) || 'Imported Wallet'
            const mode = flags.managed ? 'managed' as const : 'unmanaged' as const
            const tagRaw = (flags.tag as string | undefined) || undefined
            const wantSol = !!flags.solana
            const wantBase = !!flags.base
            const chains = (wantSol && !wantBase) ? ['solana' as const]
                         : (wantBase && !wantSol) ? ['base' as const]
                         : ['solana' as const, 'base' as const]

            // Same recoverability gate as `create`. Import is even more
            // commonly run on a "new machine" after losing access on the
            // original — going session-only here would re-trap the user in
            // the same hole they're recovering from.
            const importSessionOnly = !!flags['session-only']
            let importPassphrase = (flags.passphrase as string | undefined) || process.env.PALMYR_WALLET_PASSPHRASE || undefined
            let importGeneratedPassphrase = false
            if (importPassphrase && importSessionOnly) {
              err('Pass either --passphrase / PALMYR_WALLET_PASSPHRASE OR --session-only, not both.', EXIT.BAD_INPUT)
            }
            if (!importPassphrase && !importSessionOnly) {
              if (process.stdin.isTTY) {
                const { promptNewPassphrase } = await import('./passphrase-prompt.js')
                if (!AGENT_MODE) process.stderr.write(
                  '\n  Import needs a passphrase fallback so the wallet survives a reboot / OS-keychain change / host migration.\n' +
                  '  (Re-run with --session-only to opt out — ephemeral wallets only.)\n\n'
                )
                importPassphrase = await promptNewPassphrase('vault wallet')
              } else {
                // Non-TTY parity with `wallet create`: don't dead-end on a prompt
                // we can't render. Auto-generate a recoverable fallback and surface
                // it LOUDLY (stderr, with the phrase) so a just-imported — possibly
                // funded — wallet can't become unrecoverable. `--session-only`
                // remains the explicit opt-out.
                importPassphrase = randomBytes(24).toString('base64url')
                importGeneratedPassphrase = true
                process.stderr.write(
                  '\n  No passphrase supplied — generated a recoverable fallback. SAVE IT:\n' +
                  `      ${importPassphrase}\n` +
                  '  The wallet is decryptable via this phrase OR this machine\'s OS keychain.\n' +
                  '  Re-run with --session-only to opt out of the fallback.\n\n'
                )
              }
            }

            const { importLocalWallet } = await import('./vault.js')
            const w = importLocalWallet(name, mnemonic, mode, { tag: tagRaw, chains, passphrase: importPassphrase })

            // Store session secret. Keychain failure is non-fatal when a
            // passphrase fallback was written.
            const { storeSecret } = await import('./credential-store.js')
            let importKeychainWarning: string | null = null
            try {
              storeSecret(w.id, w.sessionSecret)
            } catch (e: any) {
              if (importPassphrase) {
                importKeychainWarning = e?.message || 'keychain store failed'
                if (!AGENT_MODE) process.stderr.write(`  warning: OS keychain unavailable (${importKeychainWarning}); wallet remains decryptable via PALMYR_WALLET_PASSPHRASE\n`)
              } else {
                throw e
              }
            }

            if (importSessionOnly && !AGENT_MODE) emitSessionOnlyWarning(process.stderr.write.bind(process.stderr))
            log(`wallet import: ${w.id} (mode=${importPassphrase ? 'passphrase' : 'session-only'}${importKeychainWarning ? ', keychain=failed' : ''})`)

            if (!AGENT_MODE) {
              render(React.createElement(WalletCreateScreen, {
                version: VERSION,
                id: w.id,
                name: w.name,
                mode: w.mode,
                solana: w.solanaAddress,
                base: w.evmAddress,
                tag: w.tag,
              }))
              if (importGeneratedPassphrase) {
                console.log(`\n  ${t.warn}Recovery passphrase (save this):${t.reset} ${importPassphrase}`)
                console.log(`  ${t.muted}Decrypts this wallet if the OS keychain is lost. Reuse via PALMYR_WALLET_PASSPHRASE.${t.reset}`)
              }
            } else {
              print({ ...w, recoverable: !!importPassphrase, ...(importGeneratedPassphrase ? { recoveryPassphrase: importPassphrase } : {}), ...(importKeychainWarning ? { keychainWarning: importKeychainWarning } : {}) })
            }
            break
          }
          case 'list': {
            // List from local vault — no server needed
            const { listVaultWallets } = await import('./vault.js')
            const tagFilter = flags.tag as string | undefined
            let wallets = listVaultWallets()
            if (tagFilter) wallets = wallets.filter(w => w.tag === tagFilter)
            if (!AGENT_MODE) {
              render(React.createElement(WalletListScreen, {
                version: VERSION,
                wallets: wallets.map((w: any) => ({
                  id: w.id,
                  name: w.name,
                  mode: w.mode,
                  solana: w.solanaAddress,
                  base: w.evmAddress,
                  tag: w.tag,
                })),
              }))
            } else {
              print({ wallets, ...(tagFilter ? { tag: tagFilter } : {}) })
            }
            break
          }
          case 'tags': {
            const { listTags } = await import('./vault.js')
            const tags = listTags()
            if (AGENT_MODE) {
              print({ tags })
            } else {
              if (tags.length === 0) {
                console.log(`\n  ${t.muted}No tagged wallets yet.${t.reset}`)
                console.log(`  ${t.muted}Create some:  ${t.reset}palmyr wallet create --tag demo --count 5\n`)
              } else {
                console.log(`\n  ${t.accent}wallet tags${t.reset}`)
                for (const tg of tags) {
                  console.log(`  ${t.bold}${tg.name}${t.reset} ${t.muted}·${t.reset} ${tg.count} wallet(s) ${t.muted}·${t.reset} ${tg.chains.join(',')}`)
                }
                console.log('')
              }
            }
            break
          }
          case 'tag': {
            const walletId = positional[0] || (flags.id as string)
            if (!walletId) err('Wallet ID required: palmyr wallet tag <WALLET_ID> <TAG> | --clear', EXIT.BAD_INPUT)
            const wantClear = !!flags.clear
            const newTag = positional[1] || (flags.tag as string | undefined)
            if (!wantClear && !newTag) err('Pass a TAG or --clear', EXIT.BAD_INPUT)
            if (wantClear && newTag) err('Cannot pass both a TAG and --clear', EXIT.BAD_INPUT)

            const { tagWallet } = await import('./vault.js')
            const out = tagWallet(walletId, wantClear ? null : newTag!)
            log(`wallet tag: ${out.id} → ${out.tag ?? '(cleared)'}`)
            print({ success: true, ...out })
            break
          }
          case 'tag-delete': {
            const tagArg = positional[0] || (flags.tag as string | undefined)
            if (!tagArg) err('Tag required: palmyr wallet tag-delete <TAG> --confirm', EXIT.BAD_INPUT)
            if (!flags.confirm) {
              err(
                `This will permanently delete every wallet tagged "${tagArg}" and their session secrets.\n\n` +
                '  Re-run with --confirm to proceed:\n' +
                `  palmyr wallet tag-delete ${tagArg} --confirm`,
                EXIT.BAD_INPUT,
              )
            }

            const { walletsByTag, deleteLocalWallet } = await import('./vault.js')
            const { deleteSecret } = await import('./credential-store.js')
            const targets = walletsByTag(tagArg)
            if (targets.length === 0) err(`No wallets found with tag "${tagArg}"`, EXIT.NOT_FOUND)

            const deleted: Array<{ id: string; name: string }> = []
            const failed: Array<{ id: string; name: string; error: string }> = []
            for (const w of targets) {
              try {
                const out = deleteLocalWallet(w.id)
                try { deleteSecret(w.id) } catch {}
                deleted.push(out)
                if (!AGENT_MODE) process.stderr.write(`deleted ${out.name} (${out.id.slice(0, 8)}...)\n`)
              } catch (e: any) {
                failed.push({ id: w.id, name: w.name, error: e?.message || String(e) })
              }
            }

            log(`wallet tag-delete: ${deleted.length} deleted, ${failed.length} failed (tag=${tagArg})`)
            print({
              success: failed.length === 0,
              tag: tagArg,
              deleted: deleted.length,
              wallets: deleted,
              ...(failed.length > 0 ? { failed } : {}),
            })
            break
          }
          case 'info': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            // Read from local vault directly
            const { listVaultWallets } = await import('./vault.js')
            const wallets = listVaultWallets()
            const w = wallets.find(x => x.id === walletId || x.name === walletId)
            if (!w) err(`Wallet "${walletId}" not found`, EXIT.NOT_FOUND)
            if (!AGENT_MODE) {
              render(React.createElement(WalletStatusScreen, {
                version: VERSION,
                id: w!.id,
                name: w!.name,
                mode: w!.mode,
                solana: w!.solanaAddress,
                base: w!.evmAddress,
              }))
            } else {
              print(w)
            }
            break
          }
          case 'addresses': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            // Read from local vault — same source as `wallet list` / `wallet info`.
            // The previous server-call path 401'd for unauthenticated users
            // even though all the data is already on the local disk.
            const { listVaultWallets } = await import('./vault.js')
            const wallets = listVaultWallets()
            const w = wallets.find(x => x.id === walletId || x.name === walletId)
            if (!w) err(`Wallet "${walletId}" not found`, EXIT.NOT_FOUND)
            const addresses = [
              ...(w!.solanaAddress ? [{ chainId: 'solana', address: w!.solanaAddress }] : []),
              ...(w!.evmAddress ? [{ chainId: 'base', address: w!.evmAddress }] : []),
            ]
            if (!AGENT_MODE) {
              render(React.createElement(SuccessScreen, {
                version: VERSION,
                title: 'Wallet addresses',
                subtitle: walletId,
                footerLeft: `${addresses.length} chain(s)`,
                details: addresses.map(a => ({ label: a.chainId + ':', value: a.address })),
              }))
            } else {
              print({ id: w!.id, name: w!.name, addresses })
            }
            break
          }
          case 'sign-message': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const chain = flags.chain as string
            const msg = flags.msg as string || flags.message as string
            if (!chain || !msg) err('--chain and --msg required')
            // Sign locally — no server needed.
            // Read the same passphrase channel as pay / export / rekey so a
            // passphrase-backed wallet signs from any machine the env var
            // reaches (was missing in 1.8.2 — inconsistent with other commands).
            const signPass = (flags.passphrase as string | undefined) || process.env.PALMYR_WALLET_PASSPHRASE || undefined
            const { signMessageLocal } = await import('./vault.js')
            const data = signMessageLocal(walletId, chain, msg, signPass)
            if (AGENT_MODE) return print({ success: true, ...data })
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Message signed',
              subtitle: chain,
              footerLeft: 'Signature ready',
              details: [
                { label: 'Signature', value: String(data.signature || '') },
                ...(data.recoveryId !== undefined ? [{ label: 'Recovery ID', value: String(data.recoveryId) }] : []),
              ],
            }))
            break
          }
          case 'register': {
            // Register a vault wallet as an agent on the server and receive an
            // aos_ token. The hardened server (PR #321) REQUIRES a fresh
            // wallet-control signature: it binds the wallet→token, and the token
            // then satisfies every ownership check, so an unsigned register would
            // let anyone claim a victim's wallet. We sign the exact bytes the
            // server verifies — see src/middleware/auth.ts (registerAuthMessage +
            // verifyWalletControl) and src/routes/agents.ts (POST /register).
            const walletId = positional[0] || (flags.id as string)
            if (!walletId) err('Wallet ID required: palmyr wallet register <WALLET_ID> [--name <agent>] [--chain solana|base]', EXIT.BAD_INPUT)

            const { listVaultWallets, signMessageLocal } = await import('./vault.js')
            const w = listVaultWallets().find(x => x.id === walletId || x.name === walletId)
            if (!w) err(`Wallet "${walletId}" not found. Run \`palmyr wallet list\`.`, EXIT.NOT_FOUND)

            // Pick which chain's address becomes the identity. The signed message
            // embeds whatever address we send, and the server selects Ed25519
            // (Solana) vs EIP-191 (EVM) verification from the address format —
            // so the address and the signing chain MUST agree.
            const chainFlag = (flags.chain as string | undefined)?.toLowerCase()
            let chain: 'solana' | 'base'
            if (chainFlag === 'solana' || chainFlag === 'base') chain = chainFlag
            else if (chainFlag === 'evm' || chainFlag === 'ethereum') chain = 'base'
            else if (chainFlag) { err(`--chain must be 'solana' or 'base', got: ${chainFlag}`, EXIT.BAD_INPUT); chain = 'solana' }
            else chain = w!.solanaAddress ? 'solana' : 'base'

            const walletAddress = chain === 'solana' ? w!.solanaAddress : w!.evmAddress
            if (!walletAddress) err(`Wallet "${walletId}" has no ${chain} address to register. Try --chain ${chain === 'solana' ? 'base' : 'solana'}.`, EXIT.BAD_INPUT)

            const agentName = (flags.name as string) || w!.name
            const description = (flags.description as string | undefined) || undefined
            const webhookUrl = (flags['webhook-url'] as string | undefined) || (flags.webhook as string | undefined) || undefined

            // Wallet-control proof: sign `palmyr-register:<wallet>:<ms-epoch>`.
            // signMessageLocal returns hex; the server's decodeSignature accepts
            // hex for both 64-byte Ed25519 and 65-byte EIP-191 signatures. The
            // passphrase channel matches sign-message/pay so headless wallets work.
            const signatureTimestamp = Date.now()
            const message = `palmyr-register:${walletAddress}:${signatureTimestamp}`
            const signPass = (flags.passphrase as string | undefined) || process.env.PALMYR_WALLET_PASSPHRASE || undefined
            let signature: string
            try {
              signature = signMessageLocal(w!.id, chain, message, signPass).signature
            } catch (e: any) {
              err(`Could not sign the registration proof: ${e.message}`, EXIT.GENERAL)
            }

            let res: any
            try {
              res = await fetch(ao.api + '/agents/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: agentName, description, walletAddress, webhookUrl, signature: signature!, signatureTimestamp }),
              })
            } catch (e: any) {
              err(`Registration request failed: ${e.message}`, EXIT.NETWORK)
            }
            const data = await res!.json().catch(() => ({})) as any
            if (!res!.ok) {
              err(`Registration failed (HTTP ${res!.status}): ${data?.message || data?.error || 'unknown error'}`, EXIT.GENERAL, data)
            }

            log(`wallet register: ${data.agent?.id ?? '?'} (${chain}, ${walletAddress})`)
            if (AGENT_MODE) return print(data)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Agent registered',
              subtitle: 'Save your token — it is shown once and cannot be recovered',
              footerLeft: String(data.agent?.id || 'registered'),
              details: [
                { label: 'Token', value: String(data.token || '') },
                { label: 'Agent ID', value: String(data.agent?.id || '') },
                { label: 'Wallet', value: walletAddress },
                { label: 'Chain', value: chain },
              ],
            }))
            break
          }
          case 'api-key': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const name = flags.name as string || 'cli-agent'
            // Retrieve session secret from OS credential store
            const { retrieveSecret } = await import('./credential-store.js')
            const sessionSecret = retrieveSecret(walletId)
            if (!sessionSecret) err('No session secret found. Was this wallet created on this machine?')
            const data = await ao.walletApiKey(walletId, name, sessionSecret!)
            if (AGENT_MODE) return print(data)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'API key created',
              subtitle: 'Save this token — it will not be shown again',
              footerLeft: 'Agent API key',
              details: [
                { label: 'Token', value: String(data.apiKey?.token || '') },
                { label: 'Key ID', value: String(data.apiKey?.id || '') },
                { label: 'Name', value: String(data.apiKey?.name || name) },
              ],
            }))
            break
          }
          case 'config': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const { retrieveSecret } = await import('./credential-store.js')
            const sessionSecret = retrieveSecret(walletId)
            if (!sessionSecret) err('No session secret found. Was this wallet created on this machine?')
            const data = await ao.walletConfig(walletId, sessionSecret!)
            return print(data)
          }
          case 'use': {
            const walletRef = positional[0] || flags.id as string
            if (!walletRef) err('Wallet ID required')
            const chain = (flags.chain as string)?.toLowerCase()
            if (chain && chain !== 'solana' && chain !== 'base') {
              err(`--chain must be 'solana' or 'base', got: ${chain}`)
            }
            // Resolve against the vault by id OR name before persisting, so a
            // typo surfaces here as a clean NOT_FOUND instead of a confusing
            // decryption failure on the next paid call. Store the canonical id.
            const { listVaultWallets } = await import('./vault.js')
            const match = listVaultWallets().find(w => w.id === walletRef || w.name === walletRef)
            if (!match) err(`Wallet "${walletRef}" not found. Run \`palmyr wallet list\` to see available wallets.`, EXIT.NOT_FOUND)
            const cfg = loadConfig()
            cfg.defaultPayWalletId = match!.id
            if (chain) (cfg as any).defaultPayChain = chain as 'solana' | 'base'
            saveConfig(cfg)
            print({ success: true, defaultPayWalletId: match!.id, defaultPayChain: (cfg as any).defaultPayChain || 'solana' })
            break
          }
          case 'request-approval': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            const action = flags.action as string || 'limits'
            const params: Record<string, any> = {}
            if (flags.daily) params.daily_usdc = Number(flags.daily)
            if (flags['per-tx'] || flags.tx) params.per_tx_usdc = Number(flags['per-tx'] || flags.tx)
            const data = await ao.walletRequestApproval(walletId, action, params)
            if (AGENT_MODE) return print(data)
            render(React.createElement(SuccessScreen, {
              version: VERSION,
              title: 'Approval requested',
              subtitle: action,
              footerLeft: 'Send link to human for approval',
              details: [
                { label: 'Approval URL', value: `${ao.api}${data.approvalPath}` },
                { label: 'Action', value: action },
              ],
            }))
            break
          }
          case 'export': {
            const walletId = positional[0] || flags.id as string
            if (!walletId) err('Wallet ID required')
            if (!flags.confirm) {
              err(
                'This will display your mnemonic in plaintext. ' +
                'Anyone who sees it can steal your funds.\n\n' +
                '  Re-run with --confirm to proceed:\n' +
                `  palmyr wallet export ${walletId} --confirm`
              )
            }
            // Decrypt via vault's single decryption path (session secret from OS cred store)
            const { exportMnemonic } = await import('./vault.js')
            let mnemonic: string
            try {
              mnemonic = exportMnemonic(walletId)
            } catch (e: any) {
              // Preserve SECURITY exit code for integrity failures
              const code = e.message?.includes('SECURITY') ? EXIT.SECURITY : EXIT.GENERAL
              err(e.message, code)
            }

            const warning = 'Keep this phrase secret. Anyone with these 12 words can take your funds. Write it down offline; never share, screenshot, or paste it.'
            if (!AGENT_MODE) {
              console.log(`\n  ${t.warn}⚠  MNEMONIC — KEEP SECRET${t.reset}\n`)
              console.log(`  ${mnemonic!}\n`)
              console.log(`  ${t.muted}${warning}${t.reset}\n`)
            } else {
              print({ mnemonic: mnemonic!, walletId, warning })
            }
            break
          }
          case 'rekey': {
            const walletId = positional[0] || (flags.id as string)
            if (!walletId) err('Wallet ID required: palmyr wallet rekey <WALLET_ID> --passphrase <p>', EXIT.BAD_INPUT)

            // New passphrase: flag → env → interactive prompt (TTY only).
            let newPass = (flags.passphrase as string | undefined) || process.env.PALMYR_WALLET_PASSPHRASE || undefined
            if (!newPass) {
              if (!process.stdin.isTTY) err('--passphrase or PALMYR_WALLET_PASSPHRASE required (no TTY for interactive prompt)', EXIT.BAD_INPUT)
              const { promptNewPassphrase } = await import('./passphrase-prompt.js')
              newPass = await promptNewPassphrase()
            }

            // Current passphrase is only needed if the wallet was already
            // passphrase-sealed and the OS session secret is gone (rare —
            // typically the rekey runs on the original machine where the
            // session secret still resolves).
            const currentPass = (flags['current-passphrase'] as string | undefined) || process.env.PALMYR_WALLET_PASSPHRASE_CURRENT || undefined

            const { rekeyWallet } = await import('./vault.js')
            let result: { id: string; name: string; rotated: boolean }
            try {
              result = rekeyWallet(walletId, newPass, currentPass)
            } catch (e: any) {
              const code = e.message?.includes('SECURITY') ? EXIT.SECURITY : EXIT.GENERAL
              err(e.message, code)
            }

            log(`wallet rekey: ${result!.id} (${result!.rotated ? 'rotated' : 'added'})`)

            if (!AGENT_MODE) {
              const verb = result!.rotated ? 'Rotated' : 'Added'
              console.log(`\n  ${t.success}✔${t.reset} ${verb} passphrase fallback on ${t.accent}${result!.name}${t.reset}`)
              console.log(`  ${t.muted}Wallet now decrypts with PALMYR_WALLET_PASSPHRASE on any machine (in addition to the OS keychain on this one).${t.reset}\n`)
            } else {
              print({ success: true, ...result! })
            }
            break
          }
          case 'buy': {
            const chain = (positional[0] || 'solana').toLowerCase()
            if (chain !== 'solana' && chain !== 'base') err(`Unsupported chain: ${chain}. Try: solana, base`, EXIT.BAD_INPUT)
            const ca = positional[1] || (flags.ca as string)
            if (!ca) err('CA required: palmyr wallet buy <chain> <CA> --amount <amt> --thesis "..."', EXIT.BAD_INPUT)
            const thesis = flags.thesis as string
            if (!thesis) err('--thesis required (your reasoning for entering this position)', EXIT.BAD_INPUT)
            const walletRef = (flags.wallet as string) || undefined
            const dryRun = !!flags['dry-run'] || process.env.DRY_RUN === '1'

            // Templates phase — load --template if provided; CLI flags win on merge.
            const templateName = flags.template as string | undefined
            let template: import('./wallet-strategy-templates.js').StrategyTemplate | null = null
            if (templateName) {
              const { loadTemplate } = await import('./wallet-strategy-templates.js')
              try {
                template = loadTemplate(templateName)
              } catch (e: any) {
                err(e.message || 'failed to load template', EXIT.NOT_FOUND)
              }
            }

            // CLI flag values — undefined means "use template default if any"
            const cliAmount = flags.amount as string | undefined
            const cliSlippage = flags.slippage !== undefined ? Number(flags.slippage) : undefined
            const cliCut = flags.cut as string | undefined
            const cliTp = ((flags.tp as string) || (flags['take-profit'] as string)) || undefined
            const cliHoldIf = (flags['hold-if'] as string) || undefined
            const cliTrail = (flags.trail as string) || undefined
            const cliTimeLimit = (flags['time-limit'] as string) || undefined
            const cliThesisCheck = (flags['thesis-check'] as string) || undefined

            // Safe-by-default — protectedExec and autoSlippage default to true
            // (MEV-protected with dynamic slippage). `--degen` opts out of both
            // for fast/raw execution. `--no-protected` / `--no-auto-slippage`
            // disable each individually. Explicit `--protected` is a no-op now
            // (kept for back-compat with scripts that pass it).
            const degen = !!flags.degen
            const resolveProtected = (): boolean | undefined => {
              if (degen) return false
              if (flags.protected === false) return false  // --no-protected
              if (flags.protected === true) return true    // --protected (redundant but explicit)
              return undefined  // fall through to template, then default true at lib layer
            }
            const resolveAutoSlippage = (): boolean | undefined => {
              if (degen) return false
              if (flags['auto-slippage'] === false) return false  // --no-auto-slippage
              if (flags['auto-slippage'] === true) return true
              return undefined
            }

            // Base path — Phase 5b buy, 5c sell+sync, 5d --protected + private RPC.
            if (chain === 'base') {
              if (!walletRef) err('--wallet required for Base. Use a vault wallet name/id (`palmyr wallet create`) or `trading:N`.', EXIT.BAD_INPUT)
              const tipGwei = flags.tip !== undefined ? Number(flags.tip) : undefined
              const cliPriorityFeeWei = tipGwei !== undefined ? BigInt(Math.round(tipGwei * 1e9)) : undefined
              let opts: any = {
                ca,
                thesis,
                walletRef,
                dryRun,
                amount: cliAmount,
                cut: cliCut,
                takeProfit: cliTp,
                holdIf: cliHoldIf,
                trailingStop: cliTrail,
                timeLimit: cliTimeLimit,
                thesisCheck: cliThesisCheck,
                slippageBps: cliSlippage,
                protectedExec: resolveProtected(),
                rpcUrl: (flags.rpc as string) || undefined,
                priorityFeeWei: cliPriorityFeeWei,
              }
              if (template) {
                const { applyTemplateToBuyOpts } = await import('./wallet-strategy-templates.js')
                opts = applyTemplateToBuyOpts(template, opts)
              }
              // Final default: protected ON unless user/template said otherwise. --degen already
              // forced it false above.
              if (opts.protectedExec === undefined) opts.protectedExec = !degen
              if (!opts.amount) err(`--amount required (e.g. --amount 0.01eth) — not in template or CLI`, EXIT.BAD_INPUT)
              const { buyBase } = await import('./wallet-trading.js')
              let baseResult: Awaited<ReturnType<typeof buyBase>>
              const prog = tradeProgress('submitting', `Buying on Base — quoting & submitting ${ca}...`, flags.progress !== false)
              try {
                baseResult = await buyBase(opts)
              } catch (e: any) {
                prog.fail()
                emitRouteErrorIfApplicable(e)
                err(e.message || 'buy (base) failed', EXIT.GENERAL)
              }
              prog.done('Base buy confirmed')
              log(`wallet buy: base ${ca} (${baseResult!.txHash})`)
              if (!AGENT_MODE) {
                const tag = baseResult!.dryRun ? `${t.warn}[dry-run]${t.reset} ` : ''
                const protTag = baseResult!.protectedExec ? ` ${t.accent}[protected]${t.reset}` : ''
                console.log(`\n  ${t.success}${icon.success} ${tag}Base position opened${protTag}${t.reset}`)
                console.log(`  ${t.muted}position:${t.reset}  ${baseResult!.positionPath}`)
                console.log(`  ${t.muted}tx:${t.reset}        ${baseResult!.txHash}`)
                console.log(`  ${t.muted}wallet:${t.reset}    ${baseResult!.wallet}`)
                console.log(`  ${t.muted}in:${t.reset}        ${baseResult!.amountIn}`)
                console.log(`  ${t.muted}out:${t.reset}       ${baseResult!.tokensOut} tokens`)
                console.log(`  ${t.muted}slippage:${t.reset}  ${baseResult!.slippageBpsUsed}bps`)
                console.log(`  ${t.muted}fee:${t.reset}       ${baseResult!.feeWei} wei`)
                if (baseResult!.protectedExec) {
                  console.log(`  ${t.muted}rpc:${t.reset}       ${baseResult!.rpcUrl}`)
                }
                console.log()
              } else {
                print(baseResult!)
              }
              break
            }

            // Solana path. Same template-merge pattern as Base above.
            let solOpts: any = {
              ca,
              thesis,
              walletRef,
              dryRun,
              amount: cliAmount,
              cut: cliCut,
              takeProfit: cliTp,
              holdIf: cliHoldIf,
              trailingStop: cliTrail,
              timeLimit: cliTimeLimit,
              thesisCheck: cliThesisCheck,
              slippageBps: cliSlippage,
              protectedExec: resolveProtected(),
              autoSlippage: resolveAutoSlippage(),
              jitoTipLamports: flags.tip !== undefined ? Number(flags.tip) : undefined,
            }
            if (template) {
              const { applyTemplateToBuyOpts } = await import('./wallet-strategy-templates.js')
              solOpts = applyTemplateToBuyOpts(template, solOpts)
            }
            if (!solOpts.amount) err(`--amount required (e.g. --amount 0.5sol) — not in template or CLI`, EXIT.BAD_INPUT)
            // Final defaults: MEV protection + dynamic slippage are ON unless --degen, --no-protected,
            // --no-auto-slippage, or a template set them off.
            if (solOpts.protectedExec === undefined) solOpts.protectedExec = !degen
            if (solOpts.autoSlippage === undefined) solOpts.autoSlippage = !degen

            const { buy } = await import('./wallet-trading.js')
            let result: Awaited<ReturnType<typeof buy>>
            const buyProg = tradeProgress('submitting', `Buying on Solana — quoting & submitting ${ca}...`, flags.progress !== false)
            try {
              result = await buy(solOpts)
            } catch (e: any) {
              buyProg.fail()
              emitRouteErrorIfApplicable(e)
              err(e.message || 'buy failed', EXIT.GENERAL)
            }
            buyProg.done('Solana buy confirmed')

            log(`wallet buy: ${ca} (${result!.txSignature})`)

            if (!AGENT_MODE) {
              const tag = result!.dryRun ? `${t.warn}[dry-run]${t.reset} ` : ''
              const protTag = result!.protectedExec ? ` ${t.accent}[protected]${t.reset}` : ''
              console.log(`\n  ${t.success}${icon.success} ${tag}Position opened${protTag}${t.reset}`)
              console.log(`  ${t.muted}position:${t.reset}  ${result!.positionPath}`)
              console.log(`  ${t.muted}tx:${t.reset}        ${result!.txSignature}`)
              console.log(`  ${t.muted}wallet:${t.reset}    ${result!.wallet}`)
              console.log(`  ${t.muted}in:${t.reset}        ${result!.amountIn}`)
              console.log(`  ${t.muted}out:${t.reset}       ${result!.tokensOut} tokens`)
              console.log(`  ${t.muted}slippage:${t.reset}  ${result!.slippageBpsUsed}bps (${result!.slippageSource})`)
              if (result!.protectedExec) {
                console.log(`  ${t.muted}tip:${t.reset}       ${result!.tipLamports} lamports (Jito)`)
              }
              console.log(`  ${t.muted}fee:${t.reset}       ${result!.feeLamports} lamports`)
              if (result!.entryMcap) {
                console.log(`  ${t.muted}entryMcap:${t.reset} $${result!.entryMcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
              }
              if (result!.forensics && result!.forensics.flag === 'suspect-mev') {
                console.log(`  ${t.warn}⚠ forensics: realized ${result!.forensics.realizedSlippageBps.toFixed(0)}bps slippage (${(result!.forensics.budgetUsed * 100).toFixed(0)}% of budget) — suspect MEV${t.reset}`)
              }
              console.log()
            } else {
              print(result!)
            }
            break
          }
          case 'cohort': {
            // Phase 4c — `palmyr wallet cohort buy <chain> <CA> --total <amt> ...`
            const sub = positional[0]
            if (sub !== 'buy') err('cohort subcommand required. Try: buy', EXIT.BAD_INPUT)
            const thesis = flags.thesis as string
            if (!thesis) err('--thesis required', EXIT.BAD_INPUT)

            // Templates phase — load --template if provided. Template can supply
            // chain, total amount, exit plan, cohort defaults (split/jitter/from).
            const cohortTemplateName = flags.template as string | undefined
            let cohortTemplate: import('./wallet-strategy-templates.js').StrategyTemplate | null = null
            if (cohortTemplateName) {
              const { loadTemplate } = await import('./wallet-strategy-templates.js')
              try {
                cohortTemplate = loadTemplate(cohortTemplateName)
              } catch (e: any) {
                err(e.message || 'failed to load template', EXIT.NOT_FOUND)
              }
            }

            const chain = (positional[1] || cohortTemplate?.chain || 'solana').toLowerCase()
            if (chain !== 'solana' && chain !== 'base') err(`Unsupported chain: ${chain}. Try: solana, base`, EXIT.BAD_INPUT)
            const ca = positional[2] || (flags.ca as string)
            if (!ca) err(`CA required: palmyr wallet cohort buy ${chain} <CA> --total <amt> ...`, EXIT.BAD_INPUT)
            const total = (flags.total as string) || cohortTemplate?.amount
            if (!total) err(`--total required (e.g. --total ${chain === 'base' ? '0.05eth' : '1.0sol'}) — not in template or CLI`, EXIT.BAD_INPUT)

            // Resolve wallet list. Three forms (highest to lowest priority):
            //   1. --wallets trading:0,trading:1,trading:2 (explicit list)
            //   2. --from trading:N --split K (derive K wallets starting at N)
            //   3. Template `cohort: { split: N, from: trading:M, jitterMs: ... }`
            const walletsFlag = flags.wallets as string | undefined
            const fromFlag = flags.from as string | undefined
            const splitFlag = flags.split !== undefined ? Number(flags.split) : undefined
            const cliJitter = flags.jitter !== undefined ? Number(flags.jitter) : undefined
            if (cliJitter !== undefined && (!Number.isFinite(cliJitter) || cliJitter < 0)) {
              err(`--jitter must be a non-negative number (ms), got ${flags.jitter}`, EXIT.BAD_INPUT)
            }

            const { resolveCohortFromTemplate, applyTemplateToBuyOpts } = await import('./wallet-strategy-templates.js')
            let walletRefs: string[]
            let jitterMs: number
            try {
              const explicitList = walletsFlag
                ? walletsFlag.split(',').map(s => s.trim()).filter(Boolean)
                : undefined
              const resolved = cohortTemplate
                ? resolveCohortFromTemplate(cohortTemplate, explicitList, fromFlag, splitFlag, cliJitter)
                : (() => {
                    if (explicitList && explicitList.length > 0) {
                      return { walletRefs: explicitList, jitterMs: cliJitter ?? 0 }
                    }
                    if (splitFlag !== undefined) {
                      if (!Number.isInteger(splitFlag) || splitFlag <= 0) {
                        throw new Error(`--split must be a positive integer, got ${flags.split}`)
                      }
                      const fromRef = fromFlag ?? 'trading:0'
                      if (!fromRef.startsWith('trading:')) {
                        throw new Error(`--from must be a trading: reference (got ${fromRef})`)
                      }
                      const startIdx = Number(fromRef.slice('trading:'.length))
                      if (!Number.isInteger(startIdx) || startIdx < 0) {
                        throw new Error(`Invalid --from index: ${fromRef}`)
                      }
                      const refs: string[] = []
                      for (let i = 0; i < splitFlag; i++) refs.push(`trading:${startIdx + i}`)
                      return { walletRefs: refs, jitterMs: cliJitter ?? 0 }
                    }
                    throw new Error('cohort needs --wallets <list>, --split <N> [--from trading:M], or a template with cohort.split')
                  })()
              walletRefs = resolved.walletRefs
              jitterMs = resolved.jitterMs
            } catch (e: any) {
              err(e.message || 'cohort wallet resolution failed', EXIT.BAD_INPUT)
            }

            const dryRun = !!flags['dry-run'] || process.env.DRY_RUN === '1'
            const cliTipGwei = flags.tip !== undefined && chain === 'base' ? Number(flags.tip) : undefined
            const cliPriorityFeeWei = cliTipGwei !== undefined ? BigInt(Math.round(cliTipGwei * 1e9)) : undefined

            // Safe-by-default for cohort legs. --degen disables; --no-protected / --no-auto-slippage individually disable.
            const cohortDegen = !!flags.degen
            const cohortResolveProtected = (): boolean | undefined => {
              if (cohortDegen) return false
              if (flags.protected === false) return false
              if (flags.protected === true) return true
              return undefined
            }
            const cohortResolveAutoSlippage = (): boolean | undefined => {
              if (cohortDegen) return false
              if (flags['auto-slippage'] === false) return false
              if (flags['auto-slippage'] === true) return true
              return undefined
            }

            // Build opts with CLI values; merge template defaults for the rest.
            let cohortOpts: any = {
              chain: chain as 'solana' | 'base',
              ca,
              totalAmount: total,
              walletRefs: walletRefs!,
              thesis,
              jitterMs: jitterMs!,
              dryRun,
              cut: (flags.cut as string | undefined),
              takeProfit: ((flags.tp as string) || (flags['take-profit'] as string)) || undefined,
              holdIf: (flags['hold-if'] as string) || undefined,
              trailingStop: (flags.trail as string) || undefined,
              timeLimit: (flags['time-limit'] as string) || undefined,
              thesisCheck: (flags['thesis-check'] as string) || undefined,
              slippageBps: flags.slippage !== undefined ? Number(flags.slippage) : undefined,
              protectedExec: cohortResolveProtected(),
              autoSlippage: cohortResolveAutoSlippage(),
              jitoTipLamports: flags.tip !== undefined && chain === 'solana' ? Number(flags.tip) : undefined,
              priorityFeeWei: cliPriorityFeeWei,
              rpcUrl: (flags.rpc as string) || undefined,
            }
            if (cohortTemplate) {
              cohortOpts = applyTemplateToBuyOpts(cohortTemplate, cohortOpts)
              // Restore cohort-specific fields that applyTemplate doesn't touch
              cohortOpts.chain = chain as 'solana' | 'base'
              cohortOpts.ca = ca
              cohortOpts.totalAmount = total
              cohortOpts.walletRefs = walletRefs!
              cohortOpts.thesis = thesis
              cohortOpts.jitterMs = jitterMs!
              cohortOpts.dryRun = dryRun
            }
            // Final defaults: protected + auto-slippage ON unless user/template/degen disabled.
            if (cohortOpts.protectedExec === undefined) cohortOpts.protectedExec = !cohortDegen
            if (cohortOpts.autoSlippage === undefined) cohortOpts.autoSlippage = !cohortDegen

            const { cohortBuy } = await import('./wallet-trading.js')
            let result: Awaited<ReturnType<typeof cohortBuy>>
            try {
              result = await cohortBuy(cohortOpts)
            } catch (e: any) {
              err(e.message || 'cohort buy failed', EXIT.GENERAL)
            }

            log(`wallet cohort buy: ${chain} ${ca} ${result!.successes.length}/${walletRefs!.length} ok (cohort ${result!.cohortId})`)
            if (!AGENT_MODE) {
              const tag = dryRun ? `${t.warn}[dry-run]${t.reset} ` : ''
              const tplTag = cohortTemplate ? ` ${t.accent}[${cohortTemplate.name}]${t.reset}` : ''
              console.log(`\n  ${t.success}${icon.success} ${tag}Cohort buy complete${tplTag}${t.reset}`)
              console.log(`  ${t.muted}cohort:${t.reset}    ${result!.cohortId}`)
              console.log(`  ${t.muted}chain:${t.reset}     ${result!.chain}`)
              console.log(`  ${t.muted}token:${t.reset}     ${result!.ca}`)
              console.log(`  ${t.muted}total:${t.reset}     ${result!.totalRequested} split across ${walletRefs!.length} wallets`)
              console.log(`  ${t.muted}per leg:${t.reset}   ${result!.perWalletAmount}`)
              console.log(`  ${t.muted}jitter:${t.reset}    ${jitterMs!}ms`)
              console.log(`  ${t.muted}succeeded:${t.reset} ${result!.successes.length}`)
              console.log(`  ${t.muted}failed:${t.reset}    ${result!.failures.length}`)
              if (result!.successes.length > 0) {
                console.log()
                for (const s of result!.successes) {
                  const txOrSig = s.chain === 'solana' ? s.result.txSignature : s.result.txHash
                  const tokensOut = s.result.tokensOut
                  console.log(`  ${t.success}✓${t.reset} ${s.walletRef} → ${tokensOut} tokens (${txOrSig.slice(0, 10)}...)`)
                }
              }
              if (result!.failures.length > 0) {
                console.log()
                for (const f of result!.failures) {
                  console.log(`  ${t.error}✗${t.reset} ${f.walletRef}: ${f.error}`)
                }
              }
              console.log()
            } else {
              print(result!)
            }
            break
          }
          case 'template': {
            // YAML strategy templates: list | show <name> | path <name> | delete <name>
            const sub = positional[0]
            if (!sub) err('template subcommand required. Try: list, show, path, delete', EXIT.BAD_INPUT)
            const {
              listTemplates,
              loadTemplate,
              deleteTemplate,
              templatePath,
              installExamplesIfMissing,
            } = await import('./wallet-strategy-templates.js')

            if (sub === 'list') {
              const examples = installExamplesIfMissing()
              const all = listTemplates()
              if (!AGENT_MODE) {
                if (all.length === 0) {
                  console.log(`\n  ${t.muted}No templates. Examples are installed on next list — try again.${t.reset}\n`)
                  break
                }
                console.log()
                section('Strategy templates')
                if (examples.installed.length > 0) {
                  console.log(`  ${t.muted}Installed examples: ${examples.installed.join(', ')}${t.reset}`)
                  console.log()
                }
                table(
                  ['NAME', 'CHAIN', 'DESCRIPTION'],
                  all.map((tpl) => [
                    tpl.name,
                    tpl.chain ?? '—',
                    tpl.description ?? `${t.muted}(no description)${t.reset}`,
                  ]),
                )
                console.log()
                console.log(`  ${t.muted}Use: palmyr wallet buy <chain> <CA> --template <name> --thesis "..."${t.reset}`)
                console.log(`  ${t.muted}Edit: ${t.reset}\`palmyr wallet template path <name>\``)
                console.log()
              } else {
                print({ templates: all, examplesInstalled: examples.installed })
              }
              break
            }

            if (sub === 'show') {
              const name = positional[1]
              if (!name) err('Template name required: palmyr wallet template show <name>', EXIT.BAD_INPUT)
              installExamplesIfMissing()
              let tpl: import('./wallet-strategy-templates.js').StrategyTemplate
              let raw: string
              try {
                tpl = loadTemplate(name)
                raw = readFileSync(templatePath(name), 'utf8')
              } catch (e: any) {
                err(e.message || `template ${name} not found`, EXIT.NOT_FOUND)
              }
              if (!AGENT_MODE) {
                console.log()
                section(`Template: ${tpl!.name}`)
                kv('Path', templatePath(name))
                if (tpl!.description) kv('Description', tpl!.description)
                console.log()
                console.log(raw!)
              } else {
                print({ name: tpl!.name, path: templatePath(name), template: tpl!, raw: raw! })
              }
              break
            }

            if (sub === 'path') {
              const name = positional[1]
              if (!name) err('Template name required: palmyr wallet template path <name>', EXIT.BAD_INPUT)
              const p = templatePath(name)
              if (!AGENT_MODE) {
                console.log(p)
              } else {
                print({ name, path: p })
              }
              break
            }

            if (sub === 'delete') {
              const name = positional[1]
              if (!name) err('Template name required: palmyr wallet template delete <name>', EXIT.BAD_INPUT)
              const removed = deleteTemplate(name)
              if (!AGENT_MODE) {
                if (removed) {
                  console.log(`\n  ${t.success}${icon.success} Deleted template '${name}'${t.reset}\n`)
                } else {
                  console.log(`\n  ${t.muted}Template '${name}' did not exist.${t.reset}\n`)
                }
              } else {
                print({ success: true, deleted: removed, name })
              }
              break
            }

            err(`Unknown template subcommand: ${sub}. Try: list, show, path, delete`, EXIT.BAD_INPUT)
          }
          case 'positions': {
            const chainFlag = ((flags.chain as string) || '').toLowerCase()
            if (chainFlag && chainFlag !== 'solana' && chainFlag !== 'base') {
              err(`Unsupported chain: ${chainFlag}. Try: solana, base`, EXIT.BAD_INPUT)
            }
            const walletRef = (flags.wallet as string) || undefined
            const includeClosed = !!flags.all
            // --history surfaces archived closed positions (re-entries on the
            // same mint after the previous close). Implies --all.
            const includeHistory = !!flags.history

            // Cross-chain wallet filter: a named vault/trading wallet maps to
            // BOTH a Solana base58 address and an EVM 0x address. If the user
            // gave --wallet, build the relevant address set so positions on
            // either chain pass the filter. Restrict to the chain-specific
            // address when --chain is set.
            let walletAddress: string | string[] | undefined
            if (walletRef) {
              const { resolveWalletAddresses } = await import('./wallet-trading.js')
              const resolved = await resolveWalletAddresses(walletRef)
              const addrs: string[] = []
              if (chainFlag === 'solana') {
                if (resolved.solanaAddress) addrs.push(resolved.solanaAddress)
              } else if (chainFlag === 'base') {
                if (resolved.evmAddress) addrs.push(resolved.evmAddress)
              } else {
                if (resolved.solanaAddress) addrs.push(resolved.solanaAddress)
                if (resolved.evmAddress) addrs.push(resolved.evmAddress)
              }
              if (addrs.length === 0) {
                err(`Could not resolve --wallet ${walletRef}${chainFlag ? ` for chain ${chainFlag}` : ''}.`, EXIT.NOT_FOUND)
              }
              walletAddress = addrs.length === 1 ? addrs[0] : addrs
            }

            const { listPositions, listHistoricalPositions } = await import('./wallet-trading.js')
            const positions = listPositions({
              chain: (chainFlag || undefined) as 'solana' | 'base' | undefined,
              walletAddress,
              includeClosed: includeClosed || includeHistory,
            })
            if (includeHistory) {
              positions.push(...listHistoricalPositions({
                chain: (chainFlag || undefined) as 'solana' | 'base' | undefined,
                walletAddress,
              }))
            }

            if (!AGENT_MODE) {
              if (positions.length === 0) {
                console.log(`\n  ${t.muted}No positions${includeClosed ? '' : ' (use --all to include closed, --history to include archived re-entries)'}.${t.reset}\n`)
                break
              }
              console.log()
              table(
                ['CHAIN', 'WALLET', 'CA', 'STATUS', 'IN', 'OUT', 'UNREAL %', 'THESIS'],
                positions.map((p) => [
                  p.chain,
                  p.wallet.length > 12 ? `${p.wallet.slice(0, 6)}..${p.wallet.slice(-4)}` : p.wallet,
                  p.mint.length > 12 ? `${p.mint.slice(0, 6)}..${p.mint.slice(-4)}` : p.mint,
                  p.status,
                  p.entry.amountIn,
                  p.entry.tokensOut,
                  `${p.pnl.unrealizedPct >= 0 ? '+' : ''}${p.pnl.unrealizedPct.toFixed(2)}%`,
                  p.thesis.length > 50 ? `${p.thesis.slice(0, 47)}...` : p.thesis,
                ]),
              )
              console.log()
            } else {
              print({ positions })
            }
            break
          }
          case 'position': {
            const ca = positional[0] || (flags.ca as string)
            if (!ca) err('CA required: palmyr wallet position <CA>', EXIT.BAD_INPUT)
            // Phase 5d — look up by chain if --chain is set, else try both.
            const chainFlag = ((flags.chain as string) || '').toLowerCase()
            if (chainFlag && chainFlag !== 'solana' && chainFlag !== 'base') {
              err(`Unsupported chain: ${chainFlag}. Try: solana, base`, EXIT.BAD_INPUT)
            }
            const { readPosition } = await import('./wallet-trading.js')
            let p = chainFlag
              ? readPosition(chainFlag as 'solana' | 'base', ca)
              : (readPosition('solana', ca) ?? readPosition('base', ca))
            if (!p) err(`Position not found: ${ca}`, EXIT.NOT_FOUND)

            // Canonical asset-tagged PnL — reflects what the position was
            // actually funded in (USDC-funded positions report USDC, not the
            // chain native asset).
            const unit = p!.pnl.realized?.asset ?? (p!.chain === 'solana' ? 'SOL' : 'ETH')
            const realized = p!.pnl.realized?.amount ?? 0
            const unrealized = p!.pnl.unrealized?.amount ?? 0

            if (!AGENT_MODE) {
              console.log()
              section('Position')
              kv('Chain', p!.chain)
              kv('CA', p!.mint)
              kv('Status', p!.status)
              kv('Wallet', p!.wallet)
              kv('Entry tx', p!.entry.tx)
              kv('Entry time', p!.entry.time)
              kv('Amount in', p!.entry.amountIn)
              kv('Tokens out', p!.entry.tokensOut)
              if (p!.entry.entryMcap !== null && p!.entry.entryMcap !== undefined) {
                kv('Entry mcap', `$${p!.entry.entryMcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
              }
              if (p!.entry.protectedExec) {
                kv('Protected', 'yes')
              }
              console.log()
              section('Thesis')
              console.log(`  ${p!.thesis}`)
              console.log()
              if (p!.exitPlan.cut || p!.exitPlan.takeProfit || p!.exitPlan.holdIf) {
                section('Exit plan')
                if (p!.exitPlan.cut) kv('Cut', p!.exitPlan.cut)
                if (p!.exitPlan.takeProfit) kv('Take profit', p!.exitPlan.takeProfit)
                if (p!.exitPlan.holdIf) kv('Hold if', p!.exitPlan.holdIf)
                console.log()
              }
              if (p!.riskFlags.length > 0) {
                section('Risk flags')
                console.log(`  ${p!.riskFlags.join(', ')}`)
                console.log()
              }
              section('PnL')
              kv('Realized', `${realized.toFixed(6)} ${unit}`)
              kv('Unrealized', `${unrealized.toFixed(6)} ${unit}`)
              kv('Unrealized %', `${p!.pnl.unrealizedPct.toFixed(2)}%`)
              kv('Last priced', p!.pnl.lastPricedAt || 'never (run `wallet sync`)')
              if (p!.sells.length > 0) {
                console.log()
                section(`Sells (${p!.sells.length})`)
                for (const s of p!.sells) {
                  const outDisplay = s.output?.display ?? '?'
                  const r = s.realized?.amount ?? 0
                  const ru = s.realized?.asset ?? unit
                  console.log(`  ${t.muted}${s.time}${t.reset}  ${s.tokensIn} → ${outDisplay} (realized ${r >= 0 ? '+' : ''}${r.toFixed(6)} ${ru}) — ${s.reason}`)
                }
              }
              console.log()
            } else {
              print(p)
            }
            break
          }
          case 'sell': {
            const chain = (positional[0] || 'solana').toLowerCase()
            if (chain !== 'solana' && chain !== 'base') err(`Unsupported chain: ${chain}. Try: solana, base`, EXIT.BAD_INPUT)
            const ca = positional[1] || (flags.ca as string)
            if (!ca) err('CA required: palmyr wallet sell <chain> <CA> --percent 50 --reason "..."', EXIT.BAD_INPUT)
            const percent = flags.percent !== undefined ? Number(flags.percent) : NaN
            if (!isFinite(percent) || percent <= 0 || percent > 100) {
              err('--percent required (0 < p ≤ 100), e.g. --percent 50', EXIT.BAD_INPUT)
            }
            const reason = flags.reason as string
            if (!reason) err('--reason required (why are you exiting?)', EXIT.BAD_INPUT)
            const walletRef = (flags.wallet as string) || undefined
            const slippageBps = flags.slippage ? Number(flags.slippage) : undefined
            const dryRun = !!flags['dry-run'] || process.env.DRY_RUN === '1'

            // Safe-by-default: protected ON unless --degen or --no-protected.
            const sellDegen = !!flags.degen
            const sellProtected = sellDegen
              ? false
              : flags.protected === false ? false : true
            const sellAutoSlippage = sellDegen
              ? false
              : flags['auto-slippage'] === false ? false : true

            // Base sell path — Phase 5c, plus 5d --protected + private RPC.
            if (chain === 'base') {
              if (!walletRef) err('--wallet required for Base. Use a vault wallet name/id or `trading:N`.', EXIT.BAD_INPUT)
              const baseRpc = (flags.rpc as string) || undefined
              const tipGwei = flags.tip ? Number(flags.tip) : undefined
              const priorityFeeWei = tipGwei !== undefined
                ? BigInt(Math.round(tipGwei * 1e9))
                : undefined
              const { sellBase } = await import('./wallet-trading.js')
              let baseResult: Awaited<ReturnType<typeof sellBase>>
              const prog = tradeProgress('submitting', `Selling ${percent}% on Base — quoting & submitting ${ca}...`, flags.progress !== false)
              try {
                baseResult = await sellBase({
                  ca,
                  percent,
                  reason,
                  walletRef,
                  slippageBps,
                  dryRun,
                  protectedExec: sellProtected,
                  rpcUrl: baseRpc,
                  priorityFeeWei,
                })
              } catch (e: any) {
                prog.fail()
                emitRouteErrorIfApplicable(e)
                err(e.message || 'sell (base) failed', EXIT.GENERAL)
              }
              prog.done('Base sell confirmed')
              log(`wallet sell: base ${ca} ${percent}% (${baseResult!.txHash})`)
              if (!AGENT_MODE) {
                const tag = baseResult!.dryRun ? `${t.warn}[dry-run]${t.reset} ` : ''
                const protTag = baseResult!.protectedExec ? ` ${t.accent}[protected]${t.reset}` : ''
                const realizedAmt = baseResult!.realized.amount
                const pnlColor = realizedAmt >= 0 ? t.success : t.error
                const closedTag = baseResult!.positionStatus === 'closed' ? ` ${t.muted}[closed]${t.reset}` : ''
                console.log(`\n  ${t.success}${icon.success} ${tag}Base sell executed${protTag}${closedTag}${t.reset}`)
                if (baseResult!.approvalTxHash) {
                  console.log(`  ${t.muted}approval:${t.reset} ${baseResult!.approvalTxHash}`)
                }
                console.log(`  ${t.muted}tx:${t.reset}        ${baseResult!.txHash}`)
                console.log(`  ${t.muted}sold:${t.reset}      ${baseResult!.tokensIn} tokens (${percent}%)`)
                console.log(`  ${t.muted}received:${t.reset}  ${baseResult!.output.display}`)
                {
                  const unit = baseResult!.realized.asset
                  const decimals = unit === 'USDC' ? 2 : 6
                  console.log(`  ${t.muted}realized:${t.reset}  ${pnlColor}${realizedAmt >= 0 ? '+' : ''}${realizedAmt.toFixed(decimals)} ${unit}${t.reset}`)
                }
                console.log(`  ${t.muted}reason:${t.reset}    ${reason}`)
                if (baseResult!.protectedExec) {
                  console.log(`  ${t.muted}rpc:${t.reset}       ${baseResult!.rpcUrl}`)
                }
                console.log()
              } else {
                print(baseResult!)
              }
              break
            }

            const jitoTipLamports = flags.tip ? Number(flags.tip) : undefined

            const { sell } = await import('./wallet-trading.js')
            let result: Awaited<ReturnType<typeof sell>>
            const sellProg = tradeProgress('submitting', `Selling ${percent}% on Solana — quoting & submitting ${ca}...`, flags.progress !== false)
            try {
              result = await sell({
                ca,
                percent,
                reason,
                walletRef,
                slippageBps,
                dryRun,
                protectedExec: sellProtected,
                autoSlippage: sellAutoSlippage,
                jitoTipLamports,
              })
            } catch (e: any) {
              sellProg.fail()
              emitRouteErrorIfApplicable(e)
              err(e.message || 'sell failed', EXIT.GENERAL)
            }
            sellProg.done('Solana sell confirmed')

            log(`wallet sell: ${ca} ${percent}% (${result!.txSignature})`)

            if (!AGENT_MODE) {
              const tag = result!.dryRun ? `${t.warn}[dry-run]${t.reset} ` : ''
              const protTag = result!.protectedExec ? ` ${t.accent}[protected]${t.reset}` : ''
              const realizedAmt = result!.realized.amount
              const pnlColor = realizedAmt >= 0 ? t.success : t.error
              const closedTag = result!.positionStatus === 'closed' ? ` ${t.muted}[closed]${t.reset}` : ''
              console.log(`\n  ${t.success}${icon.success} ${tag}Sell executed${protTag}${closedTag}${t.reset}`)
              console.log(`  ${t.muted}tx:${t.reset}        ${result!.txSignature}`)
              console.log(`  ${t.muted}sold:${t.reset}      ${result!.tokensIn} tokens (${percent}%)`)
              console.log(`  ${t.muted}received:${t.reset}  ${result!.output.display}`)
              console.log(`  ${t.muted}slippage:${t.reset}  ${result!.slippageBpsUsed}bps (${result!.slippageSource})`)
              if (result!.protectedExec) {
                console.log(`  ${t.muted}tip:${t.reset}       ${result!.tipLamports} lamports (Jito)`)
              }
              console.log(`  ${t.muted}fee:${t.reset}       ${result!.feeLamports} lamports`)
              {
                const unit = result!.realized.asset
                const decimals = unit === 'USDC' ? 2 : 6
                console.log(`  ${t.muted}realized:${t.reset}  ${pnlColor}${realizedAmt >= 0 ? '+' : ''}${realizedAmt.toFixed(decimals)} ${unit}${t.reset}`)
              }
              console.log(`  ${t.muted}reason:${t.reset}    ${reason}`)
              if (result!.forensics && result!.forensics.flag === 'suspect-mev') {
                console.log(`  ${t.warn}⚠ forensics: realized ${result!.forensics.realizedSlippageBps.toFixed(0)}bps slippage (${(result!.forensics.budgetUsed * 100).toFixed(0)}% of budget) — suspect MEV${t.reset}`)
              }
              console.log()
            } else {
              print(result!)
            }
            break
          }
          case 'sync': {
            const walletRef = (flags.wallet as string) || undefined
            const chainFlag = ((flags.chain as string) || '').toLowerCase()
            if (chainFlag && chainFlag !== 'solana' && chainFlag !== 'base') {
              err(`Unsupported --chain: ${chainFlag}. Try: solana, base`, EXIT.BAD_INPUT)
            }

            const wantSolana = !chainFlag || chainFlag === 'solana'
            const wantBase = !chainFlag || chainFlag === 'base'

            const { sync: doSync, syncBase } = await import('./wallet-trading.js')
            let solReport: Awaited<ReturnType<typeof doSync>> | null = null
            let baseReport: Awaited<ReturnType<typeof syncBase>> | null = null
            let solError: string | null = null
            let baseError: string | null = null

            // Sync both chains by default. A failure on one chain doesn't
            // block the other — we surface per-chain errors in the output.
            // Solana sync supports env-keypair fallback; Base requires walletRef.
            if (wantSolana) {
              try {
                solReport = await doSync({ walletRef })
              } catch (e: any) {
                solError = e?.message ?? String(e)
              }
            }
            if (wantBase) {
              if (!walletRef) {
                if (chainFlag === 'base') {
                  err('--wallet required for Base sync. Use a vault wallet name/id or `trading:N`.', EXIT.BAD_INPUT)
                }
                // Cross-chain default without walletRef: skip Base silently (no derivable EVM address).
              } else {
                try {
                  baseReport = await syncBase({ walletRef })
                } catch (e: any) {
                  baseError = e?.message ?? String(e)
                }
              }
            }

            const totalPositions = (solReport?.positions.length ?? 0) + (baseReport?.positions.length ?? 0)
            log(`wallet sync: synced ${totalPositions} positions (sol=${solReport?.positions.length ?? 0} base=${baseReport?.positions.length ?? 0})`)

            if (!AGENT_MODE) {
              console.log()
              if (solReport) {
                section(wantBase ? 'Sync (solana)' : 'Sync')
                kv('Wallet', solReport.wallet)
                if (solReport.positions.length === 0) {
                  console.log(`  ${t.muted}No open Solana positions for this wallet.${t.reset}\n`)
                } else {
                  console.log()
                  table(
                    ['CA', 'BOOK', 'ON-CHAIN', 'DRIFT', 'UNREAL SOL', 'UNREAL %'],
                    solReport.positions.map((s) => [
                      s.mint.length > 12 ? `${s.mint.slice(0, 6)}..${s.mint.slice(-4)}` : s.mint,
                      s.bookRaw,
                      s.onchainRaw,
                      s.drift ? `⚠ ${s.drift}` : 'ok',
                      `${s.unrealizedSol >= 0 ? '+' : ''}${s.unrealizedSol.toFixed(6)}`,
                      `${s.unrealizedPct >= 0 ? '+' : ''}${s.unrealizedPct.toFixed(2)}%`,
                    ]),
                  )
                  console.log()
                }
              }
              if (solError) console.log(`  ${t.error}Solana sync error: ${solError}${t.reset}\n`)
              if (baseReport) {
                section('Sync (base)')
                kv('Wallet', baseReport.wallet)
                if (baseReport.positions.length === 0) {
                  console.log(`  ${t.muted}No open Base positions for this wallet.${t.reset}\n`)
                } else {
                  console.log()
                  table(
                    ['CA', 'BOOK', 'ON-CHAIN', 'DRIFT', 'UNREAL ETH', 'UNREAL %'],
                    baseReport.positions.map((s) => [
                      s.mint.length > 12 ? `${s.mint.slice(0, 6)}..${s.mint.slice(-4)}` : s.mint,
                      s.bookRaw,
                      s.onchainRaw,
                      s.drift ? `⚠ ${s.drift}` : 'ok',
                      `${s.unrealizedEth >= 0 ? '+' : ''}${s.unrealizedEth.toFixed(6)}`,
                      `${s.unrealizedPct >= 0 ? '+' : ''}${s.unrealizedPct.toFixed(2)}%`,
                    ]),
                  )
                  console.log()
                }
              }
              if (baseError) console.log(`  ${t.error}Base sync error: ${baseError}${t.reset}\n`)
            } else {
              print({
                solana: solReport,
                base: baseReport,
                errors: {
                  solana: solError,
                  base: baseError,
                },
              })
            }
            break
          }
          case 'pnl': {
            const by = ((flags.by as string) || '').toLowerCase()
            if (by && by !== 'wallet' && by !== 'chain') err(`--by must be 'wallet' or 'chain', got: ${by}`, EXIT.BAD_INPUT)
            const sinceIso = flags.since as string | undefined
            if (sinceIso && isNaN(Date.parse(sinceIso))) {
              err('--since must be a valid date (ISO 8601 or YYYY-MM-DD)', EXIT.BAD_INPUT)
            }
            // Parser maps `--no-usd` → `flags.usd = false`. Default to USD on.
            const wantUsd = flags.usd === false ? false : true

            const { computePnl } = await import('./wallet-trading.js')
            const report = await computePnl({
              by: (by || undefined) as 'wallet' | 'chain' | undefined,
              sinceIso,
              usd: wantUsd,
            })

            if (!AGENT_MODE) {
              console.log()
              section('PnL')
              const totalPositions = report.solana.count + report.base.count + report.usdc.count
              kv('Positions', `${totalPositions} (solana: ${report.solana.count}, base: ${report.base.count}, usdc: ${report.usdc.count})`)

              // Per-asset native breakdown
              if (report.solana.count > 0) {
                console.log()
                section('SOL')
                const realColor = report.solana.realized >= 0 ? t.success : t.error
                const unrealColor = report.solana.unrealized >= 0 ? t.success : t.error
                console.log(`  ${t.muted}Realized:${t.reset}    ${realColor}${report.solana.realized >= 0 ? '+' : ''}${report.solana.realized.toFixed(6)} SOL${t.reset}`)
                console.log(`  ${t.muted}Unrealized:${t.reset}  ${unrealColor}${report.solana.unrealized >= 0 ? '+' : ''}${report.solana.unrealized.toFixed(6)} SOL${t.reset}`)
                console.log(`  ${t.muted}Total:${t.reset}       ${report.solana.total >= 0 ? '+' : ''}${report.solana.total.toFixed(6)} SOL`)
              }
              if (report.base.count > 0) {
                console.log()
                section('ETH')
                const realColor = report.base.realized >= 0 ? t.success : t.error
                const unrealColor = report.base.unrealized >= 0 ? t.success : t.error
                console.log(`  ${t.muted}Realized:${t.reset}    ${realColor}${report.base.realized >= 0 ? '+' : ''}${report.base.realized.toFixed(6)} ETH${t.reset}`)
                console.log(`  ${t.muted}Unrealized:${t.reset}  ${unrealColor}${report.base.unrealized >= 0 ? '+' : ''}${report.base.unrealized.toFixed(6)} ETH${t.reset}`)
                console.log(`  ${t.muted}Total:${t.reset}       ${report.base.total >= 0 ? '+' : ''}${report.base.total.toFixed(6)} ETH`)
              }
              if (report.usdc.count > 0) {
                console.log()
                section('USDC')
                const realColor = report.usdc.realized >= 0 ? t.success : t.error
                const unrealColor = report.usdc.unrealized >= 0 ? t.success : t.error
                console.log(`  ${t.muted}Realized:${t.reset}    ${realColor}${report.usdc.realized >= 0 ? '+' : ''}$${report.usdc.realized.toFixed(2)}${t.reset}`)
                console.log(`  ${t.muted}Unrealized:${t.reset}  ${unrealColor}${report.usdc.unrealized >= 0 ? '+' : ''}$${report.usdc.unrealized.toFixed(2)}${t.reset}`)
                console.log(`  ${t.muted}Total:${t.reset}       ${report.usdc.total >= 0 ? '+' : ''}$${report.usdc.total.toFixed(2)}`)
              }

              // Cross-chain USD totals
              if (report.usd) {
                console.log()
                section('USD (cross-chain)')
                const realColor = report.usd.realized >= 0 ? t.success : t.error
                const unrealColor = report.usd.unrealized >= 0 ? t.success : t.error
                console.log(`  ${t.muted}Realized:${t.reset}    ${realColor}${report.usd.realized >= 0 ? '+' : ''}$${report.usd.realized.toFixed(2)}${t.reset}`)
                console.log(`  ${t.muted}Unrealized:${t.reset}  ${unrealColor}${report.usd.unrealized >= 0 ? '+' : ''}$${report.usd.unrealized.toFixed(2)}${t.reset}`)
                console.log(`  ${t.muted}Total:${t.reset}       ${report.usd.total >= 0 ? '+' : ''}$${report.usd.total.toFixed(2)}`)
                const priceParts: string[] = []
                if (report.usd.solPriceUsd !== null) priceParts.push(`SOL=$${report.usd.solPriceUsd.toFixed(2)}`)
                if (report.usd.ethPriceUsd !== null) priceParts.push(`ETH=$${report.usd.ethPriceUsd.toFixed(2)}`)
                if (priceParts.length > 0) {
                  console.log(`  ${t.muted}Prices:${t.reset}      ${priceParts.join('  ')}`)
                }
              } else if (wantUsd && totalPositions > 0) {
                console.log()
                console.log(`  ${t.muted}(USD totals unavailable — price lookups failed; use --no-usd to suppress)${t.reset}`)
              }

              if (report.byGroup && report.byGroup.length > 0) {
                console.log()
                section(`By ${by}`)
                table(
                  [by.toUpperCase(), 'COUNT', 'REALIZED', 'UNREALIZED', 'UNIT'],
                  report.byGroup.map((g) => {
                    const dec = g.unit === 'USDC' ? 2 : 6
                    return [
                      g.key.length > 16 ? `${g.key.slice(0, 6)}..${g.key.slice(-4)}` : g.key,
                      String(g.count),
                      `${g.realized >= 0 ? '+' : ''}${g.realized.toFixed(dec)}`,
                      `${g.unrealized >= 0 ? '+' : ''}${g.unrealized.toFixed(dec)}`,
                      g.unit,
                    ]
                  }),
                )
              }
              console.log()
            } else {
              print(report)
            }
            break
          }
          case 'journal': {
            const sub = positional[0]
            if (sub === 'add') {
              const ca = positional[1] || (flags.ca as string) || null
              const note = flags.note as string
              if (!note) err('--note required: palmyr wallet journal add <CA> --note "..."', EXIT.BAD_INPUT)
              const { appendJournal } = await import('./wallet-trading.js')
              const r = appendJournal(ca || null, note)
              if (!AGENT_MODE) {
                console.log(`\n  ${t.success}${icon.success} Journal entry added${t.reset}`)
                console.log(`  ${t.muted}file:${t.reset} ${r.file}`)
                console.log()
              } else {
                print({ success: true, ...r })
              }
              break
            }
            if (sub === 'show' || !sub) {
              const ca = flags.ca as string | undefined
              const date = flags.date as string | undefined
              const { readJournalIndex, readJournalDay } = await import('./wallet-trading.js')
              const index = readJournalIndex()
              let filtered = index
              if (ca) filtered = filtered.filter((e) => e.ca === ca)
              if (date) filtered = filtered.filter((e) => e.date === date)

              if (!AGENT_MODE) {
                if (filtered.length === 0) {
                  console.log(`\n  ${t.muted}No journal entries${ca || date ? ' matching filter' : ''}.${t.reset}\n`)
                  break
                }
                if (date) {
                  console.log(`\n${readJournalDay(date)}\n`)
                } else {
                  console.log()
                  table(
                    ['DATE', 'TIME', 'CA', 'NOTE'],
                    filtered.map((e) => [
                      e.date,
                      e.ts.slice(11, 19),
                      e.ca ? (e.ca.length > 12 ? `${e.ca.slice(0, 6)}..${e.ca.slice(-4)}` : e.ca) : '—',
                      e.note,
                    ]),
                  )
                  console.log()
                }
              } else {
                print({ entries: filtered })
              }
              break
            }
            err(`Unknown journal subcommand: ${sub}. Try: add, show`, EXIT.BAD_INPUT)
          }
          case 'watch': {
            const sub = positional[0]
            if (sub === 'add') {
              const ca = positional[1] || (flags.ca as string)
              if (!ca) err('CA required: palmyr wallet watch add <CA> --trigger "..."', EXIT.BAD_INPUT)
              const trigger = flags.trigger as string
              if (!trigger) err('--trigger required (what to look for)', EXIT.BAD_INPUT)
              const { appendWatch } = await import('./wallet-trading.js')
              const w = appendWatch({ ca, trigger })
              if (!AGENT_MODE) {
                console.log(`\n  ${t.success}${icon.success} Watching ${ca}${t.reset}`)
                console.log(`  ${t.muted}trigger:${t.reset} ${trigger}`)
                console.log()
              } else {
                print({ success: true, ...w })
              }
              break
            }
            if (sub === 'list' || !sub) {
              const { listWatch } = await import('./wallet-trading.js')
              const entries = listWatch()
              if (!AGENT_MODE) {
                if (entries.length === 0) {
                  console.log(`\n  ${t.muted}Watchlist is empty.${t.reset}\n`)
                  break
                }
                console.log()
                table(
                  ['ADDED', 'CA', 'TRIGGER'],
                  entries.map((e) => [
                    e.ts.slice(0, 19).replace('T', ' '),
                    e.ca.length > 12 ? `${e.ca.slice(0, 6)}..${e.ca.slice(-4)}` : e.ca,
                    e.trigger,
                  ]),
                )
                console.log()
              } else {
                print({ entries })
              }
              break
            }
            err(`Unknown watch subcommand: ${sub}. Try: add, list`, EXIT.BAD_INPUT)
          }
          case 'brief': {
            const ca = positional[0] || (flags.ca as string)
            if (!ca) err('CA required: palmyr wallet brief <CA>', EXIT.BAD_INPUT)
            const evaluate = !!flags.evaluate
            const briefChainFlag = ((flags.chain as string) || '').toLowerCase()
            if (briefChainFlag && briefChainFlag !== 'solana' && briefChainFlag !== 'base') {
              err(`Unsupported chain: ${briefChainFlag}. Try: solana, base`, EXIT.BAD_INPUT)
            }
            const briefWalletRef = (flags.wallet as string) || undefined

            // Pick a chain to search in. Priority:
            //   1. explicit --chain
            //   2. inferred from the CA format (0x-prefix → base, otherwise solana)
            //   3. fall back to scanning both (legacy behaviour)
            const inferredChain: 'solana' | 'base' | undefined = briefChainFlag
              ? (briefChainFlag as 'solana' | 'base')
              : ca.startsWith('0x')
                ? 'base'
                : 'solana'

            // When --wallet is given, scope the read to that wallet's chain-
            // appropriate address. Vault wallets have both Solana and EVM
            // addresses; we pick whichever matches the inferred chain.
            const { readPosition, resolveWalletAddresses } = await import('./wallet-trading.js')
            let scopedAddr: string | undefined
            if (briefWalletRef) {
              const resolved = await resolveWalletAddresses(briefWalletRef)
              scopedAddr = inferredChain === 'base' ? (resolved.evmAddress ?? undefined) : (resolved.solanaAddress ?? undefined)
            }
            const p = readPosition(inferredChain, ca, scopedAddr)
            if (!p) err(`Position not found: ${ca}`, EXIT.NOT_FOUND)

            // `--evaluate` degrades gracefully: a missing ANTHROPIC_API_KEY or
            // a model-API failure must NOT take down the whole brief. We surface
            // the LLM error as `llmError` so agents can branch on it, and still
            // print the deterministic brief fields.
            let llm: Awaited<ReturnType<typeof import('./wallet-brief-llm.js').evaluateBriefWithLLM>> | undefined
            let llmError: string | undefined
            if (evaluate) {
              const { evaluateBriefWithLLM } = await import('./wallet-brief-llm.js')
              try {
                llm = await evaluateBriefWithLLM(p!)
              } catch (e: any) {
                llmError = e?.message ?? 'brief --evaluate failed'
              }
            }

            if (!AGENT_MODE) {
              console.log()
              section('Brief')
              kv('CA', p!.mint)
              kv('Status', p!.status)
              kv('Entry', `${p!.entry.amountIn} → ${p!.entry.tokensOut} (${p!.entry.time})`)
              console.log()
              section('Thesis')
              console.log(`  ${p!.thesis}`)
              console.log()
              section('Current')
              const pnlColor = p!.pnl.unrealizedPct >= 0 ? t.success : t.error
              // Canonical asset-tagged pnl — normalizePosition guarantees these
              // exist on read, including back-fill from legacy on-disk fields.
              const realizedAmt = p!.pnl.realized?.amount ?? 0
              const realizedAsset = p!.pnl.realized?.asset ?? (p!.chain === 'solana' ? 'SOL' : 'ETH')
              const unrealizedAmt = p!.pnl.unrealized?.amount ?? 0
              const unrealizedAsset = p!.pnl.unrealized?.asset ?? realizedAsset
              kv('Realized', `${realizedAmt >= 0 ? '+' : ''}${realizedAmt.toFixed(6)} ${realizedAsset}`)
              console.log(`  ${t.muted}Unrealized:${t.reset}  ${pnlColor}${unrealizedAmt >= 0 ? '+' : ''}${unrealizedAmt.toFixed(6)} ${unrealizedAsset} (${p!.pnl.unrealizedPct.toFixed(2)}%)${t.reset}`)
              kv('Last priced', p!.pnl.lastPricedAt || 'never (run `wallet sync`)')
              if (llm) {
                console.log()
                section(`LLM Assessment (${llm.model})`)
                const holdsColor = llm.thesisHolds === 'yes' ? t.success : llm.thesisHolds === 'no' ? t.error : t.warn
                console.log(`  ${t.muted}Thesis holds:${t.reset}    ${holdsColor}${llm.thesisHolds}${t.reset}`)
                console.log(`  ${t.muted}Action:${t.reset}          ${llm.recommendedAction}`)
                console.log(`  ${t.muted}Reasoning:${t.reset}       ${llm.reasoning}`)
                console.log(`  ${t.muted}Watch for:${t.reset}       ${llm.watchFor}`)
              } else if (llmError) {
                console.log()
                console.log(`  ${t.warn}LLM eval skipped: ${llmError}${t.reset}`)
              } else {
                console.log()
                console.log(`  ${t.muted}Add --evaluate for an LLM thesis-health check.${t.reset}`)
              }
              console.log()
            } else {
              print({
                ca: p!.mint,
                status: p!.status,
                entry: p!.entry,
                thesis: p!.thesis,
                exitPlan: p!.exitPlan,
                monitorState: p!.monitorState,
                pnl: p!.pnl,
                sellsCount: p!.sells.length,
                llm,
                llmError,
              })
            }
            break
          }
          case 'doctor': {
            // Wallet-trading health check. Walks dep versions, RPC reachability,
            // wallet derivation, and trading dir writability. Returns a stable
            // {status, checks[]} shape so agents can branch on individual checks.
            const doctorWalletRef = (flags.wallet as string) || undefined
            const { runWalletDoctor } = await import('./wallet-doctor.js')
            const report = await runWalletDoctor({ walletRef: doctorWalletRef, cliVersion: VERSION })
            if (AGENT_MODE) {
              print(report)
              if (report.status === 'fail') process.exit(EXIT.GENERAL)
              break
            }
            console.log()
            section('Wallet doctor')
            kv('Overall', report.status === 'ok'
              ? `${t.success}ok${t.reset}`
              : report.status === 'warning'
                ? `${t.warn}warning${t.reset}`
                : `${t.error}fail${t.reset}`)
            kv('CLI', report.cliVersion)
            kv('Node', report.nodeVersion)
            kv('Platform', report.platform)
            if (report.wallet) {
              kv('Wallet', report.wallet)
              if (report.solanaAddress) kv('Solana', report.solanaAddress)
              if (report.evmAddress) kv('EVM', report.evmAddress)
            }
            console.log()
            section('Checks')
            for (const c of report.checks) {
              const dot = c.status === 'pass'
                ? `${t.success}✓${t.reset}`
                : c.status === 'warn'
                  ? `${t.warn}!${t.reset}`
                  : c.status === 'skip'
                    ? `${t.muted}-${t.reset}`
                    : `${t.error}✗${t.reset}`
              const trail = [c.value, c.message].filter(Boolean).join(' — ')
              console.log(`  ${dot} ${c.name}${trail ? `: ${trail}` : ''}`)
            }
            console.log()
            if (report.status === 'fail') process.exit(EXIT.GENERAL)
            break
          }
          case 'pay-preflight': {
            // Five-question readiness check for the x402 pay flow. Local-only
            // siblings of this same module run automatically before every paid
            // command (see paidRequest/paidStreamRequest); this command is the
            // explicit, full-fat version with the RPC USDC balance check.
            const ppChain = (flags.chain as string | undefined)?.toLowerCase()
            if (ppChain && ppChain !== 'solana' && ppChain !== 'base') {
              err(`--chain must be solana or base (got ${ppChain})`, EXIT.BAD_INPUT)
            }
            const ppWallet = (flags.wallet as string) || undefined
            const ppMinUsdcRaw = flags['min-usdc']
            const ppMinUsdc = typeof ppMinUsdcRaw === 'string' ? Number(ppMinUsdcRaw) : undefined
            if (ppMinUsdc !== undefined && (!Number.isFinite(ppMinUsdc) || ppMinUsdc < 0)) {
              err(`--min-usdc must be a non-negative number (got ${String(ppMinUsdcRaw)})`, EXIT.BAD_INPUT)
            }
            const { fullPreflight } = await import('./pay-preflight.js')
            const report = await fullPreflight({
              ...(ppChain ? { chain: ppChain as 'solana' | 'base' } : {}),
              ...(ppWallet ? { walletRef: ppWallet } : {}),
              ...(ppMinUsdc !== undefined ? { minUsdc: ppMinUsdc } : {}),
              ...(passphrase ? { passphrase } : {}),
            })
            if (AGENT_MODE) {
              print(report)
              if (!report.ok) process.exit(EXIT.GENERAL)
              break
            }
            // TTY rendering — mirrors the doctor command's layout.
            console.log()
            section('Pay preflight')
            kv('Verdict', report.ok ? `${t.success}ready${t.reset}` : `${t.error}not ready${t.reset}`)
            kv('Pay chain', report.payChain)
            kv('Wallet ID', report.walletId || `${t.muted}(none)${t.reset}`)
            kv('Address', report.walletAddress || `${t.muted}(unknown)${t.reset}`)
            kv('Can decrypt', report.canDecrypt ? `${t.success}yes${t.reset}` : `${t.error}no${t.reset}`)
            if (report.usdc) {
              const bal = report.usdc.balance
              kv('USDC balance', bal === null ? `${t.muted}(unknown)${t.reset}` : `${bal.toFixed(6)} USDC`)
              if (report.usdc.requiredMin > 0) kv('Required min', `${report.usdc.requiredMin.toFixed(6)} USDC`)
              if (report.usdc.ataStatus) kv('Solana ATA', report.usdc.ataStatus)
            }
            if (report.fix) {
              console.log()
              console.log(`  ${t.warn}Fix:${t.reset} ${report.fix}`)
            }
            console.log()
            if (!report.ok) process.exit(EXIT.GENERAL)
            break
          }
          case 'smoke-test': {
            const smokeWalletRef = (flags.wallet as string) || undefined
            if (!smokeWalletRef) err('--wallet required. Use a vault wallet name/id or `trading:N`.', EXIT.BAD_INPUT)
            const smokeChainFlag = ((flags.chain as string) || 'all').toLowerCase()
            if (smokeChainFlag !== 'solana' && smokeChainFlag !== 'base' && smokeChainFlag !== 'all') {
              err(`--chain must be solana, base, or all (got ${smokeChainFlag})`, EXIT.BAD_INPUT)
            }
            const { runWalletSmokeTest } = await import('./wallet-smoke-test.js')
            const report = await runWalletSmokeTest({
              walletRef: smokeWalletRef,
              chain: smokeChainFlag as 'solana' | 'base' | 'all',
            })
            if (AGENT_MODE) {
              print(report)
              if (!report.safeForAutonomousTrading) process.exit(EXIT.GENERAL)
              break
            }
            console.log()
            section('Wallet smoke-test')
            kv('Wallet', report.wallet)
            kv('Mode', report.mode)
            if (report.solanaAddress) kv('Solana', report.solanaAddress)
            if (report.evmAddress) kv('EVM', report.evmAddress)
            kv('Verdict', report.safeForAutonomousTrading
              ? `${t.success}safe for autonomous trading${t.reset}`
              : `${t.error}NOT safe — investigate failed legs${t.reset}`)
            console.log()
            section('Legs')
            for (const leg of report.legs) {
              const dot = leg.status === 'pass'
                ? `${t.success}✓${t.reset}`
                : leg.status === 'skip'
                  ? `${t.muted}-${t.reset}`
                  : `${t.error}✗${t.reset}`
              const tail = [leg.message, leg.durationMs !== undefined ? `${leg.durationMs}ms` : null].filter(Boolean).join(' — ')
              console.log(`  ${dot} ${leg.chain}/${leg.name}${tail ? `: ${tail}` : ''}`)
            }
            console.log()
            if (!report.safeForAutonomousTrading) process.exit(EXIT.GENERAL)
            break
          }
          case 'readiness': {
            const readyWalletRef = (flags.wallet as string) || undefined
            if (!readyWalletRef) err('--wallet required. Use a vault wallet name/id or `trading:N`.', EXIT.BAD_INPUT)
            const { runWalletReadiness } = await import('./wallet-readiness.js')
            const report = await runWalletReadiness({ walletRef: readyWalletRef })
            if (AGENT_MODE) {
              print(report)
              if (!report.safeForAutonomousTrading) process.exit(EXIT.GENERAL)
              break
            }
            console.log()
            section('Wallet readiness')
            kv('Wallet', report.wallet)
            if (report.solanaAddress) kv('Solana', report.solanaAddress)
            if (report.evmAddress) kv('EVM', report.evmAddress)
            kv('Verdict', report.safeForAutonomousTrading
              ? `${t.success}safe for autonomous trading${t.reset}`
              : `${t.error}NOT safe — see failing checks${t.reset}`)
            if (report.balances.solana) kv('SOL balance', `${report.balances.solana.sol.toFixed(6)} SOL`)
            if (report.balances.base) kv('ETH balance', `${report.balances.base.eth.toFixed(8)} ETH`)
            kv('Open positions', `solana=${report.openPositions.solana} base=${report.openPositions.base}`)
            kv('Daemon', report.daemon.running
              ? `${t.success}running${t.reset} (pid ${report.daemon.pid}${report.daemon.autoExecute ? ', auto-execute' : ''})`
              : `${t.warn}not running${t.reset}`)
            console.log()
            section('Checks')
            for (const c of report.checks) {
              const dot = c.status === 'pass' ? `${t.success}✓${t.reset}`
                : c.status === 'warn' ? `${t.warn}!${t.reset}`
                : c.status === 'skip' ? `${t.muted}-${t.reset}`
                : `${t.error}✗${t.reset}`
              const tail = [c.value !== undefined ? String(c.value) : null, c.message].filter(Boolean).join(' — ')
              console.log(`  ${dot} ${c.name}${tail ? `: ${tail}` : ''}`)
            }
            console.log()
            if (!report.safeForAutonomousTrading) process.exit(EXIT.GENERAL)
            break
          }
          case 'live-test': {
            const liveWalletRef = (flags.wallet as string) || undefined
            if (!liveWalletRef) err('--wallet required. Use a vault wallet name/id or `trading:N`.', EXIT.BAD_INPUT)
            const budgetRaw = flags.budget as string | undefined
            if (!budgetRaw) err('--budget required, e.g. --budget 1usdc (caps total trade exposure).', EXIT.BAD_INPUT)
            const budgetMatch = (budgetRaw ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*usdc$/i)
            if (!budgetMatch) err(`--budget must be in USDC (e.g. "0.5usdc", "1usdc"), got "${budgetRaw}".`, EXIT.BAD_INPUT)
            const budgetUsdc = Number(budgetMatch![1])
            const liveChainFlag = ((flags.chain as string) || 'all').toLowerCase()
            if (liveChainFlag !== 'solana' && liveChainFlag !== 'base' && liveChainFlag !== 'all') {
              err(`--chain must be solana, base, or all (got ${liveChainFlag})`, EXIT.BAD_INPUT)
            }
            const { runWalletLiveTest } = await import('./wallet-live-test.js')
            let report: Awaited<ReturnType<typeof runWalletLiveTest>>
            try {
              report = await runWalletLiveTest({
                walletRef: liveWalletRef!,
                budgetUsdc,
                chain: liveChainFlag as 'solana' | 'base' | 'all',
              })
            } catch (e: any) {
              err(e.message || 'live-test failed', EXIT.GENERAL)
            }
            if (AGENT_MODE) {
              print(report!)
              if (!report!.safeForAutonomousTrading) process.exit(EXIT.GENERAL)
              break
            }
            console.log()
            section('Wallet live-test')
            kv('Wallet', report!.wallet)
            kv('Budget', `${report!.budgetUsdc.toFixed(6)} USDC (per leg ${report!.perLegUsdc.toFixed(6)} USDC)`)
            kv('Verdict', report!.safeForAutonomousTrading
              ? `${t.success}safe for autonomous trading${t.reset}`
              : `${t.error}NOT safe — see failing legs${t.reset}`)
            kv('Total realized', `${report!.totalRealizedUsdc >= 0 ? '+' : ''}${report!.totalRealizedUsdc.toFixed(6)} USDC`)
            kv('Open positions after', String(report!.openPositionsAfter))
            console.log()
            section('Legs')
            for (const leg of report!.legs) {
              const dot = leg.status === 'pass' ? `${t.success}✓${t.reset}`
                : leg.status === 'skip' ? `${t.muted}-${t.reset}`
                : `${t.error}✗${t.reset}`
              const realizedStr = leg.realized
                ? `; realized ${leg.realized.amount >= 0 ? '+' : ''}${leg.realized.amount.toFixed(6)} ${leg.realized.asset}`
                : ''
              const txStr = leg.txHash ? ` (${leg.txHash.slice(0, 10)}…)` : ''
              const detail = [leg.message, leg.durationMs !== undefined ? `${leg.durationMs}ms` : null].filter(Boolean).join(' — ')
              console.log(`  ${dot} ${leg.chain}/${leg.name}${txStr}${realizedStr}${detail ? `: ${detail}` : ''}`)
            }
            console.log()
            if (!report!.safeForAutonomousTrading) process.exit(EXIT.GENERAL)
            break
          }
          case 'daemon': {
            const sub = positional[0]
            if (!sub) err('daemon subcommand required. Try: tick, start, stop, status', EXIT.BAD_INPUT)
            const intervalSeconds = flags.interval ? Number(flags.interval) : 30
            const autoExecute = !!flags.auto
            const walletRef = (flags.wallet as string) || undefined

            if (sub === 'tick') {
              const { daemonTick } = await import('./wallet-daemon.js')
              let report: Awaited<ReturnType<typeof daemonTick>>
              try {
                report = await daemonTick({ intervalSeconds, autoExecute, walletRef })
              } catch (e: any) {
                err(e.message || 'tick failed', EXIT.GENERAL)
              }
              log(`wallet daemon tick: synced ${report!.syncedPositions} (sol=${report!.syncedSolana} base=${report!.syncedBase}), fired ${report!.fires.length}`)
              if (!AGENT_MODE) {
                console.log(`\n  ${t.success}${icon.success} Tick complete${t.reset}`)
                console.log(`  ${t.muted}synced:${t.reset}  ${report!.syncedPositions} position(s) (solana: ${report!.syncedSolana}, base: ${report!.syncedBase})`)
                console.log(`  ${t.muted}fired:${t.reset}   ${report!.fires.length} trigger(s)`)
                if (report!.errors.length > 0) {
                  console.log()
                  for (const e of report!.errors) {
                    console.log(`  ${t.warn}⚠ ${e.chain} sync error: ${e.message}${t.reset}`)
                  }
                }
                if (report!.fires.length > 0) {
                  console.log()
                  for (const f of report!.fires) {
                    const tag = f.autoExecuted ? `${t.success}[executed]${t.reset}` : `${t.warn}[pending]${t.reset}`
                    const errTag = f.error ? ` ${t.error}error: ${f.error}${t.reset}` : ''
                    const caShort = f.mint.length > 12 ? `${f.mint.slice(0,6)}..${f.mint.slice(-4)}` : f.mint
                    console.log(`  ${tag} ${f.chain}/${f.trigger} on ${caShort}: current ${f.currentPct.toFixed(2)}% vs threshold ${f.thresholdPct}%${errTag}`)
                  }
                }
                console.log()
              } else {
                print(report!)
              }
              break
            }

            if (sub === 'start') {
              const { startDaemon } = await import('./wallet-daemon.js')
              let r: Awaited<ReturnType<typeof startDaemon>>
              try {
                r = await startDaemon({ intervalSeconds, autoExecute, walletRef })
              } catch (e: any) {
                err(e.message || 'daemon start failed', EXIT.GENERAL)
              }
              log(`wallet daemon start: pid=${r!.pid}`)
              if (!AGENT_MODE) {
                console.log(`\n  ${t.success}${icon.success} Daemon started${t.reset}`)
                console.log(`  ${t.muted}pid:${t.reset}       ${r!.pid}`)
                console.log(`  ${t.muted}interval:${t.reset}  ${intervalSeconds}s`)
                console.log(`  ${t.muted}auto:${t.reset}      ${autoExecute ? 'yes' : 'no'}`)
                console.log(`  ${t.muted}wallet:${t.reset}    ${walletRef || 'env'}`)
                console.log(`\n  Stop with: ${t.info}palmyr wallet daemon stop${t.reset}\n`)
              } else {
                print({ success: true, pid: r!.pid, intervalSeconds, autoExecute, walletRef })
              }
              break
            }

            if (sub === 'stop') {
              const { stopDaemon } = await import('./wallet-daemon.js')
              const r = await stopDaemon()
              log(`wallet daemon stop: wasRunning=${r.wasRunning}`)
              if (!AGENT_MODE) {
                if (r.wasRunning) {
                  console.log(`\n  ${t.success}${icon.success} Daemon stopped${t.reset} (was PID ${r.pid})\n`)
                } else {
                  console.log(`\n  ${t.muted}No daemon running.${t.reset}\n`)
                }
              } else {
                print({ success: true, ...r })
              }
              break
            }

            if (sub === 'status') {
              const { getDaemonStatus } = await import('./wallet-daemon.js')
              const r = getDaemonStatus()
              if (!AGENT_MODE) {
                console.log()
                section('Daemon')
                kv('Running', r.running ? 'yes' : 'no')
                kv('PID', r.pid ? String(r.pid) : '—')
                kv('Last tick', r.lastTick || '—')
                if (r.opts) {
                  kv('Interval', `${r.opts.intervalSeconds}s`)
                  kv('Auto-execute', r.opts.autoExecute ? 'yes' : 'no')
                  kv('Wallet', r.opts.walletRef || 'env')
                }
                console.log()
              } else {
                print(r)
              }
              break
            }

            if (sub === '_run') {
              // Hidden: invoked by the detached daemon child. Never returns
              // unless SIGTERM/SIGINT is received.
              const { runDaemonLoop } = await import('./wallet-daemon.js')
              await runDaemonLoop({ intervalSeconds, autoExecute, walletRef })
              break
            }

            err(`Unknown daemon subcommand: ${sub}. Try: tick, start, stop, status`, EXIT.BAD_INPUT)
          }
          case 'triggers': {
            const caFilter = flags.ca as string | undefined
            const sinceIso = flags.since as string | undefined
            const clearFlag = !!flags.clear

            const { listPendingTriggers, clearPendingTriggers } = await import('./wallet-daemon.js')
            const fires = listPendingTriggers({ ca: caFilter, sinceIso })

            if (!AGENT_MODE) {
              if (fires.length === 0) {
                console.log(`\n  ${t.muted}No pending trigger fires.${t.reset}\n`)
                if (clearFlag) clearPendingTriggers()
                break
              }
              console.log()
              table(
                ['TIME', 'CA', 'TRIGGER', 'THRESHOLD', 'CURRENT', 'STATUS'],
                fires.map((f) => [
                  f.ts.slice(0, 19).replace('T', ' '),
                  f.mint.length > 12 ? `${f.mint.slice(0, 6)}..${f.mint.slice(-4)}` : f.mint,
                  f.trigger,
                  `${f.thresholdPct}%`,
                  `${f.currentPct.toFixed(2)}%`,
                  f.autoExecuted
                    ? (f.error ? `error: ${f.error}` : `executed (${f.linkedSellTx?.slice(0, 6)}..)`)
                    : 'pending',
                ]),
              )
              console.log()
              if (clearFlag) {
                clearPendingTriggers()
                console.log(`  ${t.muted}${fires.length} fire(s) cleared.${t.reset}\n`)
              }
            } else {
              if (clearFlag) clearPendingTriggers()
              print({ fires })
            }
            break
          }
          case 'evm-quote': {
            const src = positional[0]
            const dst = positional[1]
            if (!src || !dst) err('Usage: palmyr wallet evm-quote <SRC> <DST> --amount <raw>', EXIT.BAD_INPUT)
            const amount = flags.amount as string
            if (!amount) err('--amount <raw> required (in src smallest unit, e.g. wei)', EXIT.BAD_INPUT)
            const chainStr = ((flags.chain as string) || 'base').toLowerCase()
            const chainId = chainStr === 'base' ? 8453 : Number(chainStr)
            if (!Number.isInteger(chainId) || chainId <= 0) err(`Unsupported --chain: ${chainStr}`, EXIT.BAD_INPUT)
            const srcDecimals = flags['src-decimals'] ? Number(flags['src-decimals']) : 18
            const dstDecimals = flags['dst-decimals'] ? Number(flags['dst-decimals']) : 6

            const { fetchParaswapPrice, NATIVE_ETH } = await import('./evm-trading.js')
            const srcToken = src.toLowerCase() === 'eth' ? NATIVE_ETH : src
            const dstToken = dst.toLowerCase() === 'eth' ? NATIVE_ETH : dst

            let route
            try {
              route = await fetchParaswapPrice({
                srcToken,
                destToken: dstToken,
                amount,
                srcDecimals,
                destDecimals: dstDecimals,
                network: chainId,
              })
            } catch (e: any) {
              err(e.message || 'evm-quote failed', EXIT.NETWORK)
            }

            log(`wallet evm-quote: ${srcToken.slice(0, 8)}->${dstToken.slice(0, 8)} on chain ${chainId}`)

            if (!AGENT_MODE) {
              console.log()
              section('EVM quote (ParaSwap)')
              kv('Chain', String(chainId))
              kv('From', `${route!.srcAmount} (${srcToken.slice(0, 10)}..., dec ${route!.srcDecimals})`)
              kv('To', `${route!.destAmount} (${dstToken.slice(0, 10)}..., dec ${route!.destDecimals})`)
              const rate = Number(BigInt(route!.destAmount)) / Math.pow(10, route!.destDecimals)
                          / (Number(BigInt(route!.srcAmount)) / Math.pow(10, route!.srcDecimals))
              kv('Rate', `1 src → ${rate.toFixed(6)} dst`)
              kv('Gas est', String(route!.gasCost))
              kv('Block', String(route!.blockNumber))
              console.log()
            } else {
              print(route!)
            }
            break
          }
          case 'trading-keystore': {
            const sub = positional[0]
            if (!sub) err('trading-keystore subcommand required. Try: init, list, status, derive, export', EXIT.BAD_INPUT)

            if (sub === 'init') {
              let pass = process.env.PALMYR_TRADING_KEYSTORE_PASSPHRASE
              if (!pass) {
                const { promptNewPassphrase } = await import('./passphrase-prompt.js')
                try {
                  pass = await promptNewPassphrase()
                } catch (e: any) {
                  err(e.message || 'failed to get passphrase', EXIT.AUTH_FAIL)
                }
              }
              const count = flags.count ? Number(flags.count) : 5
              if (!Number.isInteger(count) || count <= 0) err('--count must be a positive integer', EXIT.BAD_INPUT)
              const mnemonic = (flags.mnemonic as string) || undefined

              const { initKeystore } = await import('./wallet-trading-keystore.js')
              let file: Awaited<ReturnType<typeof initKeystore>>
              try {
                file = initKeystore({ passphrase: pass!, count, mnemonic })
              } catch (e: any) {
                err(e.message || 'init failed', EXIT.GENERAL)
              }

              log(`wallet trading-keystore init: ${file!.addresses.length} wallets`)

              if (!AGENT_MODE) {
                console.log(`\n  ${t.success}${icon.success} Trading keystore initialized + unlocked${t.reset}`)
                console.log(`  ${t.muted}wallets:${t.reset}`)
                for (const a of file!.addresses) {
                  console.log(`    ${t.muted}[${a.index}]${t.reset} ${a.address}`)
                }
                console.log(`\n  ${t.warn}⚠  Back up your passphrase + mnemonic.${t.reset}`)
                console.log(`  ${t.muted}Recover the mnemonic via: palmyr wallet trading-keystore export --confirm${t.reset}\n`)
              } else {
                print({ success: true, addresses: file!.addresses, count: file!.addresses.length, unlocked: true })
              }
              break
            }

            if (sub === 'unlock') {
              const { unlockAndCache, isUnlocked, DEFAULT_KEYSTORE_CACHE_TTL_MS } = await import('./wallet-trading-keystore.js')
              if (isUnlocked()) {
                if (!AGENT_MODE) console.log(`\n  ${t.muted}Keystore is already unlocked.${t.reset}\n`)
                else print({ success: true, alreadyUnlocked: true })
                break
              }
              // Phase 4c — `--ttl <dur>` overrides the default 24h cache TTL.
              const ttlStr = flags.ttl as string | undefined
              let ttlMs = DEFAULT_KEYSTORE_CACHE_TTL_MS
              if (ttlStr) {
                const { parseDurationToMs } = await import('./wallet-daemon.js')
                const parsed = parseDurationToMs(ttlStr)
                if (parsed === null || parsed <= 0) {
                  err(`Invalid --ttl: "${ttlStr}". Examples: 30m, 4h, 7d.`, EXIT.BAD_INPUT)
                }
                ttlMs = parsed!
              }
              let pass = process.env.PALMYR_TRADING_KEYSTORE_PASSPHRASE
              if (!pass) {
                const { promptPassphrase } = await import('./passphrase-prompt.js')
                try {
                  pass = await promptPassphrase()
                } catch (e: any) {
                  err(e.message || 'failed to get passphrase', EXIT.AUTH_FAIL)
                }
              }
              let expiresAt: string | undefined
              try {
                const r = unlockAndCache(pass!, ttlMs)
                expiresAt = r.expiresAt
              } catch (e: any) {
                err(e.message || 'unlock failed', EXIT.AUTH_FAIL)
              }
              log('wallet trading-keystore unlock')
              if (!AGENT_MODE) {
                console.log(`\n  ${t.success}${icon.success} Keystore unlocked${t.reset}`)
                console.log(`  ${t.muted}Seed cached in OS keychain. Trading wallets are now usable without re-entering the passphrase.${t.reset}`)
                console.log(`  ${t.muted}Cache expires at:${t.reset} ${expiresAt}`)
                console.log(`  ${t.muted}Run \`palmyr wallet trading-keystore lock\` to clear the cache.${t.reset}\n`)
              } else {
                print({ success: true, unlocked: true, expiresAt })
              }
              break
            }

            if (sub === 'lock') {
              const { clearCachedSeed, isUnlocked } = await import('./wallet-trading-keystore.js')
              const wasUnlocked = isUnlocked()
              clearCachedSeed()
              log(`wallet trading-keystore lock: wasUnlocked=${wasUnlocked}`)
              if (!AGENT_MODE) {
                if (wasUnlocked) {
                  console.log(`\n  ${t.success}${icon.success} Cached seed cleared.${t.reset}\n`)
                } else {
                  console.log(`\n  ${t.muted}Keystore was already locked.${t.reset}\n`)
                }
              } else {
                print({ success: true, wasUnlocked })
              }
              break
            }

            if (sub === 'list') {
              const { listKeystoreWallets } = await import('./wallet-trading-keystore.js')
              const wallets = listKeystoreWallets()
              if (!AGENT_MODE) {
                if (wallets.length === 0) {
                  console.log(`\n  ${t.muted}No trading keystore. Run \`palmyr wallet trading-keystore init\`.${t.reset}\n`)
                  break
                }
                console.log()
                table(['IDX', 'ADDRESS'], wallets.map(w => [String(w.index), w.address]))
                console.log()
              } else {
                print({ wallets })
              }
              break
            }

            if (sub === 'status') {
              const { getKeystoreStatus, isUnlocked } = await import('./wallet-trading-keystore.js')
              const status = getKeystoreStatus()
              const unlocked = isUnlocked()
              if (!AGENT_MODE) {
                console.log()
                section('Trading keystore')
                kv('Exists', status.exists ? 'yes' : 'no')
                kv('Path', status.path)
                if (status.exists) {
                  kv('Created', status.createdAt || '—')
                  kv('Wallets', String(status.walletCount))
                  // Phase 4c — surface TTL state ("expired" is distinct from "never unlocked")
                  if (status.cache?.hasSecret && status.cache.expired) {
                    kv('Unlocked', `${t.warn}expired${t.reset} (auto-locked on access)`)
                  } else {
                    kv('Unlocked', unlocked ? `${t.success}yes${t.reset}` : `${t.muted}no${t.reset}`)
                  }
                  if (status.cache?.expiresAt && !status.cache.expired) {
                    kv('Expires', status.cache.expiresAt)
                  }
                }
                console.log()
              } else {
                print({ ...status, unlocked })
              }
              break
            }

            if (sub === 'derive') {
              const count = flags.count ? Number(flags.count) : 1
              if (!Number.isInteger(count) || count <= 0) err('--count must be a positive integer', EXIT.BAD_INPUT)
              // Pass undefined when no env var → falls back to cached seed inside the module.
              const pass = process.env.PALMYR_TRADING_KEYSTORE_PASSPHRASE

              const { deriveMoreWallets } = await import('./wallet-trading-keystore.js')
              let file: Awaited<ReturnType<typeof deriveMoreWallets>>
              try {
                file = deriveMoreWallets(count, pass)
              } catch (e: any) {
                err(e.message || 'derive failed', EXIT.GENERAL)
              }

              log(`wallet trading-keystore derive: +${count}, total ${file!.addresses.length}`)

              if (!AGENT_MODE) {
                const newOnes = file!.addresses.slice(-count)
                console.log(`\n  ${t.success}${icon.success} Derived ${count} additional wallet(s)${t.reset}`)
                for (const a of newOnes) {
                  console.log(`    ${t.muted}[${a.index}]${t.reset} ${a.address}`)
                }
                console.log(`\n  ${t.muted}Total wallets: ${file!.addresses.length}${t.reset}\n`)
              } else {
                print({ success: true, addedCount: count, totalCount: file!.addresses.length, addresses: file!.addresses })
              }
              break
            }

            if (sub === 'export') {
              if (!flags.confirm) {
                err(
                  'This will display your mnemonic in plaintext. ' +
                  'Anyone who sees it can drain every derived wallet.\n\n' +
                  '  Re-run with --confirm to proceed:\n' +
                  '  palmyr wallet trading-keystore export --confirm',
                  EXIT.BAD_INPUT,
                )
              }
              // Export always requires the passphrase — no cache fallback.
              let pass = process.env.PALMYR_TRADING_KEYSTORE_PASSPHRASE
              if (!pass) {
                const { promptPassphrase } = await import('./passphrase-prompt.js')
                try {
                  pass = await promptPassphrase()
                } catch (e: any) {
                  err(e.message || 'failed to get passphrase', EXIT.AUTH_FAIL)
                }
              }

              const { exportMnemonic } = await import('./wallet-trading-keystore.js')
              let mnemonic: string
              try {
                mnemonic = exportMnemonic(pass!)
              } catch (e: any) {
                err(e.message || 'export failed', EXIT.SECURITY)
              }

              const warning = 'Anyone with these 24 words can drain every derived wallet. Write it down offline; never share, screenshot, or paste it.'
              if (!AGENT_MODE) {
                console.log(`\n  ${t.warn}⚠  TRADING KEYSTORE MNEMONIC — KEEP SECRET${t.reset}\n`)
                console.log(`  ${mnemonic!}\n`)
                console.log(`  ${t.muted}${warning}${t.reset}\n`)
              } else {
                print({ mnemonic: mnemonic!, warning })
              }
              break
            }

            err(`Unknown trading-keystore subcommand: ${sub}. Try: init, unlock, lock, list, status, derive, export`, EXIT.BAD_INPUT)
          }
          default: err(`Unknown wallet command: ${subcommand}. Try: create, import, list, info, tags, tag, tag-delete, export, rekey, addresses, sign-message, register, api-key, config, use, request-approval, buy, cohort, template, positions, position, sell, sync, pnl, journal, watch, brief, doctor, pay-preflight, smoke-test, readiness, live-test, daemon, triggers, trading-keystore, evm-quote`)
        }
        break
      }

      case 'chat': {
        if (!subcommand || (flags.help && !CHAT_HELP[subcommand])) {
          showMenu({
            command: 'chat',
            title: 'chat',
            subtitle: 'i402 (intent layer for x402): tell Palmyr what you want, pay USDC, get the outcome',
            footerLeft: 'Powered by the i402 protocol — see spec/i402.md',
            commands: [
              { name: 'run',         description: 'Generate a plan (and optionally execute it)', hint: '"launch a sneaker brand" --budget 50' },
              { name: 'resume',      description: 'Continue an existing session with a follow-up intent', hint: '<session_id> "now post 3 videos"' },
              { name: 'status',      description: 'Inspect a session: history, current status', hint: '<session_id>' },
              { name: 'cancel',      description: 'Halt execution and refund remaining escrow', hint: '<session_id>' },
              { name: 'sessions',    description: 'List your active sessions' },
              { name: 'capabilities', description: 'List the canonical capability classes' },
              { name: 'providers',   description: 'List registered providers, optionally filtered', hint: '[--capability web_search]' },
            ],
            fromHome,
          })
          break
        }
        if (flags.help && subcommand && CHAT_HELP[subcommand]) {
          subcommandHelp('chat', subcommand, CHAT_HELP[subcommand])
          break
        }

        switch (subcommand) {
          case 'run': {
            const intent = (positional.join(' ') || flags.intent as string || '').trim()
            if (!intent) err('pass the intent as a positional arg or --intent "..."')
            const budget = flags.budget ? parseFloat(flags.budget as string) : NaN
            if (!isFinite(budget) || budget <= 0) err('--budget <USDC> is required and must be positive')
            const quality = (flags.quality as string) || 'best'
            if (!['fast', 'cheap', 'best'].includes(quality)) err('--quality must be fast | cheap | best')
            const autoExecute = flags.execute === true || flags['auto-execute'] === true
            const autoApprove = flags['auto-approve-under'] ? parseFloat(flags['auto-approve-under'] as string) : undefined

            // Balance preflight: read the pay wallet's USDC BEFORE the $0.10
            // orchestration fee is signed, so a wallet that can't cover the
            // fee never pays anything. The same reading gates step execution
            // against plan.totals below (post-plan, pre-step-1).
            const skipBalanceCheck = flags['skip-balance-check'] === true || process.env.PALMYR_NO_PREFLIGHT === '1'
            const preBalance = skipBalanceCheck ? null : await chatUsdcPreflight(passphrase)

            const spin = new Spinner()
            spin.start('Generating i402 plan...')
            const plan = await ao.chat(intent, {
              budgetUsdc: budget,
              quality: quality as 'fast' | 'cheap' | 'best',
              autoApproveUnderUsdc: autoApprove,
              approve: autoExecute,
            })
            spin.stop('Plan generated', true)

            if (plan.status === 'clarification_needed') {
              if (AGENT_MODE) {
                print({
                  status: 'clarification_needed',
                  sessionId: plan.session_id,
                  questions: plan.questions || [],
                })
              } else {
                render(React.createElement(RecordsScreen, {
                  version: VERSION,
                  title: 'i402 — clarification needed',
                  subtitle: `session ${plan.session_id}`,
                  records: (plan.questions || []).map((q: any) => ({
                    primary: q.text,
                    secondary: `id: ${q.id}`,
                  })),
                  footerLeft: 'Re-run `palmyr chat resume <session_id> "<your answer>"`',
                }))
              }
              break
            }

            // Agent mode: emit the plan as a single JSON object, then NDJSON
            // events during execution so an agent can `for await` over stdout.
            // TTY mode: keep the colored progress output below.
            if (AGENT_MODE) {
              print({
                event: 'plan',
                planId: plan.plan_id,
                sessionId: plan.session_id,
                intent: plan.intent,
                steps: plan.steps,
                totals: plan.totals,
                status: plan.status,
              })
            } else {
              const interp = plan.intent?.interpreted ?? plan.intent?.original ?? intent
              const steps = plan.steps || []
              console.log(`\n  ${c.green}✓${c.white} Plan ready ${c.gray}— ${interp}${c.white}`)
              console.log(`  ${steps.length} step${steps.length === 1 ? '' : 's'} · $${plan.totals?.total_cost_usdc?.toFixed(2) ?? '?'} · ${humanEta(plan.totals?.eta_seconds)}\n`)
              steps.forEach((s: any, i: number) => {
                console.log(`  ${c.gray}${i + 1}${c.white}  ${padLabel(stepLabel(s))} ${c.gray}$${(s.cost_usdc ?? 0).toFixed(2)}${c.white}`)
              })
              console.log('')
            }

            // Gate execution on the plan's estimated total vs the balance read
            // before the fee was paid (total_cost_usdc includes the fee, so
            // comparing the pre-fee balance against the full total is exact).
            // About to execute → hard abort BEFORE step 1 pays anything;
            // plan-only → stderr warning so the user doesn't approve a plan
            // the wallet can't fund.
            if (preBalance !== null) {
              const totalUsdc = Number(plan.totals?.total_cost_usdc)
              const short = Number.isFinite(totalUsdc) ? usdcShortfall(preBalance.balanceUsdc, totalUsdc) : null
              if (short !== null) {
                const msg = insufficientBalanceMessage({
                  balanceUsdc: preBalance.balanceUsdc,
                  requiredUsdc: totalUsdc,
                  chain: preBalance.chain,
                  walletAddress: preBalance.walletAddress,
                  context: 'this plan',
                })
                if (autoExecute || plan.status === 'approved') {
                  err(msg, EXIT.PAYMENT, {
                    balanceUsdc: preBalance.balanceUsdc,
                    requiredUsdc: totalUsdc,
                    shortfallUsdc: short,
                    chain: preBalance.chain,
                    walletAddress: preBalance.walletAddress,
                    sessionId: plan.session_id,
                    planId: plan.plan_id,
                  })
                }
                process.stderr.write(`[palmyr] warning: ${msg}\n`)
              }
            }

            if (!autoExecute && plan.status !== 'approved') {
              if (AGENT_MODE) {
                print({
                  event: 'awaiting_approval',
                  sessionId: plan.session_id,
                  planId: plan.plan_id,
                  resumeCommand: `palmyr chat resume ${plan.session_id} --approve --plan-id ${plan.plan_id}`,
                })
              } else {
                console.log(`${c.yellow}Plan not auto-approved.${c.white} To execute:`)
                console.log(`  ${c.cyan}palmyr chat resume ${plan.session_id} --approve --plan-id ${plan.plan_id}${c.white}`)
              }
              break
            }

            if (autoExecute || plan.status === 'approved') {
              const stepById: Record<string, any> = {}
              for (const s of plan.steps || []) stepById[s.step_id] = s
              const labelFor = (id: string) => stepLabel(stepById[id] || { capability: id })
              const maxUsdc = flags['max-usdc'] ? parseFloat(flags['max-usdc'] as string) : undefined
              if (!AGENT_MODE) console.log('')
              const t0 = Date.now()
              let curSpin: Spinner | null = null
              for await (const event of ao.chatExecute(plan, { maxUsdc })) {
                if (AGENT_MODE) {
                  // NDJSON: one event per line, unchanged — agents stream-parse.
                  process.stdout.write(JSON.stringify(event) + '\n')
                  continue
                }
                // TTY: one live line per step. The spinner shows progress while a
                // step runs (incl. async 202+poll waits), then resolves to a
                // single ✓ <what it did>  <result>  <time> line.
                switch (event.type) {
                  case 'session':
                  case 'plan':
                    break
                  case 'step_start':
                    curSpin = new Spinner()
                    curSpin.start(labelFor(event.stepId))
                    break
                  case 'step_poll':
                    if (curSpin) curSpin.update(`${labelFor(event.stepId)} ${c.gray}· ${event.status ?? 'working'}…${c.white}`)
                    break
                  case 'session_refresh_started':
                    if (curSpin) curSpin.update(`${labelFor(event.stepId)} ${c.gray}· signing in @${event.handle}…${c.white}`)
                    break
                  case 'session_refresh_done':
                    break
                  case 'step_result': {
                    const label = labelFor(event.stepId)
                    const res = shortResult(event.output)
                    // Don't echo a result the label already states (e.g. "Register
                    // stealthkicks.xyz" + "stealthkicks.xyz").
                    const showRes = res && !label.toLowerCase().includes(res.toLowerCase())
                    const line = `${label}${showRes ? `  ${c.gray}${res}${c.white}` : ''}  ${c.gray}${humanDuration(event.latencyMs ?? 0)}${c.white}`
                    if (curSpin) { curSpin.stop(line, true); curSpin = null }
                    else console.log(`  ${icon.success} ${line}`)
                    break
                  }
                  case 'step_error': {
                    const errMsg = truncateError(String(event.error ?? ''), 120)
                    const line = `${labelFor(event.stepId)}  ${c.red}${errMsg}${c.white}`
                    if (curSpin) { curSpin.stop(line, false); curSpin = null }
                    else console.log(`  ${icon.error} ${line}`)
                    break
                  }
                  case 'clarification_needed':
                    if (curSpin) { curSpin.stop(labelFor(event.stepId), false); curSpin = null }
                    console.log(`  ${c.yellow}?${c.white} needs more info to continue`)
                    break
                  case 'summary': {
                    const ok = event.status === 'completed'
                    console.log(`\n  ${ok ? icon.success : icon.error} ${ok ? 'Done' : 'Stopped'} ${c.gray}— $${event.spentUsdc?.toFixed(2) ?? '?'} · ${humanDuration(Date.now() - t0)}${c.white}`)
                    break
                  }
                }
              }
            }
            break
          }

          case 'resume': {
            const sessionId = positional[0]
            const intentParts = positional.slice(1)
            const intent = intentParts.join(' ').trim() || (flags.intent as string | undefined) || ''
            const planId = flags['plan-id'] as string | undefined
            if (!sessionId) err('session_id required: palmyr chat resume <session_id> "follow-up intent"')

            // If intent is provided, generate a new plan in this session
            if (intent) {
              const budget = flags.budget ? parseFloat(flags.budget as string) : 20
              const autoExecute = flags.execute === true || flags['auto-execute'] === true
              // Same balance preflight as `chat run` — a new plan pays the
              // $0.10 orchestration fee, so read the balance before signing it.
              const skipBalanceCheck = flags['skip-balance-check'] === true || process.env.PALMYR_NO_PREFLIGHT === '1'
              const preBalance = skipBalanceCheck ? null : await chatUsdcPreflight(passphrase)
              const plan = await ao.chat(intent, {
                sessionId,
                budgetUsdc: budget,
                quality: (flags.quality as any) || 'best',
                approve: autoExecute,
              })
              if (AGENT_MODE) {
                print({
                  event: 'plan',
                  sessionId,
                  planId: plan.plan_id,
                  totalCostUsdc: plan.totals?.total_cost_usdc,
                  steps: plan.steps,
                })
              } else {
                console.log(`${c.cyan}New plan in session${c.white} ${sessionId}`)
                console.log(`  plan_id: ${plan.plan_id}  cost: $${plan.totals?.total_cost_usdc?.toFixed(2) ?? '?'}`)
              }
              // Same gate as `chat run`: about to execute → hard abort before
              // step 1 pays anything; plan-only → stderr warning so the user
              // doesn't approve a plan the wallet can't fund.
              if (preBalance !== null) {
                const totalUsdc = Number(plan.totals?.total_cost_usdc)
                const short = Number.isFinite(totalUsdc) ? usdcShortfall(preBalance.balanceUsdc, totalUsdc) : null
                if (short !== null) {
                  const msg = insufficientBalanceMessage({
                    balanceUsdc: preBalance.balanceUsdc,
                    requiredUsdc: totalUsdc,
                    chain: preBalance.chain,
                    walletAddress: preBalance.walletAddress,
                    context: 'this plan',
                  })
                  if (autoExecute) {
                    err(msg, EXIT.PAYMENT, {
                      balanceUsdc: preBalance.balanceUsdc,
                      requiredUsdc: totalUsdc,
                      shortfallUsdc: short,
                      chain: preBalance.chain,
                      walletAddress: preBalance.walletAddress,
                      sessionId,
                      planId: plan.plan_id,
                    })
                  }
                  process.stderr.write(`[palmyr] warning: ${msg}\n`)
                }
              }
              if (!autoExecute) break
              const maxUsdc = flags['max-usdc'] ? parseFloat(flags['max-usdc'] as string) : undefined
              for await (const event of ao.chatExecute(plan, { maxUsdc })) {
                if (AGENT_MODE) {
                  process.stdout.write(JSON.stringify(event) + '\n')
                  continue
                }
                if (event.type === 'step_result') console.log(`  ${c.green}✓${c.white} ${event.stepId} $${event.costChargedUsdc?.toFixed(2)}`)
                if (event.type === 'step_error') console.log(`  ${c.red}✗${c.white} ${event.stepId} ${event.error}`)
                if (event.type === 'summary') console.log(`${c.cyan}done${c.white}: ${event.status}  spent=$${event.spentUsdc?.toFixed(2)}`)
              }
              break
            }

            // No intent → we'd need to re-fetch the plan from the server.
            // Not wired in this minimal CLI: generate a new plan with `chat run`
            // or pass a follow-up intent to `chat resume <session> "..."`.
            err('pass a follow-up intent to continue the session; direct re-execution of a stored plan by id is not yet wired')
            break
          }

          case 'status': {
            const sessionId = positional[0]
            if (!sessionId) err('session_id required')
            const data = await ao.chatGetSession(sessionId)
            return print(data)
          }

          case 'cancel': {
            const sessionId = positional[0]
            if (!sessionId) err('session_id required')
            const data = await ao.chatCancel(sessionId)
            return print(data)
          }

          case 'sessions': {
            const data = await ao.chatListSessions()
            return print(data)
          }

          case 'capabilities': {
            const data = await ao.chatListCapabilities()
            return print(data)
          }

          case 'providers': {
            const capability = flags.capability as string | undefined
            const data = await ao.chatListProviders(capability)
            return print(data)
          }

          default: err(`Unknown chat command: ${subcommand}. Try: run, resume, status, cancel, sessions, capabilities, providers`)
        }
        break
      }

      case 'twitter': {
        const sv = await import('./social-vault.js')
        const platform = 'twitter' as const

        // Resolve a username to its server-side account_id and which table
        // holds it. X accounts can live in THREE places:
        //   - x_accounts (legacy pool, rarely used now)
        //   - social_account_pool (where `palmyr twitter buy` writes)
        //   - social_registered_accounts (BYO-registered)
        // The local vault doesn't track which, so we query all three in
        // parallel and find a match. Used by transfer / share / unshare
        // to dispatch to the correct endpoint family. Returns null if the
        // username isn't on any of them.
        const resolveServerAccount = async (username: string): Promise<
          | { kind: 'x_accounts'; id: string }
          | { kind: 'pool'; id: string }
          | { kind: 'registered'; id: string }
          | null
        > => {
          const [xMine, poolMine, reg] = await Promise.allSettled([
            ao.xAccountsMine(),
            ao.socialTwitterPoolMine(),
            ao.socialTwitterListRegistered(),
          ])
          if (xMine.status === 'fulfilled') {
            const m = (xMine.value?.accounts || []).find((a: any) => a.username === username)
            if (m) return { kind: 'x_accounts', id: m.id }
          }
          if (poolMine.status === 'fulfilled') {
            const m = (poolMine.value?.accounts || []).find((a: any) => a.username === username)
            if (m) return { kind: 'pool', id: m.id }
          }
          if (reg.status === 'fulfilled') {
            const m = (reg.value?.accounts || []).find((a: any) => a.username === username)
            if (m) return { kind: 'registered', id: m.id }
          }
          return null
        }

        // Look up an account by username; if it's not in the local vault,
        // check both server-side tables and auto-import any match. This is
        // what makes `palmyr twitter <op> @h` "just work" for a wallet that
        // was just transferred or shared an account — no separate `claim`
        // step. Errs cleanly if the account is neither local nor accessible
        // server-side. Each auto-import costs ~$0.0011 (two paid lookups +
        // creds-decryption fee on the registered side), so call sites that
        // are pure local ops (rename, remove) intentionally skip this.
        const ensureLocalAccount = async (username: string) => {
          const existing = sv.getAccount(platform, username)
          if (existing) return existing

          const [xRes, poolRes, regRes] = await Promise.allSettled([
            ao.xAccountsMine(),
            ao.socialTwitterPoolMine(),
            ao.socialTwitterRegisteredMine(),
          ])
          const xMatch = xRes.status === 'fulfilled'
            ? (xRes.value?.accounts || []).find((a: any) => a.username === username)
            : null
          const poolMatch = poolRes.status === 'fulfilled'
            ? (poolRes.value?.accounts || []).find((a: any) => a.username === username)
            : null
          const regMatch = regRes.status === 'fulfilled'
            ? (regRes.value?.accounts || []).find((a: any) => a.username === username)
            : null
          const match: any = xMatch || poolMatch || regMatch
          if (!match) {
            err(`twitter account "${username}" not found locally or on the server (this wallet has no access)`, EXIT.NOT_FOUND)
          }

          // Pool-mine and registered-mine return creds nested under
          // `credentials`; legacy x_accounts/mine returns them flat alongside
          // cookies. Normalize so the import works the same in either case.
          const cookies = (match.cookies || []) as any[]
          const ct0 = cookies.find((c: any) => c.name === 'ct0')?.value
          const hasNestedCreds = poolMatch || regMatch
          const creds: import('./social-vault.js').SocialCredentials = hasNestedCreds
            ? (match.credentials as import('./social-vault.js').SocialCredentials)
            : {
                login: match.email || match.username,
                password: match.password,
                email: match.email,
                auth_token: match.auth_token || undefined,
                ct0,
              }
          const summary = sv.importAccount(platform, username, creds, {
            source: 'auto-claim',
            proxy_session_id: poolMatch?.proxy_session_id,
            country: poolMatch?.country || undefined,
          })
          if (cookies.length > 0) {
            sv.saveSession(summary.id, platform, cookies)
          }
          const sourceLabel = poolMatch ? 'pool' : regMatch ? 'registered' : 'x_accounts'
          log(`auto-imported @${username} from server (${sourceLabel} → local vault)`)
          return summary
        }

        // Help guard. `palmyr twitter buy --help` MUST never dispatch to the
        // paid `case 'buy'` below — 1.8.3 had no guard here and a real user
        // got charged $5 for a help command. Falls back to the top-level menu
        // when the subcommand has no per-subcommand help entry, so even an
        // unrecognized `palmyr twitter <whatever> --help` is safe to run.
        if (!subcommand || (flags.help && !TWITTER_HELP[subcommand])) {
          showMenu({
            command: 'twitter',
            title: 'twitter',
            subtitle: 'Automated X account management',
            footerLeft: 'Phase 1: local vault + BYO import works today. Server-dependent commands stub out.',
            commands: [
              { name: 'import',  description: 'Save a BYO account to the local vault', hint: '--username --password --totp-seed' },
              { name: 'list',    description: 'List local accounts and any server-only ones the wallet can access', hint: '[--local]' },
              { name: 'info',    description: 'Show one account', hint: '<username>' },
              { name: 'rename',  description: 'Update the local record when the handle changes', hint: '<old> --to <new>' },
              { name: 'remove',  description: 'Delete an account from the local vault', hint: '<username> --confirm' },
              { name: 'totp',    description: 'Print the current TOTP code for an account', hint: '<username>' },
              { name: 'buy',     description: 'Purchase an aged account (requires server supplier config)', hint: '--age 1y --country US' },
              { name: 'login',   description: 'Force a fresh server-side session (requires browser runtime)', hint: '<username>' },
              { name: 'post',    description: 'Post a tweet (requires server browser runtime)', hint: '<username> --body "..."' },
              // `status` is not wired yet (Phase 3). Hidden from this menu so
              // users don't try a command that will only error; `session`
              // covers the most useful subset (cached server-side login state).
              { name: 'session', description: 'Inspect cached server-side session for an account', hint: '<username>' },
              { name: 'transfer', description: 'Hand an account to another wallet (rotates password; auto-registers if needed)', hint: '<username> --to <wallet> --confirm' },
              { name: 'share',    description: 'Grant another wallet shared access', hint: '<username> --with <wallet>' },
              { name: 'unshare',  description: 'Revoke a wallet’s shared access', hint: '<username> --from <wallet> [--rotate]' },
              { name: 'claim',    description: 'Import server-side accounts owned by your wallet into the local vault' },
            ],
            fromHome,
          })
          return
        }
        if (flags.help && subcommand && TWITTER_HELP[subcommand]) {
          subcommandHelp('twitter', subcommand, TWITTER_HELP[subcommand])
          return
        }

        switch (subcommand) {
          case 'import': {
            // Option 1: --credentials-line "login:password:email:email_pw:2fa:ct0:auth_token"
            // Option 2: individual --username --password --email etc flags
            const line = flags['credentials-line'] as string
            let login: string | undefined
            let password: string | undefined
            let email: string | undefined
            let emailPassword: string | undefined
            let totpSeed: string | undefined
            let ct0: string | undefined
            let authToken: string | undefined
            let username = (flags.username as string) || positional[0]

            if (line) {
              // AccsMarket common formats:
              //   login:password:email:email_pw                    (4 fields)
              //   login:password:email:email_pw:2fa                (5 fields)
              //   login:password:email:email_pw:2fa:ct0:auth_token (7 fields)
              const parts = line.split(':')
              if (parts.length < 4) err(`--credentials-line must have at least 4 colon-separated fields, got ${parts.length}`)
              login = parts[0]
              password = parts[1]
              email = parts[2]
              emailPassword = parts[3]
              if (parts[4]) totpSeed = parts[4]
              if (parts[5]) ct0 = parts[5]
              if (parts[6]) authToken = parts[6]
              // If no explicit --username, use the login field as the account handle.
              if (!username) username = login
            } else {
              password = flags.password as string
              login = flags.login as string
              email = flags.email as string
              emailPassword = (flags['email-password'] as string) || (flags.emailpw as string)
              totpSeed = (flags['totp-seed'] as string) || (flags.totp as string)
              ct0 = flags.ct0 as string
              authToken = (flags['auth-token'] as string) || (flags.authtoken as string)
            }

            if (!username) err('--username (or --credentials-line) required')
            if (!password) err('--password (or --credentials-line) required')

            const recovery = flags['recovery-codes'] as string
            const profileUrl = flags['profile-url'] as string

            const creds: import('./social-vault.js').SocialCredentials = {
              login: login || email || undefined,
              password: password!,
              email: email || login || undefined,
              email_password: emailPassword,
              totp_seed: totpSeed,
              recovery_codes: recovery ? recovery.split(',').map(s => s.trim()) : undefined,
              profile_url: profileUrl,
              auth_token: authToken,
              ct0,
            }
            const summary = sv.importAccount(platform, username, creds, { source: line ? 'accsmarket-line' : 'import' })
            log(`twitter import: ${summary.username} (${summary.id})${authToken ? ' [cookies included — cookie login path]' : ' [form login path]'}`)
            return print({ ...summary, has_cookies: !!authToken })
          }

          case 'list': {
            // Local vault is always queried (free, instant). By default we
            // also query the server for accounts the wallet owns or has been
            // shared with — that's how a wallet that just received a transfer
            // sees the account here without an extra `claim` step. Pass
            // --local to skip the server check for cheap mode.
            const localAccounts = sv.listAccounts(platform)
            const skipRemote = !!flags.local

            if (skipRemote) {
              return print({ accounts: localAccounts, count: localAccounts.length, source: 'local' })
            }

            const [xRes, poolRes, regRes] = await Promise.allSettled([
              ao.xAccountsMine(),
              ao.socialTwitterPoolMine(),
              ao.socialTwitterRegisteredMine(),
            ])
            const xAccounts: any[] = xRes.status === 'fulfilled' ? (xRes.value?.accounts || []) : []
            const poolAccounts: any[] = poolRes.status === 'fulfilled' ? (poolRes.value?.accounts || []) : []
            const regAccounts: any[] = regRes.status === 'fulfilled' ? (regRes.value?.accounts || []) : []

            const localUsernames = new Set(localAccounts.map(a => a.username))
            const serverOnly: any[] = []
            for (const a of xAccounts) {
              if (a.username && !localUsernames.has(a.username)) {
                serverOnly.push({
                  username: a.username,
                  access: a.access || 'owner',
                  source_table: 'x_accounts',
                  status: 'server-only — run `palmyr twitter claim` to import',
                })
              }
            }
            for (const a of poolAccounts) {
              if (a.username && !localUsernames.has(a.username)) {
                serverOnly.push({
                  username: a.username,
                  access: a.access || 'owner',
                  source_table: 'pool',
                  status: 'server-only — run `palmyr twitter claim` to import',
                })
              }
            }
            for (const a of regAccounts) {
              if (a.username && !localUsernames.has(a.username)) {
                serverOnly.push({
                  username: a.username,
                  access: a.access || 'owner',
                  source_table: 'registered',
                  status: 'server-only — run `palmyr twitter claim` to import',
                })
              }
            }

            return print({
              accounts: localAccounts,
              server_only: serverOnly,
              count_local: localAccounts.length,
              count_server_only: serverOnly.length,
              ...(serverOnly.length > 0
                ? { hint: `${serverOnly.length} account${serverOnly.length === 1 ? '' : 's'} on server but not in local vault — run 'palmyr twitter claim' to import` }
                : {}),
            })
          }

          case 'info': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = await ensureLocalAccount(username!)
            return print(acc)
          }

          case 'rename': {
            const oldUsername = positional[0] || (flags.username as string)
            const newUsername = flags.to as string
            if (!oldUsername) err('<old-username> required')
            if (!newUsername) err('--to <new-username> required')
            const summary = sv.renameAccount(platform, oldUsername, newUsername)
            log(`twitter rename: ${oldUsername} → ${newUsername}`)
            return print(summary)
          }

          case 'remove': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            if (!flags.confirm) {
              err(
                `This deletes the local copy of "${username}". The X account itself is NOT deleted.\n\n` +
                `  Re-run with --confirm to proceed:\n` +
                `  palmyr twitter remove ${username} --confirm`
              )
            }
            sv.removeAccount(platform, username)
            log(`twitter remove: ${username}`)
            return print({ success: true, platform, username })
          }

          case 'totp': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            await ensureLocalAccount(username!)
            const creds = sv.unlockCredentials(platform, username!)
            if (!creds.totp_seed) err(`twitter account "${username}" has no TOTP seed configured`, EXIT.NOT_FOUND)
            const { code, secondsUntilNextCode } = await import('./totp.js')
            return print({
              platform,
              username,
              code: code(creds.totp_seed!),
              expires_in_seconds: secondsUntilNextCode(),
            })
          }

          case 'login': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)

            // Decrypt credentials locally — they transit the network only over TLS
            // during this one request, and are never persisted server-side.
            const creds = sv.unlockCredentials(platform, username)
            if (!creds.login) err('Account has no login field. Re-import with --login <email-or-handle>.', EXIT.BAD_INPUT)

            // Pool-seeded accounts ship with auth_token+ct0 saved into the
            // session file (sv.saveSession) rather than the encrypted creds
            // blob. Fall back to those when creds.auth_token/ct0 are absent.
            const sess = sv.loadSession(acc!.id)
            const sessAuthToken = sess?.cookies?.find((c: any) => c.name === 'auth_token')?.value
            const sessCt0 = sess?.cookies?.find((c: any) => c.name === 'ct0')?.value
            const authToken = creds.auth_token || sessAuthToken
            const ct0 = creds.ct0 || sessCt0
            const cookiePath = !!(authToken && ct0)
            const psid = sv.getProxySessionId(platform, username)
            let data: any
            try {
              // Uses the SDK so x402 payment is auto-signed from the configured wallet
              data = await ao.socialTwitterLogin(
                acc!.id,
                creds.login!,
                creds.password,
                creds.totp_seed,
                cookiePath ? { auth_token: authToken, ct0: ct0 } : undefined,
                psid
              )
            } catch (e: any) {
              err(`Login failed: ${e.message}`, EXIT.GENERAL)
            }

            if (!data || !data.success) {
              err(
                `Login failed: ${data?.error || 'unknown error'}` +
                (data?.error_code ? ` [${data.error_code}]` : '') +
                (data?.diagnostics?.page_text_excerpt ? `\nPage text: ${data.diagnostics.page_text_excerpt.slice(0, 300)}` : '') +
                (data?.diagnostics?.screenshot_path ? `\nScreenshot: ${data.diagnostics.screenshot_path}` : ''),
                EXIT.GENERAL
              )
            }

            sv.saveSession(acc!.id, platform, data.cookies || [])
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })

            return print({
              success: true,
              platform,
              username,
              cookies_captured: (data.cookies || []).length,
              captured_at: data.captured_at,
            })
          }

          case 'manual-login': {
            // For accounts X anti-bot blocks from automated form login (every
            // account in 2026, basically): the user logs in manually in any
            // browser, pastes auth_token + ct0 from DevTools, we save them as
            // a session. Subsequent `twitter login` takes the cookie path.
            const username = positional[0] || (flags.username as string)
            if (!username) err('Usage: palmyr twitter manual-login <username> [--auth-token <hex40>] [--ct0 <hex160>]', EXIT.BAD_INPUT)
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)

            let authToken = ((flags['auth-token'] as string) || '').trim()
            let ct0 = ((flags.ct0 as string) || '').trim()

            if (!authToken || !ct0) {
              // No TTY → no interactive prompt. Erroring out (rather than
              // blocking on readline forever and polluting stdout JSON with
              // prompt text) matches the NoTTYError convention in
              // passphrase-prompt.ts. Agents must pass --auth-token and --ct0.
              if (!process.stdin.isTTY) {
                err(
                  `--auth-token and --ct0 required in non-interactive mode (no TTY for the manual paste prompt).\n` +
                  `  Log into X as ${username} in any browser, open DevTools → Application → Cookies → https://x.com, then:\n` +
                  `  palmyr twitter manual-login ${username} --auth-token <hex40> --ct0 <hex160>`,
                  EXIT.BAD_INPUT,
                )
              }
              const readline = await import('readline')
              const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
              const ask = (q: string) => new Promise<string>(r => rl.question(q, r))
              process.stderr.write(`Log into X as ${username} in any browser, then open DevTools (F12) → Application → Cookies → https://x.com\n`)
              if (!authToken) authToken = (await ask('Paste auth_token (40 hex chars): ')).trim()
              if (!ct0) ct0 = (await ask('Paste ct0 (160 hex chars): ')).trim()
              rl.close()
            }

            if (!/^[a-f0-9]{40}$/i.test(authToken)) err(`auth_token must be 40 hex chars (got ${authToken.length})`, EXIT.BAD_INPUT)
            if (!/^[a-f0-9]{160}$/i.test(ct0)) err(`ct0 must be 160 hex chars (got ${ct0.length})`, EXIT.BAD_INPUT)

            const cookies = [
              { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
              { name: 'ct0', value: ct0, domain: '.x.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
            ]
            sv.saveSession(acc!.id, platform, cookies)
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
            return print({
              success: true,
              platform,
              username,
              cookies_saved: cookies.length,
              hint: `Try: palmyr twitter login ${username}`,
            })
          }

          case 'session': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = await ensureLocalAccount(username!)
            const sess = sv.loadSession(acc.id)
            if (!sess) {
              return print({
                platform,
                username,
                cached: false,
                hint: `No cached session. Run: palmyr twitter login ${username}`,
              })
            }
            const ageHours = sv.sessionAgeHours(acc.id)
            return print({
              platform,
              username,
              cached: true,
              cookies: sess.cookies.length,
              captured_at: sess.captured_at,
              age_hours: Number((ageHours || 0).toFixed(2)),
              stale: (ageHours || 0) > 12,
            })
          }

          case 'list-tweets': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const rawLimit = flags.limit
            let limit: number | undefined
            if (rawLimit !== undefined) {
              const n = Number(rawLimit)
              if (!Number.isFinite(n) || n <= 0) err('--limit must be a positive integer', EXIT.BAD_INPUT)
              limit = Math.floor(n)
            }
            const acc = await ensureLocalAccount(username!)
            const sess = sv.loadSession(acc.id)
            if (!sess || !sess.cookies || sess.cookies.length === 0) {
              err(
                `No cached session for ${username}. Run 'twitter login ${username}' first.`,
                EXIT.NOT_FOUND
              )
            }
            const psid = sv.getProxySessionId(platform, username!)
            let data: any
            try {
              data = await ao.socialTwitterListMyTweets(acc.id, sess!.cookies, limit, psid)
            } catch (e: any) {
              err(`list-tweets failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(
                `list-tweets failed: ${data?.error || 'unknown'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
            return print({ success: true, platform, username, ...(data?.data || {}) })
          }

          case 'register': {
            // Register an X account with the Palmyr server. Server tests the
            // login, encrypts credentials at rest, and from then on can refresh
            // cookies on this wallet's behalf — foundation for server-side
            // scheduling. If the account already exists in the local vault,
            // we pull its credentials by default so the user doesn't have to
            // re-type. Explicit flags override.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')

            let login: string | undefined = (flags.login as string) || undefined
            let password: string | undefined = (flags.password as string) || undefined
            let totpSeed: string | undefined = (flags['totp-seed'] as string) || undefined
            let email: string | undefined = (flags.email as string) || undefined
            let emailPassword: string | undefined = (flags['email-password'] as string) || undefined
            let authToken: string | undefined = (flags['auth-token'] as string) || undefined
            let ct0: string | undefined = (flags.ct0 as string) || undefined
            const country: string | undefined = (flags.country as string) || undefined

            const localAcc = sv.getAccount(platform, username!)
            if (localAcc && !password) {
              const localCreds = sv.unlockCredentials(platform, username!)
              login = login || localCreds.login
              password = password || localCreds.password
              totpSeed = totpSeed || localCreds.totp_seed
              email = email || localCreds.email
              emailPassword = emailPassword || localCreds.email_password
              authToken = authToken || localCreds.auth_token
              ct0 = ct0 || localCreds.ct0
            }

            if (!password) {
              err('--password required (or import the account locally first via `palmyr twitter import`)')
            }

            let data: any
            try {
              data = await ao.socialTwitterRegister(username!, password!, {
                login, email, email_password: emailPassword,
                totp_seed: totpSeed, auth_token: authToken, ct0, country,
              })
            } catch (e: any) {
              err(`Register failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(
                `Register failed: ${data?.error || 'unknown'}` +
                (data?.login_error_code ? ` [${data.login_error_code}]` : ''),
                EXIT.GENERAL
              )
            }
            return print({
              success: true,
              platform, username,
              account_id: data.id,
              cookies_captured: data.cookies_captured,
              hint: 'Server holds encrypted credentials. Use `palmyr twitter schedule` (next PR) to schedule fire-and-forget posts.',
            })
          }

          case 'unregister': {
            const usernameOrId = positional[0] || (flags.username as string) || (flags.id as string)
            if (!usernameOrId) err('<username-or-id> required')
            // 32-char hex == account_id. Otherwise treat as username and look up.
            let accountId: string | undefined
            if (/^[a-f0-9]{32}$/i.test(usernameOrId!)) {
              accountId = usernameOrId
            } else {
              let registered: any
              try {
                registered = await ao.socialTwitterListRegistered()
              } catch (e: any) {
                err(`Failed to list registered accounts: ${e.message}`, EXIT.GENERAL)
              }
              const match = (registered?.accounts || []).find((a: any) => a.username === usernameOrId)
              if (!match) {
                err(`No registered account with username "${usernameOrId}". Run \`palmyr twitter registered\` to list.`, EXIT.NOT_FOUND)
              }
              accountId = match!.id
            }
            let data: any
            try {
              data = await ao.socialTwitterUnregister(accountId!)
            } catch (e: any) {
              err(`Unregister failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(`Unregister failed: ${data?.error || 'unknown'}`, EXIT.GENERAL)
            }
            return print({ success: true, platform, account_id: accountId, hint: 'Server-side credentials wiped. Account no longer schedulable until re-registered.' })
          }

          case 'registered': {
            let data: any
            try {
              data = await ao.socialTwitterListRegistered()
            } catch (e: any) {
              err(`List registered failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(`List registered failed: ${data?.error || 'unknown'}`, EXIT.GENERAL)
            }
            return print({ success: true, platform, accounts: data.accounts || [] })
          }

          case 'schedule': {
            // Server-backed: pays $0.001 (text) / $0.005 (thread or media)
            // upfront via x402, schedule fires from the server at --at time.
            // Account must be registered first via `palmyr twitter register`.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required (must be registered via `palmyr twitter register` first)')

            const postAt = flags.at as string
            if (!postAt) err('--at "ISO 8601" required (e.g. --at "2026-05-15T14:00:00Z")')
            if (Number.isNaN(Date.parse(postAt))) err(`--at "${postAt}" is not a valid ISO 8601 date`)

            const text = (flags.body as string) || (flags.text as string)
            const textsRaw = flags.texts as string
            const fileTextsPath = (flags.file as string) || (flags.path as string)
            let texts: string[] | undefined
            if (fileTextsPath) {
              // Strip UTF-8 BOM that PS 5.1's `Set-Content -Encoding utf8` prepends.
try { texts = JSON.parse(readFileSync(fileTextsPath, 'utf8').replace(/^﻿/, '')) }
              catch (e: any) { err(`--file ${fileTextsPath}: ${e.message}`) }
            } else if (textsRaw) {
              try { texts = JSON.parse(textsRaw) }
              catch (e: any) { err(`--texts must be a JSON array of strings: ${e.message}`) }
            }
            if (!text && (!Array.isArray(texts) || texts.length === 0)) {
              err('Either --body "..." or --texts \'["..."]\' required')
            }

            const communityId = (flags.community as string) || (flags['community-id'] as string) || undefined

            // Look up registered account_id by username. One round-trip per call;
            // could be cached locally later if it becomes a hotspot.
            let registered: any
            try {
              registered = await ao.socialTwitterListRegistered()
            } catch (e: any) {
              err(`Failed to list registered accounts: ${e.message}`, EXIT.GENERAL)
            }
            const match = (registered?.accounts || []).find((a: any) => a.username === username)
            if (!match) {
              err(
                `Account "${username}" is not registered server-side. Register first: ` +
                `palmyr twitter register ${username}`,
                EXIT.NOT_FOUND
              )
            }
            const accountId = match!.id

            let data: any
            try {
              if (Array.isArray(texts) && texts.length > 0) {
                // Thread schedule.
                data = await ao.socialScheduledThread(accountId, texts, postAt, communityId)
              } else if (flags.image || flags.video || flags['media-json']) {
                // Media schedule — base64-encode local files for upload.
                const media: any[] = []
                if (flags.image) {
                  for (const fp of (flags.image as string).split(',').map((p: string) => p.trim()).filter(Boolean)) {
                    let buf: Buffer
                    try { buf = readFileSync(fp) } catch (e: any) { err(`--image ${fp}: ${e.message}`); continue }
                    const ext = extname(fp).slice(1).toLowerCase() || 'png'
                    media.push({ image_base64: `data:image/${ext};base64,${buf.toString('base64')}` })
                  }
                }
                if (flags.video) {
                  const fp = flags.video as string
                  let buf: Buffer
                  try { buf = readFileSync(fp) } catch (e: any) { err(`--video ${fp}: ${e.message}`) }
                  const ext = extname(fp).slice(1).toLowerCase() || 'mp4'
                  media.push({ video_base64: `data:video/${ext};base64,${buf!.toString('base64')}` })
                }
                if (flags['media-json']) {
                  let parsed: any
                  try { parsed = JSON.parse(flags['media-json'] as string) }
                  catch (e: any) { err(`--media-json: ${e.message}`) }
                  if (!Array.isArray(parsed)) err('--media-json must be a JSON array')
                  media.push(...parsed)
                }
                data = await ao.socialScheduledMedia(accountId, text!, media, postAt, communityId)
              } else {
                // Text-only schedule.
                data = await ao.socialScheduledPost(accountId, text!, postAt, communityId)
              }
            } catch (e: any) {
              err(`Schedule failed: ${e.message}`, EXIT.GENERAL)
            }

            if (!data?.success) {
              err(`Schedule failed: ${data?.error || 'unknown'}`, EXIT.GENERAL)
            }
            return print({
              success: true,
              platform, username,
              schedule_id: data.id,
              post_at: postAt,
              hint: 'Server fires this at post_at automatically — no daemon needed. Cancel via `palmyr twitter cancel <id>`.',
            })
          }

          case 'queue': {
            // Server-backed: lists scheduled posts for the caller's wallet.
            const status = flags.status as 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | undefined
            const fromIso = (flags.from as string) || undefined
            const toIso = (flags.to as string) || undefined
            const accountIdFilter = (flags['account-id'] as string) || undefined
            const limit = flags.limit ? Number(flags.limit) : undefined

            let data: any
            try {
              data = await ao.socialScheduledList({
                accountId: accountIdFilter, status, from: fromIso, to: toIso, limit,
              })
            } catch (e: any) {
              err(`Queue list failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(`Queue list failed: ${data?.error || 'unknown'}`, EXIT.GENERAL)
            }
            return print({ success: true, items: data.items || [] })
          }

          case 'cancel': {
            // Server-backed: cancels a pending scheduled post.
            const id = positional[0] || (flags.id as string)
            if (!id) err('<schedule-id> required (from `palmyr twitter queue`)')

            let data: any
            try {
              data = await ao.socialScheduledCancel(id!)
            } catch (e: any) {
              err(`Cancel failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(`Cancel failed: ${data?.error || 'unknown'}`, EXIT.GENERAL)
            }
            return print({ success: true, cancelled: data.cancelled, status: data.status, id })
          }

          case 'username': {
            const username = positional[0] || (flags.username as string)
            const rawNewUsername = flags.to as string
            if (!username) err('<username> required')
            if (!rawNewUsername) err('--to <new-handle> required')
            // Pre-flight validate so we don't pay for preventable input errors.
            const newUsername = rawNewUsername.replace(/^@/, '').trim()
            if (!/^[A-Za-z0-9_]{4,15}$/.test(newUsername)) {
              err(
                `Invalid username "${rawNewUsername}". X requires 4-15 chars, letters/numbers/underscores only. ` +
                `You have NOT been charged.`,
                EXIT.BAD_INPUT
              )
            }
            const acc = await ensureLocalAccount(username!)
            const sess = sv.loadSession(acc.id)
            if (!sess || !sess.cookies || sess.cookies.length === 0) {
              err(`No cached session. Run 'twitter login ${username}' first.`, EXIT.NOT_FOUND)
            }
            // Unlock password locally — transits to server only in this call.
            const creds = sv.unlockCredentials(platform, username!)
            if (!creds.password) err('Account has no password in vault — cannot authenticate username change.')

            const psid = sv.getProxySessionId(platform, username!)
            let data: any
            try {
              data = await ao.socialTwitterUsername(acc.id, sess!.cookies, newUsername, creds.password, psid)
            } catch (e: any) {
              err(`Username change failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) {
              err(
                `Username change failed: ${data?.error || 'unknown'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }

            // Sync local record to the new handle.
            const renamed = sv.renameAccount(platform, username, newUsername.replace(/^@/, ''))
            sv.updateMeta(platform, renamed.username, { last_action_at: new Date().toISOString() })
            return print({ success: true, platform, old_username: username, new_username: renamed.username })
          }

          case 'post':
          case 'thread':
          case 'reply':
          case 'like':
          case 'retweet':
          case 'follow':
          case 'unfollow':
          case 'delete':
          case 'bio':
          case 'name':
          case 'location':
          case 'website':
          case 'pfp':
          case 'banner': {
            const username = positional[0] || (flags.username as string)
            if (!username) err(`<username> required`)
            const acc = await ensureLocalAccount(username!)
            const sess = sv.loadSession(acc.id)
            if (!sess || !sess.cookies || sess.cookies.length === 0) {
              err(
                `No cached session for ${username}. Run 'twitter login ${username}' first.`,
                EXIT.NOT_FOUND
              )
            }
            const psid = sv.getProxySessionId(platform, username!)

            let data: any
            try {
              if (subcommand === 'post') {
                const text = (flags.body as string) || (flags.text as string)
                if (!text) err('--body "..." required')
                const communityId = (flags.community as string) || (flags['community-id'] as string) || undefined
                // Build optional media array. CLI supports the common cases:
                // --image path[,path,path,path] for 1-4 local image files,
                // --video path for a single local video file,
                // --media-json '[{...}]' as the full-power escape hatch
                // (mix image_url / image_base64 / video_url / video_base64).
                const media: Array<{ image_base64?: string; image_url?: string; video_base64?: string; video_url?: string }> = []
                if (flags.image) {
                  for (const fp of (flags.image as string).split(',').map((p: string) => p.trim()).filter(Boolean)) {
                    let buf: Buffer
                    try { buf = readFileSync(fp) } catch (e: any) { err(`--image ${fp}: ${e.message}`); continue }
                    const ext = extname(fp).slice(1).toLowerCase() || 'png'
                    media.push({ image_base64: `data:image/${ext};base64,${buf.toString('base64')}` })
                  }
                }
                if (flags.video) {
                  const fp = flags.video as string
                  let buf: Buffer
                  try { buf = readFileSync(fp) } catch (e: any) { err(`--video ${fp}: ${e.message}`) }
                  const ext = extname(fp).slice(1).toLowerCase() || 'mp4'
                  media.push({ video_base64: `data:video/${ext};base64,${buf!.toString('base64')}` })
                }
                if (flags['media-json']) {
                  let parsed: any
                  try { parsed = JSON.parse(flags['media-json'] as string) }
                  catch (e: any) { err(`--media-json: ${e.message}`) }
                  if (!Array.isArray(parsed)) err('--media-json must be a JSON array of media objects')
                  media.push(...parsed)
                }
                if (media.length > 0) {
                  data = await ao.socialTwitterPostWithMedia(acc!.id, sess!.cookies, text, media, psid, communityId)
                } else {
                  data = await ao.socialTwitterPost(acc!.id, sess!.cookies, text, psid, communityId)
                }
              } else if (subcommand === 'thread') {
                // --texts accepts a JSON-encoded array of strings, OR --file points
                // to a JSON file with the same shape. Each tweet ≤280 chars; 1-25
                // tweets per thread. Single-tweet "threads" delegate to a normal post.
                const textsRaw = (flags.texts as string) || (flags.body as string)
                const filePath = (flags.file as string) || (flags.path as string)
                let texts: string[] | undefined
                if (filePath) {
                  // Strip UTF-8 BOM that PS 5.1's `Set-Content -Encoding utf8` prepends.
                  try { texts = JSON.parse(readFileSync(filePath, 'utf8').replace(/^﻿/, '')) }
                  catch (e: any) { err(`--file ${filePath}: ${e.message}`) }
                } else if (textsRaw) {
                  try { texts = JSON.parse(textsRaw) }
                  catch (e: any) { err(`--texts must be a JSON array of strings: ${e.message}`) }
                }
                if (!Array.isArray(texts) || texts.length === 0) {
                  err('--texts \'["tweet 1","tweet 2",...]\' or --file <path> required')
                }
                const communityIdT = (flags.community as string) || (flags['community-id'] as string) || undefined
                data = await ao.socialTwitterPostThread(acc!.id, sess!.cookies, texts!, psid, communityIdT)
              } else if (subcommand === 'reply') {
                const tweetUrl = (flags.to as string) || (flags.tweet as string)
                const text = (flags.body as string) || (flags.text as string)
                if (!tweetUrl) err('--to <tweet-url> required')
                if (!text) err('--body "..." required')
                data = await ao.socialTwitterReply(acc!.id, sess!.cookies, tweetUrl, text, psid)
              } else if (subcommand === 'like') {
                const tweetUrl = (flags.tweet as string) || (flags.url as string)
                if (!tweetUrl) err('--tweet <tweet-url> required')
                data = await ao.socialTwitterLike(acc!.id, sess!.cookies, tweetUrl, psid)
              } else if (subcommand === 'retweet') {
                const tweetUrl = (flags.tweet as string) || (flags.url as string)
                if (!tweetUrl) err('--tweet <tweet-url> required')
                data = await ao.socialTwitterRetweet(acc!.id, sess!.cookies, tweetUrl, psid)
              } else if (subcommand === 'follow') {
                const target = (flags.user as string) || (flags.target as string)
                if (!target) err('--user <@handle> required')
                data = await ao.socialTwitterFollow(acc!.id, sess!.cookies, target, psid)
              } else if (subcommand === 'unfollow') {
                const target = (flags.user as string) || (flags.target as string)
                if (!target) err('--user <@handle> required')
                data = await ao.socialTwitterUnfollow(acc!.id, sess!.cookies, target, psid)
              } else if (subcommand === 'delete') {
                const tweetUrl = (flags.tweet as string) || (flags.url as string)
                if (!tweetUrl) err('--tweet <tweet-url> required')
                data = await ao.socialTwitterDelete(acc!.id, sess!.cookies, tweetUrl, psid)
              } else if (subcommand === 'bio') {
                const text = (flags.text as string) || (flags.body as string)
                if (text === undefined) err('--text "..." required (pass "" to clear)')
                data = await ao.socialTwitterProfile(acc!.id, sess!.cookies, { bio: text }, psid)
              } else if (subcommand === 'name') {
                const text = (flags.display as string) || (flags.text as string) || (flags.name as string)
                if (!text) err('--display "Display Name" required')
                data = await ao.socialTwitterProfile(acc!.id, sess!.cookies, { display_name: text }, psid)
              } else if (subcommand === 'location') {
                // `--location` is the documented flag (TWITTER_HELP); `--text`
                // is accepted as an alias. Refuse to submit an empty value
                // UNLESS the caller explicitly passed an empty string — a bare
                // `twitter location <user>` used to default to '' and silently
                // (and billably) wipe the field.
                const explicit = flags.location !== undefined ? flags.location : flags.text
                if (explicit === undefined) {
                  err('--location "..." required (pass --location "" to deliberately clear it)', EXIT.BAD_INPUT)
                }
                const text = String(explicit)
                data = await ao.socialTwitterProfile(acc!.id, sess!.cookies, { location: text }, psid)
              } else if (subcommand === 'website') {
                const url = (flags.url as string) || (flags.text as string) || ''
                data = await ao.socialTwitterProfile(acc!.id, sess!.cookies, { website: url }, psid)
              } else {
                // pfp / banner: accept --file (local path, base64-encoded here)
                // OR --url (hosted image, server fetches).
                const filePath = (flags.file as string) || (flags.path as string)
                const imageUrl = flags.url as string
                if (!filePath && !imageUrl) err('--file <local-path> or --url <https-url> required')
                let image: { image_base64?: string; image_url?: string } = {}
                if (filePath) {
                  const { readFileSync, existsSync } = await import('fs')
                  if (!existsSync(filePath)) err(`File not found: ${filePath}`, EXIT.NOT_FOUND)
                  const buf = readFileSync(filePath)
                  const ext = filePath.toLowerCase().match(/\.(png|jpg|jpeg|webp|gif)$/)?.[1] || 'png'
                  image.image_base64 = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`
                } else {
                  image.image_url = imageUrl
                }
                if (subcommand === 'pfp') {
                  data = await ao.socialTwitterAvatar(acc!.id, sess!.cookies, image, psid)
                } else {
                  data = await ao.socialTwitterBanner(acc!.id, sess!.cookies, image, psid)
                }
              }
            } catch (e: any) {
              err(`${subcommand} failed: ${e.message}`, EXIT.GENERAL)
            }

            // avatar (pfp) / banner are ASYNC server-side: the POST returns a
            // 202 { operation_id, poll_url } and the work runs in the background.
            // Poll to a terminal state; --no-wait returns the id. A legacy sync
            // server (no operation_id) falls through to the {success,data}
            // handling below for back-compat.
            if (data?.operation_id && (subcommand === 'pfp' || subcommand === 'banner')) {
              const opId = data.operation_id
              const pollUrl = data.poll_url || `/social/twitter/operations/${opId}`
              const pollAfter = Math.max(1, Number(data.poll_after_seconds) || 10)
              const ndjson = AGENT_MODE
              if (flags.wait === false) {
                log(`twitter ${subcommand} (async): ${username} op=${opId}`)
                return print({ operation_id: opId, status: data.status || 'running', done: false, poll_url: pollUrl, message: data.message })
              }
              const POLL_TIMEOUT_MS = 240_000
              const intervalMs = pollAfter * 1000
              const deadline = Date.now() + POLL_TIMEOUT_MS
              const maxAttempts = Math.ceil(POLL_TIMEOUT_MS / intervalMs) + 1
              const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
              if (!ndjson) process.stderr.write(`twitter ${subcommand}: working… (up to ~2 min)\n`)
              let final: any = null
              let attempt = 0
              while (attempt < maxAttempts && Date.now() < deadline) {
                await sleep(intervalMs)
                attempt++
                let op: any
                try {
                  op = await ao.socialTwitterOperation(opId)
                } catch (e: any) {
                  if (ndjson) process.stderr.write(JSON.stringify({ event: 'poll', status: 'error', attempt, message: e?.message ?? String(e) }) + '\n')
                  continue
                }
                if (ndjson) process.stderr.write(JSON.stringify({ event: 'poll', status: op?.status || 'running', attempt }) + '\n')
                if (op?.done === true || op?.status === 'failed') { final = op; break }
              }
              if (!final) {
                log(`twitter ${subcommand} (pending): ${username} op=${opId}`)
                return print({ operation_id: opId, status: 'running', done: false, poll_url: pollUrl, message: `Still running after ${Math.round(POLL_TIMEOUT_MS / 1000)}s. It continues server-side — re-check with GET ${pollUrl}.` })
              }
              if (final.status === 'failed') {
                log(`twitter ${subcommand} (failed): ${username} op=${opId} refund=${final.refund_status || 'unknown'}`)
                print(final)
                process.stderr.write(JSON.stringify({ error: final.error || `twitter ${subcommand} failed`, error_code: final.error_code, refund_status: final.refund_status, exitCode: EXIT.GENERAL }) + '\n')
                process.exit(EXIT.GENERAL)
              }
              // Success — reshape into the {success,data} the sync path prints.
              data = { success: true, data: final.result || {} }
            }

            if (!data?.success) {
              err(
                `${subcommand} failed: ${data?.error || 'unknown'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }

            if (acc) sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
            return print({ success: true, platform, username, op: subcommand, ...(data?.data || {}) })
          }

          case 'buy': {
            // Agents say "buy" with optional filters. Each is independent
            // (default: random across that dimension).
            //
            //   --country GB              account_based_in = United Kingdom (residency)
            //   --registered-country GB   X's "Connected via …" country
            //   --platform android|ios|web   X's "Connected via" platform
            //   --max-renames 0           never-renamed accounts only
            //   --source "raw string"     exact-match on the raw "Connected via" string (power user)
            //
            // Pricing = country_price * source_multiplier (multiplier
            // defaults to 1.0 when no source row exists). Without --country,
            // falls back to the legacy $5 flat rate.
            const country = ((flags.country as string) || '').trim().toUpperCase() || undefined
            const ageCategory = (flags.age as string) || (flags['age-category'] as string) || undefined
            const source = ((flags.source as string) || '').trim().toLowerCase() || undefined
            const registeredCountry =
              ((flags['registered-country'] as string) || '').trim().toUpperCase() || undefined
            const platformFlag = ((flags.platform as string) || '').trim().toLowerCase() || undefined
            if (platformFlag && !['android', 'ios', 'web'].includes(platformFlag)) {
              err('--platform must be one of: android, ios, web')
            }
            const registeredPlatform = platformFlag as 'android' | 'ios' | 'web' | undefined
            const maxRenamesRaw = flags['max-renames']
            const maxUsernameChanges =
              maxRenamesRaw === undefined || maxRenamesRaw === ''
                ? undefined
                : Number(maxRenamesRaw)
            if (maxUsernameChanges !== undefined && (!Number.isFinite(maxUsernameChanges) || maxUsernameChanges < 0)) {
              err('--max-renames must be a non-negative integer (e.g. 0 = never renamed)')
            }
            let data: any
            try {
              data = await ao.socialTwitterBuy(country, ageCategory, {
                source,
                registeredCountry,
                registeredPlatform,
                maxUsernameChanges,
              })
            } catch (e: any) {
              err(`Buy failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success || !data.account) {
              err(`Buy failed: ${data?.error || 'no account returned'}`, EXIT.GENERAL)
            }
            const { account } = data
            // Auto-import into the local vault + prime the session cache so
            // the buyer can post immediately with the cookies the admin
            // pre-seasoned at pool-add time.
            const filterTags = [
              country && `country=${country}`,
              registeredCountry && `registered_country=${registeredCountry}`,
              registeredPlatform && `platform=${registeredPlatform}`,
              source && `source=${source}`,
              maxUsernameChanges !== undefined && `max_renames=${maxUsernameChanges}`,
            ].filter(Boolean).join(', ')
            const summary = sv.importAccount(platform, account.username, account.credentials, {
              source: 'pool',
              proxy_session_id: account.proxy_session_id,
              notes: filterTags ? `Bought from pool (${filterTags})` : 'Bought from pool',
            })
            sv.saveSession(summary.id, platform, account.cookies || [])
            sv.updateMeta(platform, summary.username, { last_action_at: new Date().toISOString() })
            return print({
              success: true,
              platform,
              username: summary.username,
              country: account.country,
              registered_country: account.registered_country,
              registered_platform: account.registered_platform,
              source: account.source,
              username_change_count: account.username_change_count,
              account_based_in: account.account_based_in,
              account_id: account.id,
              hint: `Ready to post — try: palmyr twitter post ${summary.username} --body "gm". ` +
                    `If the account is suspended within 7 days, run: palmyr twitter dispute ${account.id}`,
            })
          }

          case 'pool-prices': {
            // Public: which countries are priced and what they cost. Run
            // before `buy --country X` to confirm the country is available.
            let data: any
            try {
              data = await ao.socialTwitterPoolPrices()
            } catch (e: any) {
              err(`pool-prices failed: ${e.message}`, EXIT.GENERAL)
            }
            return print(data)
          }

          case 'pool-set-price': {
            // Admin: set USDC price for a single country code. Idempotent.
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const country = ((flags.country as string) || '').trim().toUpperCase()
            const price = flags.price !== undefined ? Number(flags.price) : NaN
            if (!country) err('--country <CC> required (ISO 3166-1 alpha-2: US, GB, DE, …)')
            if (!Number.isFinite(price) || price <= 0) err('--price <USDC> required (positive number)')
            const path = `/social/twitter/pool/prices/${encodeURIComponent(country)}`
            const headers = buildAdminHeaders('PUT', path)
            const res = await fetch(ao.api + path, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({ price_usdc: price }),
            })
            const data = await res.json() as any
            if (!res.ok || !data.success) err(`pool-set-price failed: ${data.error || `HTTP ${res.status}`}`, EXIT.GENERAL)
            return print(data)
          }

          case 'pool-delete-price': {
            // Admin: remove the row for a country. Subsequent `buy --country X`
            // will return 400 "Country not priced" until set again.
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const country = ((flags.country as string) || '').trim().toUpperCase()
            if (!country) err('--country <CC> required')
            const path = `/social/twitter/pool/prices/${encodeURIComponent(country)}`
            const headers = buildAdminHeaders('DELETE', path)
            const res = await fetch(ao.api + path, { method: 'DELETE', headers })
            const data = await res.json() as any
            if (!res.ok) err(`pool-delete-price failed: ${data.error || `HTTP ${res.status}`}`, EXIT.GENERAL)
            return print(data)
          }

          case 'pool-set-source-multiplier': {
            // Admin: scale the country price for buys filtered by a given
            // source ('web', 'mobile', …). e.g. mult=1.2 → web buys cost
            // 20% more than the base country price.
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const source = ((flags.source as string) || '').trim().toLowerCase()
            const mult = flags.multiplier !== undefined ? Number(flags.multiplier) : NaN
            if (!source) err('--source <name> required (e.g. web, mobile)')
            if (!Number.isFinite(mult) || mult <= 0) err('--multiplier <number> required (positive)')
            const path = `/social/twitter/pool/source-multipliers/${encodeURIComponent(source)}`
            const headers = buildAdminHeaders('PUT', path)
            const res = await fetch(ao.api + path, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({ multiplier: mult }),
            })
            const data = await res.json() as any
            if (!res.ok || !data.success) err(`pool-set-source-multiplier failed: ${data.error || `HTTP ${res.status}`}`, EXIT.GENERAL)
            return print(data)
          }

          case 'pool-delete-source-multiplier': {
            // Admin: drop the multiplier for a source. Subsequent `buy
            // --source X` reverts to using 1.0 (filter only, no price scaling).
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const source = ((flags.source as string) || '').trim().toLowerCase()
            if (!source) err('--source <name> required')
            const path = `/social/twitter/pool/source-multipliers/${encodeURIComponent(source)}`
            const headers = buildAdminHeaders('DELETE', path)
            const res = await fetch(ao.api + path, { method: 'DELETE', headers })
            const data = await res.json() as any
            if (!res.ok) err(`pool-delete-source-multiplier failed: ${data.error || `HTTP ${res.status}`}`, EXIT.GENERAL)
            return print(data)
          }

          case 'dispute': {
            // Buyer: file a dispute for a pool-bought account that got
            // suspended. Server auto-verifies via twitterapi.io and either
            // hands over a same-country replacement, refunds USDC, or queues
            // for admin review when the signal is ambiguous.
            const accountId = positional[0] || (flags['account-id'] as string) || (flags.id as string)
            const reason = ((flags.reason as string) || 'suspended') as 'suspended' | 'other'
            const evidence = (flags.evidence as string) || (flags.note as string) || undefined
            if (!accountId) err('<account_id> required (the id returned by `palmyr twitter buy`)')
            if (reason !== 'suspended' && reason !== 'other') err('--reason must be "suspended" or "other"')

            let data: any
            try {
              data = await ao.socialTwitterDispute(accountId!, { reason, evidence })
            } catch (e: any) {
              err(`Dispute failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.success) err(`Dispute failed: ${data?.error || 'unknown'}`, EXIT.GENERAL)
            return print(data)
          }

          case 'disputes': {
            // Buyer: list ONE specific dispute by id. Listing all your
            // disputes isn't supported by the buyer surface today — track
            // the id printed by `dispute` and call `disputes <id>`.
            const id = positional[0] || (flags.id as string)
            if (!id) err('<dispute_id> required')
            let data: any
            try {
              data = await ao.socialTwitterDisputeGet(id!)
            } catch (e: any) {
              err(`Get dispute failed: ${e.message}`, EXIT.GENERAL)
            }
            return print(data)
          }

          case 'pool-disputes': {
            // Admin: list every dispute, optionally filter by status. The
            // `admin_review` queue is the human-decision backlog.
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const status = (flags.status as string) || undefined
            const path = '/social/twitter/pool/disputes' + (status ? `?status=${encodeURIComponent(status)}` : '')
            const headers = buildAdminHeaders('GET', path)
            const res = await fetch(ao.api + path, { headers })
            const data = await res.json() as any
            if (!res.ok) err(`pool-disputes failed: ${data.error || `HTTP ${res.status}`}`, EXIT.GENERAL)
            return print(data)
          }

          case 'pool-resolve-dispute': {
            // Admin: resolve an admin_review dispute. action ∈ replace |
            // refund | reject. `replace` needs same-country stock; `refund`
            // needs payment provenance on the row (auto-saved at buy time).
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const id = positional[0] || (flags.id as string)
            const action = (flags.action as string) as 'replace' | 'refund' | 'reject' | undefined
            const note = (flags.note as string) || undefined
            if (!id) err('<dispute_id> required')
            if (action !== 'replace' && action !== 'refund' && action !== 'reject') {
              err('--action must be "replace", "refund", or "reject"')
            }
            const path = `/social/twitter/pool/disputes/${encodeURIComponent(id!)}/resolve`
            const headers = buildAdminHeaders('POST', path)
            const res = await fetch(ao.api + path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({ action, ...(note ? { note } : {}) }),
            })
            const data = await res.json() as any
            if (!res.ok || !data.success) err(`pool-resolve-dispute failed: ${data.error || `HTTP ${res.status}`}`, EXIT.GENERAL)
            return print(data)
          }

          case 'pool-add': {
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const file = (flags.file as string) || (flags.batch as string)
            const line = flags['credentials-line'] as string
            const country = (flags.country as string) || undefined
            const ageCategory = (flags.age as string) || (flags['age-category'] as string) || undefined
            const price = flags.price !== undefined ? Number(flags.price) : undefined
            if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
              err('--price <USDC> required (e.g. --price 5)')
            }
            if (!file && !line) {
              err('Either --credentials-line "..." or --file path/to/accounts.txt required')
            }

            // Collect credentials lines from flag or file.
            let lines: string[] = []
            if (line) {
              lines = [line]
            } else {
              const { readFileSync, existsSync } = await import('fs')
              if (!existsSync(file!)) err(`File not found: ${file}`, EXIT.NOT_FOUND)
              lines = readFileSync(file!, 'utf8')
                .split(/\r?\n/)
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('#')) // # = comment
            }

            const results: any[] = []
            const isInteractive = !AGENT_MODE
            let spin: any = null
            if (isInteractive && lines.length > 1) {
              spin = new Spinner()
              spin.start(`Seeding pool (0/${lines.length})`)
            }

            for (let i = 0; i < lines.length; i++) {
              const credsLine = lines[i]
              if (spin) spin.update(`Seeding pool (${i + 1}/${lines.length})`)
              try {
                const headers = buildAdminHeaders('POST', '/social/twitter/pool-add')
                const res = await fetch(ao.api + '/social/twitter/pool-add', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...headers },
                  body: JSON.stringify({
                    credentials_line: credsLine,
                    country,
                    age_category: ageCategory,
                    sale_price_usdc: price,
                  }),
                })
                const data = await res.json() as any
                if (!res.ok || !data.success) {
                  results.push({ index: i, success: false, error: data.error || `HTTP ${res.status}`, username: credsLine.split(':')[0] })
                } else {
                  results.push({ index: i, success: true, id: data.id, username: credsLine.split(':')[0], cookies_captured: data.cookies_captured })
                }
              } catch (e: any) {
                results.push({ index: i, success: false, error: e.message, username: credsLine.split(':')[0] })
              }
            }
            if (spin) {
              const ok = results.filter(r => r.success).length
              spin.stop(`Seeded ${ok}/${lines.length} accounts`, ok === lines.length)
            }
            return print({
              total: lines.length,
              seeded: results.filter(r => r.success).length,
              failed: results.filter(r => !r.success).length,
              results,
            })
          }

          case 'pool-status': {
            const { buildAdminHeaders } = await import('./admin-auth.js')
            const headers = buildAdminHeaders('GET', '/social/twitter/pool-status')
            const res = await fetch(ao.api + '/social/twitter/pool-status', { headers })
            const data = await res.json() as any
            if (!res.ok) err(`Pool status failed: ${data.error || `HTTP ${res.status}`}`, EXIT.GENERAL)
            return print(data)
          }

          case 'status': {
            // `twitter status` was meant to check live shadow-ban / suspension
            // state via a server-side probe. That's a Phase 3 build (needs a
            // browser runtime on the server to render the profile). Until
            // then, point users at `session` for the cached login state and
            // `info` for vault metadata — together they cover the practical
            // "is this account still usable from the agent's side" question.
            err(
              `twitter status: not wired yet (Phase 3). Closest equivalents available today: ` +
              `\`palmyr twitter session <username>\` (cached server-side login validity) and ` +
              `\`palmyr twitter info <username>\` (local vault record).`,
              EXIT.GENERAL,
            )
          }

          case 'transfer': {
            // Hand the X account to another wallet. End-to-end one-command:
            //   1. If the account is only in the local vault, auto-register it
            //      with the server (uploads encrypted creds; $0.01 USDC).
            //   2. Server rotates the password and revokes other sessions
            //      ($0.01 USDC ownership proof).
            //   3. Atomically flips ownership in the DB.
            // Receiver picks up the rotated credentials via `palmyr twitter
            // list` (which now surfaces server-side accounts) and/or `claim`.
            const username = positional[0] || (flags.username as string)
            const to = flags.to as string
            if (!username) err('<username> required')
            if (!to) err('--to <wallet> required')

            const acc = sv.getAccount(platform, username!)
            if (!acc) err(`twitter account "${username}" not found locally — can only transfer accounts you own`, EXIT.NOT_FOUND)

            if (!flags.confirm) {
              const tail = to.slice(-6)
              err(
                `This rotates @${username} on X and hands it to a wallet ending in …${tail}. ` +
                `You will lose access immediately and irreversibly. ` +
                `If the account isn't on the Palmyr server yet, it will be auto-registered (~$0.01 USDC) before the transfer.\n\n` +
                `Re-run with --confirm:\n` +
                `  palmyr twitter transfer ${username} --to ${to} --confirm`
              )
            }

            let resolved = await resolveServerAccount(username!)

            // Auto-register if the account is only in the local vault. This
            // is the most common case for accounts that were imported BYO and
            // never explicitly registered. We pull creds straight from the
            // local vault so the user doesn't have to re-type anything.
            if (!resolved) {
              const spinReg = new Spinner()
              spinReg.start(`@${username} not on server yet — auto-registering before transfer…`)
              let regData: any
              try {
                const localCreds = sv.unlockCredentials(platform, username!)
                if (!localCreds.password) {
                  spinReg.stop('Register failed', false)
                  err(
                    `Cannot auto-register @${username}: local vault has no password. ` +
                    `Re-import the account with a password first.`,
                    EXIT.BAD_INPUT
                  )
                }
                const country = sv.getCountry(platform, username!)
                regData = await ao.socialTwitterRegister(username!, localCreds.password, {
                  login: localCreds.login,
                  email: localCreds.email,
                  email_password: localCreds.email_password,
                  totp_seed: localCreds.totp_seed,
                  auth_token: localCreds.auth_token,
                  ct0: localCreds.ct0,
                  country,
                })
              } catch (e: any) {
                spinReg.stop('Register failed', false)
                err(`Auto-register failed: ${e.message}`, EXIT.GENERAL)
              }
              if (!regData?.success || !regData?.id) {
                spinReg.stop('Register failed', false)
                err(
                  `Auto-register failed: ${regData?.error || 'unknown'}` +
                  (regData?.login_error_code ? ` [${regData.login_error_code}]` : '') +
                  `\nFix the credentials in the local vault, then re-run the transfer.`,
                  EXIT.GENERAL
                )
              }
              spinReg.stop('Registered', true)
              resolved = { kind: 'registered', id: regData.id }
            }

            // Transfer-on-pool isn't wired yet (pool table has no transfer
            // endpoint with the async rotation machinery). Surface a clear
            // workaround instead of a silent 404.
            if (resolved!.kind === 'pool') {
              err(
                `@${username} is a pool-bought account and transfer isn't supported on the pool table yet — share/unshare work.\n\n` +
                `Workaround: \`palmyr twitter register ${username}\` first (uploads to the registered table), then re-run the transfer.`,
                EXIT.GENERAL
              )
            }

            const spin = new Spinner()
            spin.start(`Rotating @${username} password and transferring…`)

            // Kick off the transfer. Server responds 202 with a transfer_id;
            // the rotation runs in the background to avoid Cloudflare's HTTP
            // timeout. We poll /transfers/:id until it terminates.
            let kicked: any
            try {
              kicked = resolved!.kind === 'x_accounts'
                ? await ao.xAccountTransfer(resolved!.id, to)
                : await ao.socialTwitterRegisteredTransfer(resolved!.id, to)
            } catch (e: any) {
              spin.stop('Transfer failed', false)
              err(`Transfer failed: ${e.message}`, EXIT.GENERAL)
            }
            const transferId = kicked?.transfer_id
            if (!transferId) {
              spin.stop('Transfer failed', false)
              err(`Server didn't return a transfer_id. Response: ${JSON.stringify(kicked)}`, EXIT.GENERAL)
            }

            // Poll every 5s; cap at 5 minutes so a stuck transfer doesn't
            // hang the CLI forever. The server's own startup sweep will mark
            // anything still stuck after 5 min as failed.
            const startedAt = Date.now()
            const MAX_WAIT_MS = 5 * 60 * 1000
            let status: any = null
            while (true) {
              if (Date.now() - startedAt > MAX_WAIT_MS) {
                spin.stop('Timed out waiting', false)
                err(
                  `Transfer ${transferId} is still in progress after 5 min. Check status with: ` +
                  `curl https://palmyr.ai/transfers/${transferId} (with payment header)`,
                  EXIT.GENERAL
                )
              }
              await new Promise(r => setTimeout(r, 5000))
              try {
                status = await ao.transferStatus(transferId!)
              } catch (e: any) {
                // Transient poll failures shouldn't abort — the rotation is
                // still running on the server. Surface it but keep polling.
                spin.update(`Poll error (will retry): ${e.message}`)
                continue
              }
              spin.update(`Status: ${status.status}…`)
              if (status.status === 'completed' || status.status === 'failed') break
            }

            if (status.status === 'failed') {
              spin.stop('Transfer failed', false)
              err(
                `Transfer failed: ${status.error || 'unknown'}` +
                (status.error_code ? ` [${status.error_code}]` : ''),
                EXIT.GENERAL
              )
            }
            spin.stop('Transferred', true)

            // Local vault still holds the OLD password / cookies which are
            // now useless. Drop the entry so we don't confuse the user with a
            // ghost account they can't log into.
            try { sv.removeAccount(platform, username!) } catch { /* best effort */ }

            return print({
              ...status,
              source_table: resolved!.kind,
              local_vault_cleared: true,
            })
          }

          case 'share': {
            const username = positional[0] || (flags.username as string)
            const withWallet = (flags.with as string) || (flags.wallet as string)
            if (!username) err('<username> required')
            if (!withWallet) err('--with <wallet> required')

            const acc = sv.getAccount(platform, username!)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)

            const resolved = await resolveServerAccount(username!)
            if (!resolved) {
              err(
                `@${username} is not on the server. Register it first with: palmyr twitter register ${username}`,
                EXIT.NOT_FOUND
              )
            }

            const data = resolved!.kind === 'x_accounts'
              ? await ao.xAccountShare(resolved!.id, withWallet)
              : resolved!.kind === 'pool'
                ? await ao.socialTwitterPoolShare(resolved!.id, withWallet)
                : await ao.socialTwitterRegisteredShare(resolved!.id, withWallet)
            log(`twitter share: @${username} → ${withWallet}`)
            return print({ ...data, source_table: resolved!.kind })
          }

          case 'unshare': {
            const username = positional[0] || (flags.username as string)
            const targetWallet = (flags.from as string) || (flags.wallet as string)
            const rotate = !!flags.rotate
            if (!username) err('<username> required')
            if (!targetWallet) err('--from <wallet> required')

            const acc = sv.getAccount(platform, username!)
            if (!acc) err(`twitter account "${username}" not found locally`, EXIT.NOT_FOUND)

            const resolved = await resolveServerAccount(username!)
            if (!resolved) {
              err(
                `@${username} is not on the server. Register it first with: palmyr twitter register ${username}`,
                EXIT.NOT_FOUND
              )
            }

            const spin = rotate ? new Spinner() : null
            if (spin) spin.start(`Unsharing @${username} and rotating password…`)

            let data: any
            try {
              if (resolved!.kind === 'x_accounts') {
                data = await ao.xAccountUnshare(resolved!.id, targetWallet, { rotate })
              } else if (resolved!.kind === 'pool') {
                // The pool unshare endpoint doesn't support rotate today
                // (rotation infra lives on the transfers async pipeline and
                // hasn't been wired to pool yet). Warn and call without rotate.
                if (rotate) warn(`--rotate not supported on pool-bought accounts yet — performing unshare only`)
                data = await ao.socialTwitterPoolUnshare(resolved!.id, targetWallet)
              } else {
                data = await ao.socialTwitterRegisteredUnshare(resolved!.id, targetWallet, { rotate })
              }
            } catch (e: any) {
              if (spin) spin.stop('Unshare failed', false)
              err(`Unshare failed: ${e.message}`, EXIT.GENERAL)
            }

            // If the server kicked off an async rotation, poll until it
            // settles. Same polling pattern as transfer — Playwright takes
            // longer than Cloudflare's HTTP response budget.
            if (rotate && data?.transfer_id) {
              const transferId = data.transfer_id as string
              const startedAt = Date.now()
              const MAX_WAIT_MS = 5 * 60 * 1000
              let status: any = null
              while (true) {
                if (Date.now() - startedAt > MAX_WAIT_MS) {
                  if (spin) spin.stop('Rotation timed out', false)
                  err(
                    `Rotation ${transferId} still in progress after 5 min. ` +
                    `Account is unshared but cached cookies on the revoked wallet may still work until X-side expiry. ` +
                    `Check status at /transfers/${transferId}.`,
                    EXIT.GENERAL
                  )
                }
                await new Promise(r => setTimeout(r, 5000))
                try {
                  status = await ao.transferStatus(transferId)
                } catch (e: any) {
                  if (spin) spin.update(`Poll error (will retry): ${e.message}`)
                  continue
                }
                if (spin) spin.update(`Rotation: ${status.status}…`)
                if (status.status === 'completed' || status.status === 'failed') break
              }
              if (status.status === 'failed') {
                if (spin) spin.stop('Rotation failed', false)
                warn(
                  `Unshare succeeded but rotation failed: ${status.error || 'unknown'}` +
                  (status.error_code ? ` [${status.error_code}]` : '') +
                  `. The revoked wallet's cached cookies may still work until X-side expiry. Retry rotation if needed.`
                )
                data = { ...data, rotated: false, rotation_error: status.error, rotation_error_code: status.error_code }
              } else {
                if (spin) spin.stop('Unshared and rotated', true)
                // Fetch fresh creds from the appropriate /mine endpoint and
                // sync the local vault. Caller is still the owner, so the
                // server returns the new credentials they need.
                try {
                  const mineResp = resolved!.kind === 'x_accounts'
                    ? await ao.xAccountsMine()
                    : await ao.socialTwitterRegisteredMine()
                  const fresh = (mineResp?.accounts || []).find((a: any) => a.username === username)
                  if (fresh) {
                    const existing = sv.unlockCredentials(platform, username!)
                    const isReg = resolved!.kind === 'registered'
                    const freshPassword = isReg ? fresh.credentials?.password : fresh.password
                    const freshAuth = isReg ? fresh.credentials?.auth_token : fresh.auth_token
                    const freshCookies = fresh.cookies || []
                    const next: import('./social-vault.js').SocialCredentials = {
                      ...existing,
                      password: freshPassword || existing.password,
                      auth_token: freshAuth || undefined,
                      ct0: freshCookies.find((c: any) => c.name === 'ct0')?.value || existing.ct0,
                    }
                    sv.replaceCredentials(platform, username!, next)
                    if (Array.isArray(freshCookies) && freshCookies.length > 0) {
                      sv.saveSession(acc!.id, platform, freshCookies)
                    }
                  }
                } catch (e: any) {
                  warn(`Local vault sync failed: ${e.message}. Run 'palmyr twitter claim' to refresh from server.`)
                }
                data = { ...data, rotated: true, credentials: { rotated: true, persisted_locally: true } }
              }
            } else {
              if (spin) spin.stop('Unshared (rotation skipped)', false)
            }

            log(`twitter unshare: @${username} ✗ ${targetWallet}${rotate ? ' (rotated)' : ''}`)
            return print({ ...data, source_table: resolved!.kind })
          }

          case 'claim': {
            // Fetch server-side accounts the calling wallet owns or has shared
            // access to — from all THREE tables. x_accounts (legacy pool),
            // social_account_pool (where `palmyr twitter buy` writes), and
            // social_registered_accounts (BYO-registered) are queried in
            // parallel; all three contribute to the claim list. Import any
            // not already in the local vault so the receiver of a transfer
            // or share can pick up the account in one command.
            const [xRes, poolRes, regRes] = await Promise.allSettled([
              ao.xAccountsMine(),
              ao.socialTwitterPoolMine(),
              ao.socialTwitterRegisteredMine(),
            ])

            const xAccounts: any[] = xRes.status === 'fulfilled' ? (xRes.value?.accounts || []) : []
            const poolAccountsRaw: any[] = poolRes.status === 'fulfilled' ? (poolRes.value?.accounts || []) : []
            const regAccountsRaw: any[] = regRes.status === 'fulfilled' ? (regRes.value?.accounts || []) : []

            // Normalize the registered + pool shape (creds + cookies live in
            // nested fields) to the same flat shape as x_accounts so the
            // loop below doesn't have to branch on source.
            const regAccounts: any[] = regAccountsRaw.map(a => ({
              username: a.username,
              email: a.credentials?.email,
              password: a.credentials?.password,
              auth_token: a.credentials?.auth_token,
              cookies: a.cookies || [],
              access: a.access,
              source_table: 'registered',
            }))
            const poolAccounts: any[] = poolAccountsRaw.map(a => ({
              username: a.username,
              email: a.credentials?.email,
              password: a.credentials?.password,
              auth_token: a.credentials?.auth_token,
              cookies: a.cookies || [],
              access: a.access,
              proxy_session_id: a.proxy_session_id,
              country: a.country,
              source_table: 'pool',
            }))
            const accounts: any[] = [
              ...xAccounts.map(a => ({ ...a, source_table: 'x_accounts' })),
              ...poolAccounts,
              ...regAccounts,
            ]

            if (accounts.length === 0) {
              log('No X accounts associated with your wallet on the server.')
              return print({ count: 0, claimed: 0, accounts: [] })
            }

            const imported: any[] = []
            const skipped: any[] = []
            for (const a of accounts) {
              const existing = sv.getAccount(platform, a.username)
              if (existing) {
                skipped.push({ username: a.username, reason: 'already in local vault' })
                continue
              }
              try {
                const ct0 = (a.cookies || []).find((c: any) => c.name === 'ct0')?.value
                const creds: import('./social-vault.js').SocialCredentials = {
                  login: a.email || a.username,
                  password: a.password,
                  email: a.email,
                  auth_token: a.auth_token || undefined,
                  ct0,
                }
                const summary = sv.importAccount(platform, a.username, creds, {
                  source: 'claim',
                  proxy_session_id: a.proxy_session_id,
                  country: a.country || undefined,
                })
                // Save the cookies so `palmyr twitter login` can use the
                // cookie-fast-path instead of re-driving the login form.
                if (Array.isArray(a.cookies) && a.cookies.length > 0) {
                  sv.saveSession(summary.id, platform, a.cookies)
                }
                imported.push({ username: a.username, id: summary.id, access: a.access, source_table: a.source_table })
              } catch (e: any) {
                skipped.push({ username: a.username, reason: e.message })
              }
            }

            log(`twitter claim: imported ${imported.length}, skipped ${skipped.length} (of ${accounts.length})`)
            return print({
              count: accounts.length,
              claimed: imported.length,
              imported,
              skipped,
            })
          }

          default:
            err(`Unknown twitter command: ${subcommand}. Try: import, list, info, rename, remove, totp, login, manual-login, session, register, registered, schedule, post, thread, reply, like, retweet, follow, unfollow, delete, list-tweets, bio, name, location, website, pfp, banner, username, buy, transfer, share, unshare, claim`)
        }
        break
      }

      case 'tiktok': {
        const sv = await import('./social-vault.js')
        const sd = await import('./social-drafts.js')
        const sa = await import('./social-analytics.js')
        const platform = 'tiktok' as const

        // Same help guard as `twitter` — prevents `--help` from dispatching
        // a paid subcommand. Same bug class lived here too in 1.8.3.
        if (!subcommand || (flags.help && !TIKTOK_HELP[subcommand])) {
          showMenu({
            command: 'tiktok',
            title: 'tiktok',
            subtitle: 'Automated TikTok account management',
            footerLeft: 'Start with `connect`: log in once in your own browser, then post / follow / like — all server-side.',
            commands: [
              { name: 'connect', description: 'Log in once via your own browser — opens TikTok, you sign in (incl. captcha/2FA), and Palmyr auto-captures the session into the local vault. Auto-creates the account and infers the country from your browser. This is the easy path.', hint: '<username> [--tag <folder>]' },
              { name: 'import',  description: 'Manual fallback to `connect`: save a BYO account from a marketplace --credentials-line "login:pw:email:email_pw", or paste cookies from DevTools → Application → Cookies → .tiktok.com via --sessionid.', hint: '--credentials-line "..." OR <username> --sessionid ... --csrf ... --webid ...' },
              { name: 'list',    description: 'List TikTok accounts; --server lists what the wallet owns server-side (with session health), --tag filters to one folder', hint: '[--server] [--tag <folder>]' },
              { name: 'info',    description: 'Show one account', hint: '<username>' },
              { name: 'rename',  description: 'Update the local handle', hint: '<old> --to <new>' },
              { name: 'tag',     description: 'Group an account under a folder-like tag so one agent can organize 30+ accounts; --clear removes it', hint: '<username> <folder> | <username> --clear' },
              { name: 'remove',  description: 'Delete an account from the local vault', hint: '<username> --confirm' },
              { name: 'totp',    description: 'Print the current TOTP code', hint: '<username>' },
              { name: 'login',   description: 'Validate cookies and cache the session', hint: '<username>' },
              { name: 'session', description: 'Check cached session status', hint: '<username>' },
              { name: 'push',    description: "Stash this machine's session under a one-time code (~30 min) so another machine can take it over — TikTok only authorizes a login on a trusted browser/IP, so `connect` on your laptop and move the session to where the ops run", hint: '<username>' },
              { name: 'pull',    description: 'Redeem a `push` code on this machine and save the session into its vault', hint: '<username> --code <transfer-code>' },
              { name: 'post',    description: 'Post a video', hint: '<username> --file video.mp4 --caption "..."' },
              { name: 'schedule', description: "Schedule a video via TikTok's own scheduler (~15 min to ~10 days out) — fires even if your machine and our server are off.", hint: '<username> --at 2026-06-03T18:00Z --file v.mp4 --caption "..."' },
              { name: 'scheduled', description: "What you have queued — Palmyr's own record, because TikTok can't be asked what's pending; --all includes cancelled and already-published ones", hint: '[<account>] [--all]' },
              { name: 'cancel',  description: 'Cancel a scheduled post by deleting the held video (TikTok has no unschedule)', hint: '<operation-id> --account <username>' },
              { name: 'follow',  description: 'Follow a TikTok user', hint: '<username> --user @handle' },
              { name: 'like',    description: 'Like a video', hint: '<username> --video https://...' },
              { name: 'delete',  description: 'Delete a video', hint: '<username> --video https://...' },
              { name: 'bio',     description: 'Update bio (<=80 chars)', hint: '<username> --text "..."' },
              { name: 'name',    description: 'Update display name (<=30 chars)', hint: '<username> --display "..."' },
              { name: 'pfp',     description: 'Update avatar', hint: '<username> --file pic.png' },
              { name: 'draft',   description: 'Stage a post for human approval instead of publishing — queues it locally (free).', hint: '<username> --file v.mp4 --caption "..." [--at <iso>]' },
              { name: 'drafts',  description: 'List drafts awaiting approval', hint: '[<username>] [--tag <folder>]' },
              { name: 'approve', description: 'Publish a queued draft + record it in the post log', hint: '<draft-id>' },
              { name: 'reject',  description: 'Discard a queued draft', hint: '<draft-id>' },
              { name: 'logs',    description: 'Audit log of posts that went out (approved drafts + direct posts)', hint: '[<username>] [--tag <folder>] [--limit N]' },
              { name: 'analytics', description: 'Scrape per-post views/likes/comments, categorize into tiers vs the account’s own posts, and snapshot the time-series', hint: '<username>' },
              { name: 'review',  description: 'Performance review: best/worst posts, tier mix, engagement, and trend vs the last snapshot — the self-learning surface', hint: '<username>' },
              { name: 'series',  description: 'Server-stored per-post engagement history: full time-series for a video, or per-video growth over a window', hint: '<username> [--video <id>] [--hours 24]' },
              { name: 'hooks',   description: "Which caption openings earn views, measured against the account's own median ($0.001). --tag pools a niche across your accounts; --caption classifies a draft before posting; --niche answers from what is working in that niche across TikTok, so it works with no history at all ($0.05)", hint: '<username> | --tag <folder> | --niche <niche> [--caption "..."]' },
              { name: 'corpus',  description: 'Operator pre-warm for `hooks --niche`: `niches` lists them, `refresh <niche>` collects that niche from TikTok now and uploads it (admin-signed, spends from your own wallet)', hint: 'niches | refresh <niche> [--depth 4]' },
              { name: 'monitor', description: 'Unattended loop that periodically runs analytics so review stays fresh (mirrors the wallet daemon)', hint: 'tick | start --every 6h | stop | status' },
            ],
            fromHome,
          })
          return
        }
        if (flags.help && subcommand && TIKTOK_HELP[subcommand]) {
          subcommandHelp('tiktok', subcommand, TIKTOK_HELP[subcommand])
          return
        }

        switch (subcommand) {
          case 'import': {
            // Two formats:
            //   --credentials-line "login:password:email:email_password"  (from AccsMarket etc.)
            //   OR explicit flags --login / --password / --email / --sessionid / --csrf / --webid
            const line = flags['credentials-line'] as string
            let login: string | undefined
            let password: string | undefined
            let email: string | undefined
            let emailPassword: string | undefined
            let username = (flags.username as string) || positional[0]

            if (line) {
              const parts = line.split(':')
              if (parts.length < 4) err(`--credentials-line must have at least 4 colon-separated fields, got ${parts.length}`)
              login = parts[0]
              password = parts[1]
              email = parts[2]
              emailPassword = parts[3]
              if (!username) username = login
            } else {
              login = flags.login as string
              password = flags.password as string
              email = flags.email as string
              emailPassword = (flags['email-password'] as string) || (flags.emailpw as string)
            }

            const sessionid = flags.sessionid as string
            const csrf = (flags.csrf as string) || (flags['tt-csrf'] as string)
            const webid = (flags.webid as string) || (flags['tt-webid'] as string)
            const totpSeed = (flags['totp-seed'] as string) || (flags.totp as string)
            const profileUrl = flags['profile-url'] as string
            const country = (flags.country as string)?.toLowerCase()

            if (!username) err('<username> (or --username / --credentials-line) required')
            if (!password && !sessionid) {
              err('Provide either --sessionid <hex> for cookie-injection, or --password (via --credentials-line or --password flag) for password login.')
            }
            if (!country) {
              err('--country <iso-2> required (e.g. --country de). Drives proxy exit + browser locale; without it TikTok flags geography mismatch.')
            }

            // Pre-flight: check whether the email provider will actually work
            // with our (password-based) IMAP reader. Blocks unsupported
            // providers up front so you don't pay for marketplace accounts
            // that can't be automated.
            if (email && !sessionid && !flags['force-email']) {
              const emailDomain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
              const microsoftDomains = /^(hotmail|outlook|live|msn)\.com$/
              const gmailDomains = /^(gmail|googlemail)\.com$/
              const yahooDomains = /^(yahoo|ymail)\./
              const protonDomains = /^(proton|protonmail)\./

              if (microsoftDomains.test(emailDomain)) {
                err(
                  `This account's email is ${emailDomain}. Microsoft disabled password IMAP for consumer accounts in late 2022, and our OAuth2 integration isn't wired yet.\n\n` +
                  `  Recommendation: buy a TikTok account with a rambler.ru, mail.ru, or yandex.ru email — those work out of the box.\n` +
                  `  Override (not recommended): --force-email`,
                  EXIT.BAD_INPUT,
                )
              }
              if (gmailDomains.test(emailDomain)) {
                const looksLikeAppPassword = typeof emailPassword === 'string' && /^[a-z]{16}$/.test(emailPassword)
                if (!looksLikeAppPassword) {
                  err(
                    `This account's email is ${emailDomain}. Gmail needs a 16-char app-password (lowercase letters) for IMAP, not the regular account password.\n\n` +
                    `  Your email_password looks like a regular password. It will fail at IMAP auth.\n` +
                    `  Recommendation: buy accounts with rambler.ru or mail.ru email instead.\n` +
                    `  Override: --force-email`,
                    EXIT.BAD_INPUT,
                  )
                }
              }
              if (yahooDomains.test(emailDomain)) {
                err(
                  `This account's email is ${emailDomain}. Yahoo needs an app-password for IMAP and marketplace accounts rarely ship with one.\n\n` +
                  `  Recommendation: buy accounts with rambler.ru or mail.ru email instead.\n` +
                  `  Override: --force-email`,
                  EXIT.BAD_INPUT,
                )
              }
              if (protonDomains.test(emailDomain)) {
                err(
                  `This account's email is ${emailDomain}. ProtonMail IMAP requires a local Bridge app — not usable server-side.\n\n` +
                  `  Recommendation: buy accounts with rambler.ru or mail.ru email instead.`,
                  EXIT.BAD_INPUT,
                )
              }
            }

            const creds: import('./social-vault.js').SocialCredentials = {
              login: login || username,
              password: password || 'unknown',
              email: email || login,
              email_password: emailPassword,
              totp_seed: totpSeed,
              profile_url: profileUrl,
              tiktok_sessionid: sessionid,
              tiktok_csrf: csrf,
              tiktok_webid: webid,
            }
            const summary = sv.importAccount(platform, username, creds, {
              source: line ? 'marketplace-line' : 'import',
              country,
              tag: flags.tag as string | undefined,
            })
            const loginPath = sessionid ? 'cookie-injection' : 'form-login (requires CAPSOLVER_API_KEY server-side)'
            log(`tiktok import: ${summary.username} (${summary.id}) [login: ${loginPath}, country: ${country}]`)
            return print({ ...summary, has_sessionid: !!sessionid, has_password: !!password, login_path: loginPath })
          }

          case 'list': {
            // --server lists what the SERVER knows this wallet owns. The local
            // vault only ever knew about locally-connected accounts, so an
            // account logged in with `connect --server` was invisible to it.
            if (flags.server) {
              const data = await ao.tiktokAccounts(flags.tag as string | undefined)
              if (AGENT_MODE) return print(data)
              const rows = data.accounts || []
              console.log(`
  ${t.accent}server-side tiktok accounts${t.reset} — ${t.muted}${data.owner}${t.reset}
`)
              if (rows.length === 0) {
                console.log(`  ${t.muted}None yet. Connect one: palmyr tiktok connect <handle> --server${t.reset}
`)
                return
              }
              for (const a of rows) {
                const live = a.profile_present ? '' : `  ${t.error}(profile missing on host)${t.reset}`
                const seen = a.hours_since_success == null ? 'never' : `${a.hours_since_success}h ago`
                console.log(`  ${a.account_id.padEnd(24)} ${String(a.status).padEnd(11)} ${String(a.country || '-').padEnd(4)} last ok: ${seen}${live}`)
              }
              console.log(`
  ${t.muted}${rows.length} account(s)${t.reset}
`)
              return
            }
            const tagFilter = flags.tag as string | undefined
            const accounts = sv.listAccounts(platform, tagFilter)
            return print({ accounts, count: accounts.length, ...(tagFilter ? { tag: tagFilter } : {}) })
          }

          case 'info': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally`, EXIT.NOT_FOUND)
            return print(acc!)
          }

          case 'rename': {
            const oldUsername = positional[0] || (flags.username as string)
            const newUsername = flags.to as string
            if (!oldUsername) err('<old-username> required')
            if (!newUsername) err('--to <new-username> required')
            const summary = sv.renameAccount(platform, oldUsername, newUsername)
            log(`tiktok rename: ${oldUsername} → ${newUsername}`)
            return print(summary)
          }

          case 'tag': {
            // Folder-like grouping so one agent can organize 30+ accounts.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const clear = !!flags.clear
            const newTag = clear ? null : (positional[1] || (flags.tag as string))
            if (!clear && !newTag) err('provide a tag (e.g. `palmyr tiktok tag <username> brand-x`) or --clear')
            const summary = sv.tagAccount(platform, username, newTag)
            log(clear ? `tiktok tag: cleared on ${username}` : `tiktok tag: ${username} → ${newTag}`)
            return print(summary)
          }

          case 'remove': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            if (!flags.confirm) {
              err(
                `This deletes the local copy of "${username}". The TikTok account itself is NOT deleted.\n\n` +
                `  Re-run with --confirm to proceed:\n` +
                `  palmyr tiktok remove ${username} --confirm`
              )
            }
            sv.removeAccount(platform, username)
            log(`tiktok remove: ${username}`)
            return print({ success: true, platform, username })
          }

          case 'totp': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const creds = sv.unlockCredentials(platform, username)
            if (!creds.totp_seed) err(`tiktok account "${username}" has no TOTP seed configured`, EXIT.NOT_FOUND)
            const { code, secondsUntilNextCode } = await import('./totp.js')
            return print({
              platform,
              username,
              code: code(creds.totp_seed!),
              expires_in_seconds: secondsUntilNextCode(),
            })
          }

          case 'connect': {
            // Real-browser login. Launches the operator's own Chrome/Edge,
            // they sign in (solving any captcha/2FA themselves), and we harvest
            // the session via CDP — no headless form-driving, no captcha solver.
            // Agent-smooth: auto-provisions the account, auto-detects login
            // (no keystroke), and always terminates with structured JSON.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')

            // --server logs in ON THE SERVER, inside the account's own
            // persistent profile, so the browser that authenticates is the one
            // that will act. The local path below mints the session on THIS
            // machine at your home IP while every later operation replays it
            // from a server browser behind a residential proxy — a mismatch
            // baked in at login that nothing afterwards can repair.
            if (flags.server) {
              const started = await ao.tiktokConnectServer(username, {
                country: (flags.country as string)?.toLowerCase(),
              })
              if (!AGENT_MODE) {
                console.log(`\n  ${t.accent}Send this to your human to scan:${t.reset}\n  ${t.info}${started.connect_url}${t.reset}\n`)
                console.log(`  ${t.muted}They open it and scan the QR with the TikTok app.`)
                console.log(`  The session lands in this account's own browser profile on the server.${t.reset}\n`)
              }
              // Poll until the human scans or the login window closes.
              const deadline = Date.now() + 11 * 60_000
              let last = ''
              while (Date.now() < deadline) {
                const s = await ao.tiktokConnectStatus(started.token).catch(() => null)
                if (s && s.state !== last) {
                  last = s.state
                  if (AGENT_MODE) print({ event: 'connect', state: s.state, connect_url: started.connect_url })
                  else console.log(`  ${t.muted}${s.state}${t.reset}`)
                }
                if (s && s.done) {
                  if (s.state === 'completed') {
                    return print({ success: true, platform, username, connected: true, mode: 'server',
                      message: "Logged in. The session lives in this account's server-side profile — no cookies were transferred." })
                  }
                  err(`server connect failed: ${s.error || 'unknown'}`, EXIT.GENERAL)
                }
                await new Promise(r => setTimeout(r, 4000))
              }
              err('server connect timed out waiting for the scan', EXIT.GENERAL)
            }
            // --country is optional: if omitted we infer it from the real
            // browser during login (locale/timezone). Explicit flag overrides.
            const explicitCountry = (flags.country as string)?.toLowerCase()

            let acc = sv.getAccount(platform, username)

            // Idempotent: an existing account with a fresh cached session returns
            // fast, no browser. (New accounts have no session yet.) Lets an agent
            // call `connect` defensively before a run.
            if (acc && !flags.force) {
              const existing = sv.loadSession(acc.id)
              if (existing && existing.cookies?.length) {
                const ageH = sv.sessionAgeHours(acc.id) ?? 999
                if (ageH < 12) {
                  return print({
                    success: true, platform, username, connected: true, already: true,
                    cookies: existing.cookies.length,
                    age_hours: Number(ageH.toFixed(2)),
                    captured_at: existing.captured_at,
                    hint: 'Session is fresh. Pass --force to re-capture.',
                  })
                }
              }
            }

            // DEFAULT is QR: a zero-install link the human opens and scans with the
            // TikTok app on their phone (where the account already lives) — not
            // sus, never blocked. --local opens the browser on THIS machine instead
            // (a desktop with a human present). Both auto-capture the session.
            const localMode = !!flags.local
            const qrMode = !localMode // default
            const timeoutSec = flags.timeout !== undefined ? Math.max(30, Number(flags.timeout)) : (qrMode ? 600 : 300)
            const apiBase = ao.api.replace(/\/+$/, '')
            const { connectTikTok } = await import('./tiktok-connect.js')
            let hostedLink: string | undefined
            let qrToken: string | undefined   // public READ token — only ever put in the forwarded link
            let qrWriter: string | undefined  // private WRITER credential — never in the link

            if (qrMode) {
              // Create the QR hand-off session UP FRONT so the agent forwards a
              // clean, durable link immediately; connect keeps the QR fresh as
              // TikTok rotates it.
              try {
                const sess = await ao.socialTiktokHostQr()
                qrToken = sess.token
                // The server returns a separate high-entropy writer credential
                // that is NOT part of the /connect link — keep it here and
                // present it on every QR refresh. Only the read token goes in the
                // link we forward, so a leaked link can't swap the QR. (Fall back
                // to the read token for older servers that predate the split.)
                qrWriter = (sess as any).writer || sess.token
                hostedLink = `${apiBase}/connect/${qrToken}`
                const mins = Math.round((sess.expires_in_sec || 900) / 60)
                process.stderr.write(`[connect] 🔗 Send this link to your human to scan: ${hostedLink}\n`)
                process.stderr.write(`[connect] They open it and scan the QR with the TikTok app. The link stays valid ~${mins} min; capturing the moment they confirm…\n`)
              } catch { /* hosting optional; falls back to the local window */ }
            }
            const result = await connectTikTok({
              country: explicitCountry || acc?.country,
              timeoutMs: timeoutSec * 1000,
              browserPath: flags['browser-path'] as string | undefined,
              noSandbox: !!flags['no-sandbox'],
              qr: qrMode,
              onQr: qrWriter
                ? async (dataUrl) => { try { await ao.socialTiktokHostQr(dataUrl, qrWriter) } catch { /* keep waiting */ } }
                : undefined,
              onProgress: (m) => process.stderr.write(`[connect] ${m}\n`),
            })
            // Tell the hand-off page the login landed, so it shows confirmation.
            if (result.success && qrWriter) { try { await ao.socialTiktokHostQr(undefined, qrWriter, true) } catch { /* cosmetic */ } }

            if (!result.success) {
              const details: Record<string, unknown> = { platform, username, reason: result.reason }
              if (result.qrPngPath) details.qr_png_path = result.qrPngPath
              if (hostedLink) details[qrMode ? 'qr_link' : 'login_link'] = hostedLink
              if (result.reason === 'no_local_browser') {
                details.remedy =
                  `No Chrome/Edge/Brave found. Install one, pass --browser-path <path>, or import cookies manually: ` +
                  `open tiktok.com (logged in) → DevTools → Application → Cookies → .tiktok.com, then ` +
                  `palmyr tiktok import ${username} --country us --sessionid <sessionid> --csrf <tt_csrf_token> --webid <tt_webid_v2>`
              }
              err(`connect failed: ${result.error || result.reason}`, EXIT.GENERAL, details)
            }

            // Country precedence: existing account keeps its stored value;
            // otherwise explicit flag > detected-from-browser > env default > us.
            // Agents never have to know or pass it.
            const resolvedCountry =
              acc?.country ||
              explicitCountry ||
              result.detectedCountry ||
              process.env.PALMYR_DEFAULT_COUNTRY?.toLowerCase() ||
              'us'
            const countrySource = acc?.country
              ? 'account'
              : explicitCountry
                ? 'flag'
                : result.detectedCountry
                  ? 'detected'
                  : 'default'

            // Auto-create the account now that the country is known (one command,
            // not import-then-connect).
            if (!acc) {
              acc = sv.importAccount(platform, username, { login: username, password: 'unknown' }, { source: 'connect', country: resolvedCountry, tag: flags.tag as string | undefined })
              process.stderr.write(`[connect] created local account ${username} (${acc.id}) [country: ${resolvedCountry}, ${countrySource}]\n`)
            } else if (flags.tag) {
              // Re-connecting an existing account with --tag (re)assigns the folder.
              sv.tagAccount(platform, username, flags.tag as string)
            }

            // Persist into the same encrypted session cache that post/follow/like read.
            sv.saveSession(acc.id, platform, result.cookies || [])
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })

            return print({
              success: true, platform, username, connected: true,
              browser: result.browser,
              country: resolvedCountry,
              country_source: countrySource,
              cookies_captured: result.cookiesCaptured,
              sessionid_present: true,
              ...(flags.tag ? { tag: flags.tag as string } : {}),
              ...(result.qrPngPath ? { qr_png_path: result.qrPngPath } : {}),
              ...(hostedLink ? (qrMode ? { qr_link: hostedLink } : { login_link: hostedLink }) : {}),
              next: `palmyr tiktok post ${username} --file video.mp4 --caption "..."`,
            })
          }

          case 'login': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally`, EXIT.NOT_FOUND)

            const creds = sv.unlockCredentials(platform, username)
            const hasCookies = !!creds.tiktok_sessionid
            const hasPassword = !!(creds.login && creds.password && creds.password !== 'unknown')
            if (!hasCookies && !hasPassword) {
              err('Account has no cookies and no password. Re-import with either --sessionid or --credentials-line.', EXIT.BAD_INPUT)
            }
            const psid = sv.getProxySessionId(platform, username)
            const country = sv.getCountry(platform, username)

            let data: any
            try {
              data = await ao.socialTiktokLogin(acc!.id, {
                sessionid: creds.tiktok_sessionid,
                ttCsrfToken: creds.tiktok_csrf,
                ttWebidV2: creds.tiktok_webid,
                login: hasCookies ? undefined : creds.login,
                password: hasCookies ? undefined : creds.password,
                // Email creds enable server-side auto-solve of TikTok's
                // "Verify it's really you" device-verification challenge.
                email: creds.email,
                emailPassword: creds.email_password,
                proxySessionId: psid,
                country,
              })
            } catch (e: any) {
              err(`Login failed: ${e.message}`, EXIT.GENERAL)
            }

            if (!data?.success) {
              err(
                `Login failed: ${data?.error || 'unknown error'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }

            sv.saveSession(acc!.id, platform, data.cookies || [])
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })

            return print({
              success: true,
              platform,
              username,
              observed_username: data.observed_username,
              cookies_captured: (data.cookies || []).length,
              captured_at: data.captured_at,
            })
          }

          case 'push': {
            // Stash THIS machine's session for transfer to another (e.g. the
            // Studio VPS). TikTok only authorizes a login on a trusted browser/IP
            // (your laptop), so `connect` there, then `push` → `pull` moves the
            // harvested session to where the ops run.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally. Connect it here first: palmyr tiktok connect ${username}`, EXIT.NOT_FOUND)
            const sess = sv.loadSession(acc!.id)
            if (!sess || !sess.cookies || sess.cookies.length === 0) {
              err(`No cached session for ${username}. Connect it here first: palmyr tiktok connect ${username}`, EXIT.NOT_FOUND)
            }
            let data: any
            try {
              data = await ao.socialTiktokSessionStash(sess!.cookies, username)
            } catch (e: any) {
              err(`push failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.transfer_code) err('push failed: no transfer code returned', EXIT.GENERAL)
            const country = sv.getCountry(platform, username)
            const pullCmd = `palmyr tiktok pull ${username} --code ${data.transfer_code}${country ? ` --country ${country}` : ''}`
            process.stderr.write(`[push] Session stashed (one-time, ~30 min). On the target machine (e.g. the Studio VPS) run:\n[push]   ${pullCmd}\n`)
            return print({
              success: true, platform, username, op: 'push',
              transfer_code: data.transfer_code,
              expires_in_sec: data.expires_in_sec,
              pull_command: pullCmd,
            })
          }

          case 'pull': {
            // Redeem a transfer code from `push` on another machine → save the
            // session into THIS machine's vault so its ops can use it.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const code = (flags.code as string) || (flags.transfer as string)
            if (!code) err('--code <transfer-code> required (from `tiktok push` on the source machine)')
            let data: any
            try {
              data = await ao.socialTiktokSessionClaim(code)
            } catch (e: any) {
              err(`pull failed: ${e.message}`, EXIT.GENERAL)
            }
            if (!data?.ok || !data.cookies?.length) err('pull failed: transfer code not found or expired (codes are one-time and ~30 min)', EXIT.GENERAL)
            const country = (flags.country as string)?.toLowerCase() || undefined
            let acc = sv.getAccount(platform, username)
            if (!acc) {
              acc = sv.importAccount(platform, username, { login: username, password: 'unknown' }, { source: 'pull', country, tag: flags.tag as string | undefined })
            } else if (flags.tag) {
              sv.tagAccount(platform, username, flags.tag as string)
            }
            sv.saveSession(acc!.id, platform, data.cookies)
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
            return print({
              success: true, platform, username, op: 'pull',
              cookies: data.cookies.length,
              ...(flags.tag ? { tag: flags.tag as string } : {}),
              next: `palmyr tiktok post ${username} --file video.mp4 --caption "..."`,
            })
          }

          case 'session': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally`, EXIT.NOT_FOUND)
            const sess = sv.loadSession(acc!.id)
            if (!sess) {
              return print({
                platform,
                username,
                cached: false,
                hint: `No cached session. Run: palmyr tiktok login ${username}`,
              })
            }
            const ageHours = sv.sessionAgeHours(acc.id)
            return print({
              platform,
              username,
              cached: true,
              cookies: sess.cookies.length,
              captured_at: sess.captured_at,
              age_hours: Number((ageHours || 0).toFixed(2)),
              stale: (ageHours || 0) > 12,
            })
          }

          case 'draft': {
            // Stage a post for human approval — does NOT publish. Free, local.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            if (!acc) err(`tiktok account "${username}" not found locally`, EXIT.NOT_FOUND)
            const caption = (flags.caption as string) || (flags.body as string) || (flags.text as string)
            if (!caption) err('--caption "..." required')
            const filePath = (flags.file as string) || (flags.path as string)
            const videoUrl = flags.url as string
            if (!filePath && !videoUrl) err('--file <local-path> or --url <https-url> required')
            if (filePath) {
              const { existsSync, statSync } = await import('fs')
              if (!existsSync(filePath)) err(`File not found: ${filePath}`, EXIT.NOT_FOUND)
              if (statSync(filePath).size > 100 * 1024 * 1024) err('Video too large (max 100 MB)', EXIT.BAD_INPUT)
            }
            const privacy = flags.privacy !== undefined ? Number(flags.privacy) as 0 | 1 | 2 : undefined
            let schedule_at: string | undefined
            const at = (flags.at as string) || (flags.when as string)
            if (at) {
              const when = new Date(at)
              if (isNaN(when.getTime())) err('--at must be a valid ISO-8601 datetime', EXIT.BAD_INPUT)
              const ms = when.getTime() - Date.now()
              if (ms < 15 * 60 * 1000) err('--at must be at least ~15 minutes in the future', EXIT.BAD_INPUT)
              if (ms > 10 * 24 * 60 * 60 * 1000) err('--at must be within ~10 days', EXIT.BAD_INPUT)
              schedule_at = when.toISOString()
            }
            const absFile = filePath ? (await import('path')).resolve(filePath) : undefined
            const draft = sd.createDraft({
              platform, account: username, caption, file: absFile, url: videoUrl,
              privacy, tag: (flags.tag as string) || acc.tag, schedule_at,
            })
            log(`tiktok draft ${draft.id} staged for ${username} (awaiting approval)`)
            return print({
              draft_id: draft.id, status: draft.status, account: username, caption,
              ...(draft.tag ? { tag: draft.tag } : {}), ...(schedule_at ? { schedule_at } : {}),
              next: `palmyr tiktok approve ${draft.id}`,
            })
          }

          case 'drafts': {
            const drafts = sd.listDrafts({ platform, account: positional[0] || (flags.account as string), tag: flags.tag as string })
            return print({
              drafts: drafts.map(d => ({ id: d.id, account: d.account, caption: d.caption, privacy: d.privacy, tag: d.tag, schedule_at: d.schedule_at, created_at: d.created_at })),
              count: drafts.length,
            })
          }

          case 'reject': {
            const id = positional[0] || (flags.id as string)
            if (!id) err('<draft-id> required')
            if (!sd.deleteDraft(id)) err(`draft "${id}" not found`, EXIT.NOT_FOUND)
            log(`tiktok reject ${id}`)
            return print({ rejected: true, draft_id: id })
          }

          case 'logs': {
            const entries = sd.readPostLog({
              platform, account: positional[0] || (flags.account as string),
              tag: flags.tag as string, limit: flags.limit ? Number(flags.limit) : 20,
            })
            return print({ posts: entries, count: entries.length })
          }

          case 'approve': {
            // Publish a queued draft from the human-in-the-loop flow + log it.
            const id = positional[0] || (flags.id as string)
            if (!id) err('<draft-id> required')
            const draft = sd.getDraft(id)
            if (!draft) err(`draft "${id}" not found`, EXIT.NOT_FOUND)
            // An account logged in with `connect --server` has no local record
            // and no cookie jar — its session lives in its own browser profile
            // on the server. The write ops learned this; approve had not, so a
            // server-side account could never publish a draft at all.
            const acc = sv.getAccount(platform, draft!.account)
            const sess = acc ? sv.loadSession(acc.id) : undefined
            const serverSide = !acc || !sess || !sess.cookies || sess.cookies.length === 0
            if (acc && serverSide) {
              err(
                `No cached session for ${draft!.account}. Run 'palmyr tiktok connect ${draft!.account} --server' (recommended) ` +
                `or 'tiktok connect ${draft!.account}'.`,
                EXIT.NOT_FOUND,
              )
            }
            const acctId = acc ? acc.id : draft!.account
            const jar: any[] = serverSide ? [] : sess!.cookies
            const psid = acc ? sv.getProxySessionId(platform, draft!.account) : undefined
            const country = (flags.country as string)?.toLowerCase() || (acc ? sv.getCountry(platform, draft!.account) : undefined)
            const media: { video_base64?: string; video_url?: string } = {}
            if (draft!.file) {
              const { readFileSync, existsSync, statSync } = await import('fs')
              if (!existsSync(draft!.file)) err(`Draft video no longer exists at ${draft!.file}`, EXIT.NOT_FOUND)
              if (statSync(draft!.file).size > 100 * 1024 * 1024) err('Video too large (max 100 MB)', EXIT.BAD_INPUT)
              media.video_base64 = `data:video/mp4;base64,${readFileSync(draft!.file).toString('base64')}`
            } else {
              media.video_url = draft!.url
            }
            let data: any
            try {
              data = await ao.socialTiktokPost(acctId, jar, draft!.caption, media, { privacy: draft!.privacy, schedule_at: draft!.schedule_at }, psid, country)
            } catch (e: any) {
              err(`approve failed: ${e.message}`, EXIT.GENERAL)
            }

            // Posting is async server-side: a 202 carries an operation_id and
            // no `success` field. Testing `data.success` on that envelope
            // reported failure on EVERY approve — after the charge — while the
            // video published anyway, and kept the draft so a retry would post
            // it a second time. Poll for the real outcome instead.
            let result: any = data?.data
            if (data?.operation_id) {
              const final = await pollTikTokOperation(ao, data.operation_id, {
                label: 'approve',
                pollAfterSeconds: Number(data.poll_after_seconds),
                agentMode: AGENT_MODE,
              })
              if (!final) {
                // Still running. The draft stays — but say plainly that it may
                // yet publish, so nobody re-approves it into a duplicate post.
                return print({
                  approved: false, draft_id: id, account: draft!.account,
                  operation_id: data.operation_id, status: 'running', done: false,
                  poll_url: data.poll_url || `/social/tiktok/operations/${data.operation_id}`,
                  message: 'Still running server-side. The draft was kept, but do NOT re-approve until you have checked the poll_url — it may still publish.',
                })
              }
              if (final.status === 'failed') {
                // A real failure: keep the draft so it can be retried once the
                // cause is fixed (e.g. after re-connecting a stale session).
                err(
                  `approve failed: ${final.error || 'unknown'}${final.error_code ? ` [${final.error_code}]` : ''}` +
                  ` (refund: ${final.refund_status || 'unknown'}) — draft ${id} kept for retry`,
                  EXIT.GENERAL,
                )
              }
              result = { ...(final.result || {}), ...(final.video_url ? { video_url: final.video_url, video_id: final.video_id } : {}), ...(final.scheduled_at ? { scheduled_at: final.scheduled_at } : {}) }
            } else if (!data?.success) {
              // Legacy synchronous server — back-compat.
              err(`approve failed: ${data?.error || 'unknown'}${data?.error_code ? ` [${data.error_code}]` : ''}`, EXIT.GENERAL)
            }

            // A server-side account has no local record to stamp; the post
            // already succeeded, so a bookkeeping miss must not be reported as
            // a failure.
            if (acc) sv.updateMeta(platform, draft!.account, { last_action_at: new Date().toISOString() })
            const entry = sd.appendPostLog({ platform, account: draft!.account, caption: draft!.caption, source: 'draft', status: draft!.schedule_at ? 'scheduled' : 'posted', url: result?.video_url, tag: draft!.tag, draft_id: id, result })
            sd.deleteDraft(id)
            log(`tiktok approve ${id} → ${entry.status} for ${draft!.account}`)
            return print({ approved: true, draft_id: id, account: draft!.account, status: entry.status, ...(result || {}) })
          }

          case 'analytics': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            // Same rule as the write ops: an account logged in with
            // `connect --server` has no local record and no jar, and the server
            // authorises it on its own browser profile instead.
            const acc = sv.getAccount(platform, username)
            const sess = acc ? sv.loadSession(acc.id) : undefined
            const serverSide = !acc || !sess || !sess.cookies || sess.cookies.length === 0
            if (acc && serverSide) {
              err(
                `No cached session for ${username}. Run 'palmyr tiktok connect ${username} --server' (recommended) ` +
                `or 'tiktok connect ${username}'.`,
                EXIT.NOT_FOUND,
              )
            }
            const psid = acc ? sv.getProxySessionId(platform, username) : undefined
            const country = (flags.country as string)?.toLowerCase() || (acc ? sv.getCountry(platform, username) : undefined)
            const acctId = acc ? acc.id : username!
            const jar: any[] = serverSide ? [] : sess!.cookies
            let data: any
            try {
              data = await ao.socialTiktokAnalytics(acctId, jar, psid, country)
            } catch (e: any) {
              err(`analytics failed: ${e.message}`, EXIT.GENERAL)
            }

            // Analytics became async server-side once it started scrolling the
            // whole post list — that runs past the edge proxy's timeout on any
            // account with real history. Poll to a terminal state. A server
            // still answering synchronously (no operation_id) falls through to
            // the old shape, so an older deployment keeps working.
            if (data?.operation_id) {
              const opId = data.operation_id
              const final = await pollTikTokOperation(ao, opId, {
                label: 'analytics',
                pollAfterSeconds: Number(data.poll_after_seconds),
                agentMode: AGENT_MODE,
              })
              if (!final) {
                return print({ operation_id: opId, status: 'running', done: false, poll_url: data.poll_url || `/social/tiktok/operations/${opId}`, message: 'Still running server-side — re-check with the poll_url.' })
              }
              if (final.status === 'failed') {
                err(`analytics failed: ${final.error || 'unknown'}${final.error_code ? ` [${final.error_code}]` : ''} (refund: ${final.refund_status || 'unknown'})`, EXIT.GENERAL)
              }
              // Normalise onto the sync shape the rest of this branch expects.
              data = { success: true, data: final.result || {} }
            }

            if (!data?.success) {
              err(`analytics failed: ${data?.error || 'unknown'}${data?.error_code ? ` [${data.error_code}]` : ''}`, EXIT.GENERAL)
            }
            // Categorize (relative tiers) + snapshot to the local time-series so
            // `review` can show trends. `tiktok monitor` calls this same op.
            const snap = sa.appendSnapshot(username, data?.data?.posts || [])
            return print({
              platform,
              username,
              scraped_at: data?.data?.scraped_at,
              // How the server's own history moved. `unchanged` is why a run
              // can record nothing and still be a healthy read — the numbers
              // simply had not moved since the last sample.
              ...(data?.data?.recorded !== undefined ? { recorded: data.data.recorded, unchanged: data.data.unchanged } : {}),
              ...(data?.data?.truncated ? { truncated: true } : {}),
              summary: snap.summary,
              posts: snap.posts,
            })
          }

          case 'review': {
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            return print(sa.review(username))
          }

          case 'series': {
            // The SERVER's history, not the local JSONL — it survives the
            // machine that collected it, and an agent that never runs this CLI
            // still accumulates one by calling analytics.
            const username = positional[0] || (flags.username as string)
            if (!username) err('<username> required')
            const acc = sv.getAccount(platform, username)
            const acctId = acc ? acc.id : username!
            const hours = flags.hours !== undefined ? Number(flags.hours) : undefined
            if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) err('--hours must be a positive number', EXIT.BAD_INPUT)
            let data: any
            try {
              data = await ao.socialTiktokSeries(acctId, { videoId: flags.video as string | undefined, hours })
            } catch (e: any) {
              err(`series failed: ${e.message}`, EXIT.GENERAL)
            }
            if (AGENT_MODE) return print(data)

            if (data?.samples) {
              console.log(`\n  ${t.accent}${username}${t.reset} — ${t.muted}video ${data.video_id}${t.reset}\n`)
              if (!data.samples.length) { console.log(`  ${t.muted}No samples yet. Run: palmyr tiktok analytics ${username}${t.reset}\n`); return }
              for (const s of data.samples) {
                console.log(`  ${String(s.sampled_at).replace('T', ' ').slice(0, 16)}  views ${String(s.views ?? '-').padStart(8)}  likes ${String(s.likes ?? '-').padStart(7)}  comments ${String(s.comments ?? '-').padStart(6)}`)
              }
              console.log(`\n  ${t.muted}${data.count} sample(s)${t.reset}\n`)
              return
            }

            const rows = data?.videos || []
            const header = data?.window_hours ? `growth over ${data.window_hours}h` : 'latest sample per video'
            console.log(`\n  ${t.accent}${username}${t.reset} — ${t.muted}${header}${t.reset}\n`)
            if (!rows.length) { console.log(`  ${t.muted}No history yet. Run: palmyr tiktok analytics ${username}${t.reset}\n`); return }
            for (const v of rows) {
              const when = v.posted_at ? String(v.posted_at).slice(0, 10) : '-'
              const cap = String(v.caption || '').replace(/\s+/g, ' ').slice(0, 38).padEnd(38)
              // "not measured twice yet" must not print as a gain of zero.
              const gain = v.comparable === false ? `${t.muted}(1 sample)${t.reset}` : v.views_gained != null ? `+${v.views_gained}` : ''
              console.log(`  ${when}  ${cap} ${String(v.views ?? '-').padStart(8)} views  ${gain}`)
            }
            console.log(`\n  ${t.muted}${rows.length} video(s)${t.reset}\n`)
            return
          }

          case 'hooks': {
            // Which openings earn views, measured against the account's OWN
            // median. `--tag` pools a niche across the accounts you own; a
            // caption argument classifies a draft before you post it.
            const username = positional[0] || (flags.username as string)
            const tag = flags.tag as string | undefined
            const niche = flags.niche as string | undefined
            const caption = (flags.caption as string) || (flags.text as string)
            if (!username && !tag && !niche) err('<username>, --tag <folder>, or --niche <niche> required', EXIT.BAD_INPUT)
            const acc = username ? sv.getAccount(platform, username) : undefined
            const acctId = username ? (acc ? acc.id : username) : undefined

            let data: any
            try {
              // These were advertised in help but never sent — the flags did nothing.
              const maturityDays = flags['maturity-days'] !== undefined ? Number(flags['maturity-days']) : undefined
              const recencyDays = flags['recency-days'] !== undefined ? Number(flags['recency-days']) : undefined
              if (maturityDays !== undefined && !Number.isFinite(maturityDays)) err('--maturity-days must be a number', EXIT.BAD_INPUT)
              if (recencyDays !== undefined && (!Number.isFinite(recencyDays) || recencyDays <= 0)) err('--recency-days must be a positive number', EXIT.BAD_INPUT)
              data = await ao.socialTiktokHooks({ accountId: acctId, tag, niche, caption, maturityDays, recencyDays })
            } catch (e: any) {
              err(`hooks failed: ${e.message}`, EXIT.GENERAL)
            }
            if (AGENT_MODE) return print(data)

            // A corpus answer is about OTHER accounts, so it is rendered on its
            // own and never merged into the account view.
            if (niche) {
              console.log(`\n  ${t.accent}${data.niche_label || data.niche}${t.reset} — ${t.muted}observed in this niche, not your account${t.reset}`)
              if (data.resolved) console.log(`  ${t.muted}"${data.requested}" resolved to ${data.niche}${t.reset}`)
              const w = data.window || {}
              const fr = data.freshness || {}
              console.log(`  ${t.muted}${w.posts ?? 0} posts · median ${w.median_views ?? '—'} views · collected ${fr.age_days ?? '?'}d ago${t.reset}\n`)
              for (const p of data.patterns || []) {
                const lift = p.lift == null ? '—' : `${p.lift}x`
                const mark = p.confident ? '' : `  ${t.muted}(${p.posts} post(s) — thin)${t.reset}`
                console.log(`  ${String(p.label).padEnd(28)} ${lift.padStart(6)}  ${String(p.posts).padStart(3)} post(s)${mark}`)
                for (const ex of (p.examples || []).slice(0, 2)) {
                  const when = ex.posted_at ? String(ex.posted_at).slice(0, 10) : '?'
                  console.log(`      ${t.muted}${when}  ${String(ex.views).padStart(9)}  ${String(ex.hook).slice(0, 52)}${t.reset}`)
                }
              }
              console.log()
              for (const n of data.notes || []) console.log(`  ${t.muted}${n}${t.reset}`)
              console.log()
              return
            }

            const label = username || `#${tag}`

            // Draft check: what the caption IS, and what history says about it.
            if (caption) {
              console.log(`\n  ${t.accent}${label}${t.reset} — ${t.muted}draft hook${t.reset}\n`)
              console.log(`  ${t.accent}${data.hook || '(no readable hook)'}${t.reset}\n`)
              if (data.patterns?.length) {
                console.log(`  ${t.muted}patterns:${t.reset} ${data.patterns.map((p: any) => p.label).join(' · ')}\n`)
              }
              for (const e of data.evidence || []) {
                const lift = e.lift == null ? '—' : `${e.lift}x`
                const mark = e.confident ? '' : `  ${t.muted}(only ${e.posts} post(s) — indicative)${t.reset}`
                console.log(`  ${String(e.label).padEnd(28)} ${lift.padStart(6)} vs your median${mark}`)
              }
              for (const n of data.notes || []) console.log(`\n  ${t.muted}${n}${t.reset}`)
              console.log()
              return
            }

            console.log(`\n  ${t.accent}${label}${t.reset} — ${t.muted}hooks that earn views, vs this account's own median${t.reset}\n`)
            const b = data.baseline || {}
            console.log(`  ${t.muted}${b.mature_posts ?? 0} post(s) old enough to judge · median ${b.median_views ?? '—'} views${t.reset}\n`)

            if (data.patterns?.length) {
              for (const p of data.patterns) {
                const lift = p.lift == null ? '—' : `${p.lift}x`
                // An unconfident number must never read like a finding.
                const mark = p.confident ? '' : `  ${t.muted}(${p.posts} post(s) — not enough to trust)${t.reset}`
                console.log(`  ${String(p.label).padEnd(28)} ${lift.padStart(6)}  ${String(p.posts).padStart(3)} post(s)${mark}`)
              }
              console.log()
            }
            if (data.top_hooks?.length) {
              console.log(`  ${t.accent}best performing openings${t.reset}\n`)
              for (const h of data.top_hooks.slice(0, 5)) {
                console.log(`  ${String(h.views).padStart(8)}  ${String(h.hook || '').slice(0, 62)}`)
              }
              console.log()
            }
            for (const n of data.notes || []) console.log(`  ${t.muted}${n}${t.reset}`)
            console.log()
            return
          }

          case 'corpus': {
            // Operator pre-warm. The SERVER refreshes a niche by itself when an
            // agent asks for one that is stale or missing — this exists to fill
            // niches ahead of demand (so nobody ever hits a cold start), and to
            // collect at all on a deployment with no server payer wallet.
            const sub = positional[0] || 'status'
            const { NICHES, resolveNiche } = await import('./niches.js')

            if (sub === 'niches') {
              if (AGENT_MODE) return print({ niches: NICHES.map((n: any) => ({ niche: n.id, label: n.label, queries: n.queries })) })
              console.log(`\n  ${t.accent}niches${t.reset}\n`)
              for (const n of NICHES) console.log(`  ${String(n.id).padEnd(14)} ${n.label}`)
              console.log(`\n  ${t.muted}${NICHES.length} niches — pass any word, it resolves to the nearest${t.reset}\n`)
              return
            }

            if (sub === 'refresh') {
              const asked = positional[1] || (flags.niche as string)
              if (!asked) err('<niche> required — try: palmyr tiktok corpus niches', EXIT.BAD_INPUT)
              const res = resolveNiche(asked)
              if (!res) err(`Could not resolve "${asked}". Run: palmyr tiktok corpus niches`, EXIT.BAD_INPUT)
              const niche = res!.niche
              if (res!.resolved) log(`"${asked}" → ${niche.id}`)

              const depth = flags.depth !== undefined ? Number(flags.depth) : 4
              if (!Number.isFinite(depth) || depth < 1) err('--depth must be a positive number', EXIT.BAD_INPUT)
              const queries = niche.queries.slice(0, depth)

              const { paidRequest } = await import('./pay.js')
              const collections: { query: string; posts: any[] }[] = []
              let spent = 0
              for (const q of queries) {
                if (!AGENT_MODE) process.stderr.write(`  fetching "${q}"…\n`)
                try {
                  const r = await paidRequest(
                    'https://stablesocial.dev', 'POST', '/api/sc/tiktok/search/keyword',
                    { query: q }, undefined, 1, { maxUsdc: 0.25 },
                  )
                  const items = (r.data?.search_item_list || []).map((x: any) => x.aweme_info).filter(Boolean)
                  collections.push({ query: q, posts: items })
                  spent += 0.06
                  if (!AGENT_MODE) process.stderr.write(`    ${items.length} posts\n`)
                } catch (e: any) {
                  // One failed query should not discard the ones that worked.
                  process.stderr.write(`    failed: ${e?.message || e}\n`)
                }
              }
              if (collections.length === 0) err('every query failed — nothing collected, nothing uploaded', EXIT.GENERAL)

              const { buildAdminHeaders } = await import('./admin-auth.js')
              const path = '/social/tiktok/corpus'
              let up: any
              try {
                up = await ao.socialTiktokCorpusUpload(niche.id, collections, Number(spent.toFixed(4)), buildAdminHeaders('POST', path))
              } catch (e: any) {
                err(`collected ${collections.length} queries but upload failed: ${e.message}`, EXIT.GENERAL)
              }
              log(`corpus ${niche.id}: stored ${up?.stored} posts from ${collections.length} queries ($${spent.toFixed(2)})`)
              return print({ ...up, spent_usdc: Number(spent.toFixed(4)) })
            }

            err(`Unknown corpus command: ${sub}. Try: niches, refresh <niche>`, EXIT.BAD_INPUT)
            return
          }

          case 'scheduled': {
            // Palmyr's record of what it queued. TikTok cannot be asked, so
            // this is the only place the answer exists — and the response says
            // so, because a post edited in Studio changes reality without
            // changing this.
            let data: any
            try {
              data = await ao.socialTiktokScheduled({
                accountId: positional[0] || (flags.account as string),
                includeDone: flags.all === true,
              })
            } catch (e: any) {
              err(`scheduled failed: ${e.message}`, EXIT.GENERAL)
            }
            if (AGENT_MODE) return print(data)
            const rows = data?.posts || []
            console.log(`\n  ${t.accent}scheduled posts${t.reset}\n`)
            if (!rows.length) { console.log(`  ${t.muted}Nothing queued.${t.reset}\n`); return }
            for (const p of rows) {
              const when = String(p.scheduled_at).replace('T', ' ').slice(0, 16)
              const wait = p.minutes_until >= 0
                ? `in ${p.minutes_until < 90 ? p.minutes_until + 'm' : Math.round(p.minutes_until / 60) + 'h'}`
                : `${t.muted}overdue${t.reset}`
              const views = p.observed_views != null ? `  ${p.observed_views} views` : ''
              console.log(`  ${String(p.state).padEnd(10)} ${when}  ${wait.padEnd(16)} ${String(p.caption).slice(0, 34)}${views}`)
              console.log(`  ${t.muted}${p.operation_id}${t.reset}`)
            }
            console.log(`\n  ${t.muted}${data.note}${t.reset}\n`)
            return
          }

          case 'cancel': {
            const id = positional[0] || (flags.id as string)
            if (!id) err('<operation-id> required — see: palmyr tiktok scheduled', EXIT.BAD_INPUT)
            const username = (flags.account as string) || (flags.username as string)
            const acc = username ? sv.getAccount(platform, username) : undefined
            const sess = acc ? sv.loadSession(acc.id) : undefined
            const jar: any[] = sess?.cookies?.length ? sess.cookies : []
            const acctId = acc ? acc.id : (username || '')
            const psid = acc ? sv.getProxySessionId(platform, username!) : undefined
            const country = (flags.country as string)?.toLowerCase() || (acc ? sv.getCountry(platform, username!) : undefined)

            let data: any
            try {
              data = await ao.socialTiktokCancelScheduled(id, acctId, jar, psid, country)
            } catch (e: any) {
              err(`cancel failed: ${e.message}`, EXIT.GENERAL)
            }
            if (data?.already_cancelled) return print(data)
            if (data?.operation_id) {
              const final = await pollTikTokOperation(ao, data.operation_id, { label: 'cancel', pollAfterSeconds: Number(data.poll_after_seconds), agentMode: AGENT_MODE })
              if (!final) return print({ operation_id: data.operation_id, status: 'running', done: false, message: 'Still running — re-check the poll_url.' })
              if (final.status === 'failed') err(`cancel failed: ${final.error || 'unknown'} (refund: ${final.refund_status || 'unknown'})`, EXIT.GENERAL)
              log(`tiktok cancel ${id} → deleted`)
              return print({ cancelled: true, operation_id: id, ...(final.result || {}) })
            }
            return print(data)
          }

          case 'monitor': {
            // Unattended self-learning loop: periodically run `analytics` (scrape
            // + categorize + snapshot) for the monitored accounts. Mirrors the
            // wallet daemon — tick / start / stop / status.
            const sm = await import('./social-monitor.js')
            const sub = positional[0] || 'status'
            const cliPath = process.argv[1]
            const resolveAccounts = (): string[] => {
              const flagAcc = flags.account as string
              if (flagAcc) return flagAcc.split(',').map((s) => s.trim()).filter(Boolean)
              return sv.listAccounts(platform).map((a) => a.username)
            }
            if (sub === 'tick') {
              const accounts = resolveAccounts()
              if (!accounts.length) err('No TikTok accounts to monitor — connect one first.', EXIT.NOT_FOUND)
              return print({ ticked: accounts.length, results: sm.monitorTick(cliPath, accounts) })
            }
            if (sub === 'start') {
              const accounts = resolveAccounts()
              if (!accounts.length) err('No TikTok accounts to monitor — connect one first.', EXIT.NOT_FOUND)
              const intervalSeconds = sm.parseInterval((flags.every as string) || (flags.interval as string), 21600)
              const { pid } = sm.startMonitor(cliPath, { intervalSeconds, accounts })
              return print({ started: true, pid, every_seconds: intervalSeconds, accounts })
            }
            if (sub === 'stop') {
              const r = await sm.stopMonitor()
              return print({ stopped: r.wasRunning, pid: r.pid })
            }
            if (sub === 'status') {
              return print(sm.monitorStatus())
            }
            if (sub === '_run') {
              const intervalSeconds = sm.parseInterval(flags.interval as string, 21600)
              const accounts = resolveAccounts()
              await sm.runMonitorLoop(cliPath, { intervalSeconds, accounts })
              return
            }
            err(`Unknown monitor action: ${sub}. Try: tick, start, stop, status`, EXIT.BAD_INPUT)
            return
          }

          case 'post':
          case 'schedule':
          case 'follow':
          case 'like':
          case 'delete':
          case 'bio':
          case 'name':
          case 'pfp': {
            const username = positional[0] || (flags.username as string)
            if (!username) err(`<username> required`)
            // An account logged in with `connect --server` has no local record
            // and no cookie jar — its session lives in its own browser profile
            // on the server and never left the box. Send no cookies and let the
            // server authorise on the profile. Only demand a local session when
            // there is a local account that simply has not logged in yet.
            const acc = sv.getAccount(platform, username)
            const sess = acc ? sv.loadSession(acc.id) : undefined
            const serverSide = !acc || !sess || !sess.cookies || sess.cookies.length === 0
            if (acc && serverSide && !flags.server) {
              // A known local account with no session is a genuine "log in
              // first", not a server-side one — unless told otherwise.
              err(
                `No cached session for ${username}. Run 'palmyr tiktok connect ${username} --server' ` +
                `(logs in on the server, recommended) or 'tiktok login ${username}'.`,
                EXIT.NOT_FOUND,
              )
            }
            const psid = acc ? sv.getProxySessionId(platform, username) : undefined
            const country = (flags.country as string)?.toLowerCase() || (acc ? sv.getCountry(platform, username) : undefined)
            // For a server-side account the handle IS the id the profile is
            // keyed on — that is what `connect --server` created it under.
            const acctId = acc ? acc.id : username!
            const jar: any[] = serverSide ? [] : sess!.cookies

            let data: any
            // Set by the post/schedule branch so the shared async tail can write
            // the post-log only once the operation confirms 'posted'.
            let postCaption: string | undefined
            let postScheduleAt: string | undefined
            try {
              if (subcommand === 'post' || subcommand === 'schedule') {
                const caption = (flags.caption as string) || (flags.body as string) || (flags.text as string)
                if (!caption) err('--caption "..." required')
                const filePath = (flags.file as string) || (flags.path as string)
                const videoUrl = flags.url as string
                if (!filePath && !videoUrl) err('--file <local-path> or --url <https-url> required')
                let media: { video_base64?: string; video_url?: string } = {}
                if (filePath) {
                  const { readFileSync, existsSync, statSync } = await import('fs')
                  if (!existsSync(filePath)) err(`File not found: ${filePath}`, EXIT.NOT_FOUND)
                  const size = statSync(filePath).size
                  if (size > 100 * 1024 * 1024) err(`Video too large (${size} bytes, max 100 MB)`, EXIT.BAD_INPUT)
                  const buf = readFileSync(filePath)
                  media.video_base64 = `data:video/mp4;base64,${buf.toString('base64')}`
                } else {
                  media.video_url = videoUrl
                }
                const privacy = flags.privacy !== undefined ? Number(flags.privacy) as 0 | 1 | 2 : undefined
                // `schedule` is `post` with a future time — drives TikTok's own
                // scheduler. Validate the window client-side for fast feedback;
                // the server re-checks and renders it into the account timezone.
                let schedule_at: string | undefined
                if (subcommand === 'schedule') {
                  const at = (flags.at as string) || (flags.when as string)
                  if (!at) err('--at <iso8601> required (e.g. --at 2026-06-03T18:00:00Z)')
                  const when = new Date(at)
                  if (isNaN(when.getTime())) err('--at must be a valid ISO-8601 datetime (e.g. 2026-06-03T18:00:00Z)', EXIT.BAD_INPUT)
                  const ms = when.getTime() - Date.now()
                  if (ms < 15 * 60 * 1000) err('--at must be at least ~15 minutes in the future (TikTok minimum)', EXIT.BAD_INPUT)
                  if (ms > 10 * 24 * 60 * 60 * 1000) err('--at must be within ~10 days (TikTok maximum)', EXIT.BAD_INPUT)
                  schedule_at = when.toISOString()
                }
                // Posting is ASYNC server-side (202 + operation_id). Record the
                // caption/schedule for the post-log the shared tail writes once
                // the op confirms, then hand the envelope to the shared poller.
                postCaption = caption
                postScheduleAt = schedule_at
                data = await ao.socialTiktokPost(acctId, jar, caption, media, { privacy, schedule_at }, psid, country)
              } else if (subcommand === 'follow') {
                const target = (flags.user as string) || (flags.target as string)
                if (!target) err('--user <@handle> required')
                data = await ao.socialTiktokFollow(acctId, jar, target, psid, country)
              } else if (subcommand === 'like') {
                const videoUrl = (flags.video as string) || (flags.url as string)
                if (!videoUrl) err('--video <tiktok-url> required')
                data = await ao.socialTiktokLike(acctId, jar, videoUrl, psid, country)
              } else if (subcommand === 'delete') {
                const videoUrl = (flags.video as string) || (flags.url as string)
                if (!videoUrl) err('--video <tiktok-url> required')
                data = await ao.socialTiktokDelete(acctId, jar, videoUrl, psid, country)
              } else if (subcommand === 'bio') {
                const text = (flags.text as string) || (flags.body as string)
                if (text === undefined) err('--text "..." required (pass "" to clear)')
                data = await ao.socialTiktokProfile(acctId, jar, { bio: text }, psid, country)
              } else if (subcommand === 'name') {
                const text = (flags.display as string) || (flags.text as string) || (flags.name as string)
                if (!text) err('--display "Display Name" required')
                data = await ao.socialTiktokProfile(acctId, jar, { display_name: text }, psid, country)
              } else {
                // pfp
                const filePath = (flags.file as string) || (flags.path as string)
                const imageUrl = flags.url as string
                if (!filePath && !imageUrl) err('--file <local-path> or --url <https-url> required')
                let image: { image_base64?: string; image_url?: string } = {}
                if (filePath) {
                  const { readFileSync, existsSync } = await import('fs')
                  if (!existsSync(filePath)) err(`File not found: ${filePath}`, EXIT.NOT_FOUND)
                  const buf = readFileSync(filePath)
                  const ext = filePath.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/)?.[1] || 'png'
                  image.image_base64 = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`
                } else {
                  image.image_url = imageUrl
                }
                data = await ao.socialTiktokAvatar(acctId, jar, image, psid, country)
              }
            } catch (e: any) {
              err(`${subcommand} failed: ${e.message}`, EXIT.GENERAL)
            }

            // All TikTok browser ops are async server-side: the POST returns a
            // 202 { operation_id, poll_url } and the work runs in the background.
            // Poll to a terminal state (posted/done | failed); --no-wait returns
            // the handle. A legacy sync server (no operation_id) falls through to
            // the old {success,data} handling for back-compat.
            const opId = data?.operation_id
            if (opId) {
              const pollUrl = data.poll_url || `/social/tiktok/operations/${opId}`
              const pollAfter = Math.max(1, Number(data.poll_after_seconds) || 15)
              const ndjson = AGENT_MODE
              if (flags.wait === false) {
                log(`tiktok ${subcommand} (async): ${username} op=${opId}`)
                return print({ operation_id: opId, status: data.status || 'running', done: false, poll_url: pollUrl, message: data.message })
              }
              // Cap at ~6 min (posts run 2-5 min; simple ops ~1-2 min). Each poll
              // GET costs a micro-payment, so keep the cadence at poll_after.
              const POLL_TIMEOUT_MS = 360_000
              const intervalMs = pollAfter * 1000
              const deadline = Date.now() + POLL_TIMEOUT_MS
              const maxAttempts = Math.ceil(POLL_TIMEOUT_MS / intervalMs) + 1
              const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
              if (!ndjson) process.stderr.write(`tiktok ${subcommand}: working… (up to a few min)\n`)
              let final: any = null
              let attempt = 0
              while (attempt < maxAttempts && Date.now() < deadline) {
                await sleep(intervalMs)
                attempt++
                let op: any
                try {
                  op = await ao.socialTiktokOperation(opId)
                } catch (e: any) {
                  if (ndjson) process.stderr.write(JSON.stringify({ event: 'poll', status: 'error', attempt, message: e?.message ?? String(e) }) + '\n')
                  continue
                }
                if (ndjson) process.stderr.write(JSON.stringify({ event: 'poll', status: op?.status || 'running', attempt }) + '\n')
                if (op?.done === true || op?.status === 'failed') { final = op; break }
              }
              if (!final) {
                log(`tiktok ${subcommand} (pending): ${username} op=${opId}`)
                return print({ operation_id: opId, status: data.status || 'running', done: false, poll_url: pollUrl, message: `Still running after ${Math.round(POLL_TIMEOUT_MS / 1000)}s. It continues server-side — re-check with GET ${pollUrl}.` })
              }
              if (final.status === 'failed') {
                log(`tiktok ${subcommand} (failed): ${username} op=${opId} refund=${final.refund_status || 'unknown'}`)
                print(final)
                process.stderr.write(JSON.stringify({ error: final.error || `tiktok ${subcommand} failed`, error_code: final.error_code, refund_status: final.refund_status, exitCode: EXIT.GENERAL }) + '\n')
                process.exit(EXIT.GENERAL)
              }
              // Success (status 'posted' for a post, 'done' for a simple op).
              if ((subcommand === 'post' || subcommand === 'schedule') && postCaption) {
                sd.appendPostLog({ platform, account: username, caption: postCaption, source: 'direct', status: postScheduleAt ? 'scheduled' : 'posted', url: final.video_url, tag: acc?.tag, result: final })
              }
              // A server-side account has no local record to stamp — the op
              // already succeeded, so a bookkeeping miss must not turn it into
              // a reported failure.
              if (acc) sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
              return print({ success: true, platform, username, op: subcommand, operation_id: opId, ...(final.video_url ? { video_url: final.video_url, video_id: final.video_id } : {}), ...(final.scheduled_at ? { scheduled_at: final.scheduled_at } : {}), ...(final.result || {}) })
            }

            // Legacy sync server (no operation_id) — back-compat.
            if (!data?.success) {
              err(
                `${subcommand} failed: ${data?.error || 'unknown'}` +
                (data?.error_code ? ` [${data.error_code}]` : ''),
                EXIT.GENERAL
              )
            }
            sv.updateMeta(platform, username, { last_action_at: new Date().toISOString() })
            return print({ success: true, platform, username, op: subcommand, ...(data?.data || {}) })
          }

          default:
            err(`Unknown tiktok command: ${subcommand}. Try: connect, import, push, pull, list, info, rename, tag, remove, totp, login, session, post, schedule, draft, drafts, approve, reject, logs, analytics, series, hooks, corpus, scheduled, cancel, review, monitor, follow, like, delete, bio, name, pfp`)
        }
        break
      }

      case 'worker': {
        // The local worker daemon was deprecated in favor of server-side
        // scheduling — `palmyr twitter schedule` now POSTs to the Palmyr
        // server, which runs its own scheduler internally and fires posts
        // automatically. No daemon to manage on the user's machine.
        err(
          'Local worker is deprecated. Server-side scheduling is automatic — ' +
          'register an account (`palmyr twitter register <user>`), then schedule ' +
          'posts (`palmyr twitter schedule <user> --body "..." --at "..."`). ' +
          'The Palmyr server fires them at post_at without any client process.',
          EXIT.BAD_INPUT
        )
        break
      }

      case 'telemetry': {
        // Off by default. Opt-in only. We never auto-enable, never prompt at
        // startup, never write to stdout outside this command. Captured fields
        // and storage location are documented in cli/telemetry.ts.
        const action = (subcommand || 'status').toLowerCase()
        if (action !== 'on' && action !== 'off' && action !== 'status') {
          err(`Unknown telemetry action: ${action}. Use: on | off | status`, EXIT.BAD_INPUT)
        }
        let state
        if (action === 'on') state = setTelemetryEnabled(true)
        else if (action === 'off') state = setTelemetryEnabled(false)
        else state = getTelemetryState()

        const payload = {
          enabled: state.enabled,
          installId: state.installId || null,
          optedInAt: state.optedInAt || null,
          queuedEvents: telemetryQueuedCount(),
          captures: ['cmd', 'exitCode', 'durationMs', 'cliVersion', 'nodeVersion', 'platform'],
          neverCaptures: ['flag values', 'positional args', 'stdout/stderr', 'wallet addresses', 'phone numbers', 'any user input'],
        }

        if (AGENT_MODE) {
          print(payload)
        } else {
          const status = state.enabled ? `${t.success}on${t.reset}` : `${t.muted}off${t.reset}`
          console.log(`Telemetry:  ${status}`)
          if (state.installId) console.log(`Install ID: ${t.muted}${state.installId}${t.reset}`)
          if (state.optedInAt) console.log(`Opted in:   ${state.optedInAt}`)
          if (payload.queuedEvents) console.log(`Queued:     ${payload.queuedEvents} event(s) waiting to send`)
          console.log('')
          console.log(`Captures:   ${payload.captures.join(', ')}`)
          console.log(`Never:      flag values, positional args, stdout, user input`)
          if (!state.enabled) {
            console.log('')
            console.log(`Opt in:     ${t.accent}palmyr telemetry on${t.reset}`)
          } else {
            console.log('')
            console.log(`Opt out:    ${t.accent}palmyr telemetry off${t.reset}  (drops any queued events)`)
          }
        }
        break
      }

      case 'config': {
        const cfg = loadConfig()
        const { homedir } = await import('os')
        const { join } = await import('path')
        const vaultDir = process.env.PALMYR_WALLET_PATH || join(homedir(), '.palmyr', 'wallet')
        const { isCredentialStoreAvailable } = await import('./credential-store.js')
        const { hasLegacyKeyfileWallet } = await import('./config.js')

        // `defaultChain` is legacy keyfile-flow state — only show it when a
        // keyfile wallet is actually configured. The functional field is
        // `payChain` (renamed from the misleadingly-similar `defaultPayChain`
        // disk key), which the x402 pay path reads.
        const showLegacyChain = hasLegacyKeyfileWallet(cfg)
        const configData: Record<string, string | number | boolean | null | undefined> = {
          api: cfg.api,
          setupDone: cfg.setupDone,
          ...(showLegacyChain ? { legacyKeyfileChain: cfg.defaultChain || 'solana' } : {}),
          defaultPayWalletId: (cfg as any).defaultPayWalletId || null,
          payChain: (cfg as any).defaultPayChain || 'solana',
          vaultPath: vaultDir,
          credentialStore: isCredentialStoreAvailable() ? 'available' : 'unavailable',
          configPath: join(homedir(), '.palmyr', 'config.json'),
          cliVersion: VERSION,
        }

        if (!AGENT_MODE) {
          render(React.createElement(ConfigScreen, { version: VERSION, config: configData }))
        } else {
          print(configData)
        }
        break
      }

      case 'doctor': {
        const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; detail: string }> = []
        const { homedir } = await import('os')
        const { join } = await import('path')
        const { existsSync } = await import('fs')

        // 1. Vault directory
        const vaultDir = process.env.PALMYR_WALLET_PATH || join(homedir(), '.palmyr', 'wallet')
        const vaultExists = existsSync(join(vaultDir, 'wallets'))
        checks.push({ name: 'Vault directory', status: vaultExists ? 'pass' : 'fail', detail: vaultExists ? vaultDir : 'Not found — run: palmyr wallet create' })

        // 2. Credential store
        const { isCredentialStoreAvailable } = await import('./credential-store.js')
        const credAvail = isCredentialStoreAvailable()
        checks.push({ name: 'OS credential store', status: credAvail ? 'pass' : 'fail', detail: credAvail ? `${process.platform} store available` : 'Not available — wallet keys cannot be stored securely' })

        // 3. Local wallets
        const { listVaultWallets } = await import('./vault.js')
        const wallets = listVaultWallets()
        checks.push({ name: 'Local wallets', status: wallets.length > 0 ? 'pass' : 'warn', detail: `${wallets.length} wallet(s) found` })

        // 4. Decryption readiness for each wallet — tri-state.
        //
        //   pass  → wallet has keychain secret, OR has a passphrase fallback
        //           AND PALMYR_WALLET_PASSPHRASE is set
        //   warn  → has passphrase fallback but env unset (recoverable, but
        //           the next command will fail until env is set)
        //   fail  → session-only AND keychain secret is gone (unrecoverable
        //           from this machine — needs mnemonic re-import or
        //           rekey-on-original)
        const { retrieveSecret } = await import('./credential-store.js')
        const { hasPassphraseFallback } = await import('./vault.js')
        const envSet = !!process.env.PALMYR_WALLET_PASSPHRASE
        let keychainOk = 0
        let needsEnv = 0
        let unrecoverable: string[] = []
        for (const w of wallets) {
          if (retrieveSecret(w.id)) {
            keychainOk++
            continue
          }
          let hasFallback = false
          try { hasFallback = hasPassphraseFallback(w.id) } catch {}
          if (hasFallback) {
            needsEnv++
          } else {
            unrecoverable.push(w.name || w.id.slice(0, 8))
          }
        }
        if (wallets.length > 0) {
          if (unrecoverable.length > 0) {
            checks.push({
              name: 'Wallet decryption',
              status: 'fail',
              detail: `${unrecoverable.length} session-only wallet(s) UNRECOVERABLE from this machine — keychain secret missing and no passphrase fallback (${unrecoverable.slice(0, 3).join(', ')}${unrecoverable.length > 3 ? ', …' : ''}). Recover by importing the mnemonic here, or running \`palmyr wallet rekey <id> --passphrase <p>\` on the original machine.`,
            })
          } else if (needsEnv > 0 && !envSet) {
            checks.push({
              name: 'Wallet decryption',
              status: 'warn',
              detail: `${needsEnv} wallet(s) need PALMYR_WALLET_PASSPHRASE to decrypt (keychain secret missing, passphrase fallback present). Set the env var to unblock pay / sign / export.`,
            })
          } else if (needsEnv > 0) {
            checks.push({
              name: 'Wallet decryption',
              status: 'pass',
              detail: `${keychainOk} via OS keychain, ${needsEnv} via PALMYR_WALLET_PASSPHRASE (env set)`,
            })
          } else {
            checks.push({
              name: 'Wallet decryption',
              status: 'pass',
              detail: `All ${keychainOk} wallet(s) have keychain secrets`,
            })
          }
        }

        // 5. API connectivity
        try {
          const health = await ao.health()
          checks.push({ name: 'API connectivity', status: health.status === 'healthy' ? 'pass' : 'warn', detail: `${ao.api} — ${health.status}` })
          if (health.version?.version && health.version.version !== VERSION) {
            checks.push({ name: 'Version match', status: 'warn', detail: `CLI ${VERSION} vs server ${health.version.version}` })
          } else {
            checks.push({ name: 'Version match', status: 'pass', detail: `CLI ${VERSION}` })
          }
        } catch {
          checks.push({ name: 'API connectivity', status: 'warn', detail: `${ao.api} — unreachable (local-only mode works fine)` })
        }

        const failCount = checks.filter(c => c.status === 'fail').length
        if (!AGENT_MODE) {
          render(React.createElement(DoctorScreen, { version: VERSION, checks }))
        } else {
          print({ checks })
        }
        if (failCount > 0) process.exit(EXIT.GENERAL)
        break
      }

      case 'pricing': {
        const data = await ao.pricing()
        return print(data)
        const services = Object.entries(data.services || {}).map(([name, prices]) => ({
          name,
          items: typeof prices === 'object'
            ? Object.entries(prices as Record<string, string>).map(([label, value]) => ({ label, value: String(value) }))
            : [],
        }))
        render(React.createElement(PricingScreen, {
          version: VERSION,
          services,
          interactive: fromHome,
          onBack: fromHome ? () => {
            process.env.PALMYR_FROM_HOME = '0'
            process.argv = [process.argv[0], process.argv[1]]
            void main()
          } : undefined,
        }))
        break
      }

      case 'health': {
        const data = await ao.health()
        // Surface every version layer at the top of the response so agents
        // don't have to dig into nested `version.version`. Keeps the raw
        // server payload available too for back-compat.
        const apiVersion = (data as any)?.version?.version ?? null
        const apiBuild = (data as any)?.version?.build ?? null
        const apiName = (data as any)?.version?.name ?? null
        return print({
          cliPackageVersion: VERSION,
          apiVersion,
          apiName,
          apiBuild,
          nodeVersion: process.version,
          platform: process.platform,
          ...data,
        })

        // Version check — warn if CLI is behind the server
        const serverVersion = data.version?.version
        if (serverVersion && serverVersion !== VERSION) {
          console.log(`  ${t.warn}Update available:${t.reset} CLI ${VERSION} → server ${serverVersion}`)
          console.log(`  ${t.muted}Run: npm install -g @palmyr/cli${t.reset}\n`)
        }

        render(React.createElement(HealthScreen, {
          version: VERSION,
          status: data.status || 'unknown',
          uptime: data.uptime?.human || '?',
          apiVersion: serverVersion || '?',
          interactive: fromHome,
          onBack: fromHome ? () => {
            process.env.PALMYR_FROM_HOME = '0'
            process.argv = [process.argv[0], process.argv[1]]
            void main()
          } : undefined,
        }))
        break
      }

      default:
        if (AGENT_MODE) {
          process.stderr.write(JSON.stringify({
            error: `Unknown command: ${command}`,
            hint: 'Run palmyr --help for usage',
            exitCode: EXIT.BAD_INPUT,
          }) + '\n')
        } else {
          render(React.createElement(ErrorScreen, {
            version: VERSION,
            title: 'Unknown command',
            message: `Unknown command: ${command}`,
            hint: 'Run palmyr --help for usage',
            footerLeft: 'Command not found',
          }))
        }
        process.exit(EXIT.BAD_INPUT)
    }
  } catch (e: any) {
    // Sanitize error output — never expose stack traces or internal paths.
    // The same sanitized message goes to both the Ink ErrorScreen and the
    // JSON-mode stderr line, so behaviour matches across modes.
    const rawMsg: string = e.message || String(e)
    const safeMsg = rawMsg
      .replace(/\s*at\s+.+/g, '')              // strip stack frames
      .replace(/[A-Z]:\\[^\s:]+/gi, '[path]')  // strip Windows paths
      .replace(/\/[^\s:]+\.(ts|js)/g, '[path]') // strip Unix paths
      .trim()

    // Map the raw error to a stable exit code + a one-line agent-friendly hint.
    let exitCode: number = EXIT.GENERAL
    let title = 'Command failed'
    let hint: string | undefined
    let footerLeft = 'See palmyr --help'

    if (rawMsg.startsWith('Payment Required:') || rawMsg.includes('settlement failed') || rawMsg.includes('verification failed')) {
      exitCode = EXIT.PAYMENT
      title = 'Payment rejected'
      hint = rawMsg.includes('settlement failed')
        ? 'On-chain tx reverted. Check wallet balance (USDC only — chain fees are paid by the server). View tx on explorer if settled partially.'
        : 'The server rejected the payment signature. Check your default pay wallet: palmyr config'
      footerLeft = 'x402 payment failed'
    } else if (rawMsg === 'Payment Required' || rawMsg.includes('402')) {
      exitCode = EXIT.PAYMENT
      title = 'Payment required'
      hint = 'Set a default pay wallet: palmyr wallet use <ID>'
      footerLeft = 'Provisioning blocked until payment'
    } else if (rawMsg.includes('SECURITY')) {
      exitCode = EXIT.SECURITY
      title = 'Security violation'
      hint = 'A wallet file may have been tampered with. Do not use it.'
      footerLeft = 'Operation blocked'
    } else if (rawMsg.includes('ECONNREFUSED') || rawMsg.includes('fetch failed')) {
      exitCode = EXIT.NETWORK
      hint = 'Is the API running? Check: palmyr health'
    } else if (rawMsg.includes('Authentication') || rawMsg.includes('401') || rawMsg.includes('Unauthorized')) {
      exitCode = EXIT.AUTH_FAIL
      hint = 'Check your API token or session'
    } else if (rawMsg.includes('session secret') || rawMsg.includes('credential store')) {
      // Don't synthesize a hint here — pay.ts / pay-preflight.ts now throw with
      // an actionable multi-path message already in `rawMsg` (restore session
      // secret / set passphrase / re-import). Adding our own "Create a wallet
      // first" hint on top contradicts that message and pushes agents toward
      // the wrong fix (recreating a wallet that already exists).
      exitCode = EXIT.NOT_FOUND
    } else if (rawMsg.includes('not found')) {
      exitCode = EXIT.NOT_FOUND
      const scope = rawMsg.includes('twitter account') ? 'twitter'
                  : rawMsg.includes('tiktok account') ? 'tiktok'
                  : 'wallet'
      hint = `Check the name with: palmyr ${scope} list`
    }

    if (AGENT_MODE) {
      const payload: Record<string, any> = {
        error: safeMsg || 'An unexpected error occurred',
        exitCode,
      }
      if (hint) payload.hint = hint
      process.stderr.write(JSON.stringify(payload) + '\n')
    } else {
      render(React.createElement(ErrorScreen, {
        version: VERSION,
        title,
        message: safeMsg || 'An unexpected error occurred',
        hint,
        footerLeft,
      }))
    }
    process.exit(exitCode)
  }

}

main()
