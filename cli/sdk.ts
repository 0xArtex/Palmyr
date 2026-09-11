/**
 * Palmyr SDK — programmatic access to all Palmyr services.
 */

const DEFAULT_API = 'https://palmyr.ai'

// -------------------- DNS --------------------

/** One DNS row as the registrar accepts it. `name` is the host — `@` for the apex. */
export interface DnsRecordInput {
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'URL' | 'URL301'
  name: string
  value: string
  ttl?: number
}

/**
 * Normalise a DNS response to a records array. The read endpoint returns the
 * array at the top level while the write endpoint wraps it in `{ records }`;
 * callers shouldn't have to remember which is which.
 */
export function dnsRecordsOf(data: any): DnsRecordInput[] {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.records)) return data.records
  return []
}

// -------------------- Client-side executor helpers --------------------

/** Topological order of plan steps using their `depends_on` arrays. */
function topoOrderSteps(steps: any[]): any[] {
  const byId = new Map<string, any>(steps.map(s => [s.step_id, s]))
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const s of steps) {
    indegree.set(s.step_id, Array.isArray(s.depends_on) ? s.depends_on.length : 0)
    for (const dep of s.depends_on ?? []) {
      if (!byId.has(dep)) throw new Error(`step ${s.step_id} depends on unknown step ${dep}`)
      if (!outgoing.has(dep)) outgoing.set(dep, [])
      outgoing.get(dep)!.push(s.step_id)
    }
    if (!outgoing.has(s.step_id)) outgoing.set(s.step_id, [])
  }
  const order: any[] = []
  const ready: string[] = []
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id)
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(byId.get(id)!)
    for (const dep of outgoing.get(id) ?? []) {
      const next = (indegree.get(dep) ?? 0) - 1
      indegree.set(dep, next)
      if (next === 0) ready.push(dep)
    }
  }
  if (order.length !== steps.length) throw new Error('plan has a dependency cycle')
  return order
}

/**
 * Resolve a $STEPS.sN.output.path expression against prior outputs.
 * Two modes:
 *   - whole-field: "$STEPS.s1.output.field" → returns the resolved value verbatim
 *     (could be any type — object, array, string, number)
 *   - embedded: "hello $STEPS.s1.output.field" → scans and substitutes the match
 *     (resolved values are coerced to strings)
 */
// Look up a key on an object, tolerating exact / camelCase / snake_case — schemas
// drift from actual server responses; the resolver shouldn't punish either side.
function lookupKey(obj: any, key: string): any {
  if (obj === null || typeof obj !== 'object') return undefined
  if (key in obj) return obj[key]
  const camel = key.replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())
  const snake = key.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
  if (camel in obj) return obj[camel]
  if (snake in obj) return obj[snake]
  return undefined
}

type PathSeg =
  | { kind: 'key'; name: string }
  | { kind: 'index'; idx: number }
  | { kind: 'filter'; key: string; value: string }

// Parse a resolver path into segments. Supports:
//   .name / name          → object key
//   [0]                   → array index
//   [key=value]           → attribute filter (first array element whose key == value)
//   [?@.key='value']      → JSONPath-ish alias of the same
function parsePath(path: string): PathSeg[] {
  const segs: PathSeg[] = []
  const re = /\[([^\]]+)\]|([^.\[\]]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) {
      const inner = m[1].trim()
      if (/^\d+$/.test(inner)) {
        segs.push({ kind: 'index', idx: parseInt(inner, 10) })
      } else {
        const body = inner.replace(/^\?/, '')
        const eq = body.indexOf('=')
        if (eq > 0) {
          const key = body.slice(0, eq).replace(/^@\.?/, '').trim()
          const value = body.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
          segs.push({ kind: 'filter', key, value })
        } else {
          segs.push({ kind: 'key', name: body })
        }
      }
    } else if (m[2] !== undefined) {
      segs.push({ kind: 'key', name: m[2] })
    }
  }
  return segs
}

function resolveOne(stepId: string, path: string | undefined, priorOutputs: Record<string, any>): any {
  const base = priorOutputs[stepId]
  if (base === undefined) return undefined
  if (!path) return base
  let cursor: any = base
  for (const seg of parsePath(path)) {
    if (cursor === null || cursor === undefined) return undefined
    if (seg.kind === 'index') {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[seg.idx]
    } else if (seg.kind === 'filter') {
      // Pick the first array element whose `key` equals `value` (string-wise,
      // with the same camel/snake tolerance as key lookups). Lets the planner
      // select "the inbox whose address == hello@x.com" without knowing its
      // index: $STEPS.s1.output.inboxes[address=hello@x.com].id
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor.find(el => {
        const f = lookupKey(el, seg.key)
        return f !== undefined && String(f) === seg.value
      })
    } else {
      if (typeof cursor !== 'object') return undefined
      cursor = lookupKey(cursor, seg.name)
    }
  }
  return cursor
}

// ─── i402 async-operation polling & dynamic pricing ───

// Capabilities whose real 402 price is per-resource (per-TLD, per-server-type),
// so the planner's static registry quote is only an estimate. For these the
// live 402 is the source of truth — bounded by the global spend ceiling, not
// the stale quote (which would otherwise abort the step before it pays).
const DYNAMIC_PRICED_CAPABILITIES = new Set<string>(['register_domain', 'deploy_vps'])

const ASYNC_TERMINAL_OK = new Set(['active', 'running', 'completed', 'succeeded', 'success', 'done', 'ready', 'provisioned'])
const ASYNC_TERMINAL_FAIL = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'rejected'])

type AsyncState = 'pending' | 'ok' | 'failed'

// Classify an async-operation envelope. Any response carrying `poll_url` is
// in-progress until its `status` is terminal (per /.well-known guidance:
// completed/failed; for servers, running).
export function operationState(op: any): AsyncState {
  if (!op || typeof op !== 'object') return 'pending'
  // A raw x402 payment-required CHALLENGE is not a failed operation — it means
  // the poll endpoint itself wants payment/auth (e.g. /domains/operations/:id is
  // $0.01 owner-only). The paid poller below settles it and retries; never read
  // the challenge body's `error: "Payment Required"` as the op having failed.
  if (op.x402Version && op.accepts) return 'pending'
  const status = String(op.status ?? '').toLowerCase()
  if (op.error || op.ok === false || ASYNC_TERMINAL_FAIL.has(status)) return 'failed'
  // An explicit `done: false` outranks the status word.
  //
  // 'running' sits in TERMINAL_OK because for a VPS that IS the finished state
  // — the server is up. For a browser op it means the exact opposite: still
  // working. TikTok ops report `status: 'running'` while in flight, so reading
  // the word alone declared every post complete the moment it started, handed
  // downstream steps an operation handle instead of a video_url, and never
  // waited for the post that the caller had already paid for.
  //
  // Services that publish a boolean know their own lifecycle better than a
  // shared word list does, so when they state it, believe them.
  if (op.done === false) return 'pending'
  if (op.done === true || ASYNC_TERMINAL_OK.has(status)) return 'ok'
  return 'pending'
}

function isAsyncEnvelope(op: any): boolean {
  return !!(op && typeof op === 'object' && op.poll_url && operationState(op) === 'pending')
}

// Flatten the final operation object so downstream $STEPS.sN.output.FIELD
// references resolve against the resource fields, not the operation handle.
function mergeOperationResult(envelope: any, finalOp: any): any {
  const out: any = {
    ...(envelope && typeof envelope === 'object' ? envelope : {}),
    ...(finalOp && typeof finalOp === 'object' ? finalOp : {}),
  }
  if (finalOp && typeof finalOp.result === 'object' && finalOp.result) Object.assign(out, finalOp.result)
  return out
}

function resolveTemplateValue(value: any, priorOutputs: Record<string, any>): any {
  if (typeof value !== 'string') return value

  // Whole-field match: the string is *only* a template expression. Return the
  // resolved value verbatim (may be non-string).
  const whole = value.match(/^\$STEPS\.([a-zA-Z0-9_]+)\.output(?:\.(.+))?$/)
  if (whole) {
    const resolved = resolveOne(whole[1], whole[2], priorOutputs)
    if (resolved === undefined) {
      const stepOutput = priorOutputs[whole[1]]
      const detail = stepOutput === undefined
        ? `step '${whole[1]}' has not run yet (missing depends_on?)`
        : `step '${whole[1]}' produced ${JSON.stringify(stepOutput)} which has no '${whole[2]}' field`
      throw new Error(`Could not resolve template "${value}" — ${detail}`)
    }
    return resolved
  }

  // Embedded match: substitute every $STEPS.X.output(.path) occurrence with its
  // string-coerced resolved value. Path is a sequence of .name or [n] segments.
  const embeddedPattern = /\$STEPS\.([a-zA-Z0-9_]+)\.output((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g
  if (!embeddedPattern.test(value)) return value
  // Re-run since test() advances lastIndex on /g patterns
  return value.replace(/\$STEPS\.([a-zA-Z0-9_]+)\.output((?:\.[a-zA-Z0-9_]+|\[\d+\])*)/g, (match, stepId, pathChain) => {
    const path = pathChain.replace(/^\./, '') || undefined
    const resolved = resolveOne(stepId, path, priorOutputs)
    if (resolved === undefined) {
      const stepOutput = priorOutputs[stepId]
      const detail = stepOutput === undefined
        ? `step '${stepId}' has not run yet`
        : `step '${stepId}' has no '${path}' field`
      throw new Error(`Could not resolve template "${match}" inside "${value}" — ${detail}`)
    }
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  })
}

/** Walk an input object deeply, resolving every templated string leaf. */
function resolveStepInput(input: any, priorOutputs: Record<string, any>): any {
  if (input === null || input === undefined) return input
  if (typeof input === 'string') return resolveTemplateValue(input, priorOutputs)
  if (Array.isArray(input)) return input.map(v => resolveStepInput(v, priorOutputs))
  if (typeof input === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(input)) out[k] = resolveStepInput(v, priorOutputs)
    return out
  }
  return input
}

/**
 * Detect whether a step's capability is a social operation that needs a
 * vault-managed session (cookies, login creds). Twitter/TikTok provisioning
 * (buy/account) and any non-social capability return false.
 */
function socialPlatformForCapability(capability?: string): 'twitter' | 'tiktok' | null {
  if (!capability) return null
  if (capability === 'twitter_buy_account') return null
  if (capability.startsWith('twitter_')) return 'twitter'
  if (capability.startsWith('tiktok_')) return 'tiktok'
  return null
}

/**
 * For a planner-emitted social step, resolve the `handle` field to the local
 * vault entry, ensure a fresh login session (auto-login if stale), and return
 * an enriched HTTP body. The `handle` field is consumed (removed from the
 * outgoing body) and replaced with the server-expected `account_id` plus
 * cookies + proxy_session_id + (for change_username) password.
 *
 * Credentials NEVER appear in the persisted plan/step.input — only in the
 * immediate HTTP body to the social endpoint.
 *
 * If the session is stale or missing, performs a paid login call (~$0.005)
 * and yields a 'session_refresh' event so the CLI can render it inline.
 *
 * Throws if the account isn't in the local vault (the caller turns this into
 * a step_error).
 */
async function* injectSocialCredentials(opts: {
  platform: 'twitter' | 'tiktok'
  capability: string
  resolvedInput: Record<string, any>
  api: string
  passphrase?: string
}): AsyncGenerator<any, Record<string, any>, undefined> {
  const sv: typeof import('./social-vault.js') = await import('./social-vault.js')
  const { paidRequest } = await import('./pay.js')

  // Accept `handle` (current schema) or `account_id` (legacy). Remove both
  // from the outgoing body — the server only wants `account_id` set to the
  // real internal id, which we inject below.
  const rawHandle = String(
    opts.resolvedInput.handle ?? opts.resolvedInput.account_id ?? ''
  ).replace(/^@/, '').trim()
  if (!rawHandle) {
    throw new Error(
      `${opts.capability} requires a handle in 'handle' (e.g. 'ArianneAgent'). ` +
      `The planner left it blank.`
    )
  }
  const acc = sv.getAccount(opts.platform, rawHandle)
  if (!acc) {
    throw new Error(
      `${opts.platform} account "@${rawHandle}" is not in the local vault. ` +
      `Run: palmyr ${opts.platform} import @${rawHandle}`
    )
  }

  const SESSION_TTL_HOURS = 12
  let session = sv.loadSession(acc.id)
  const ageHours = sv.sessionAgeHours(acc.id)
  const stale = !session || session.cookies.length === 0 || (ageHours !== undefined && ageHours > SESSION_TTL_HOURS)

  if (stale) {
    yield { type: 'session_refresh_started', platform: opts.platform, handle: rawHandle }
    const creds = sv.unlockCredentials(opts.platform, rawHandle)
    const psid = sv.getProxySessionId(opts.platform, rawHandle)
    const loginPath = `/social/${opts.platform}/login`
    const loginBody: Record<string, any> = { account_id: acc.id, ...(psid ? { proxy_session_id: psid } : {}) }
    if (opts.platform === 'twitter') {
      if (creds.auth_token) loginBody.auth_token = creds.auth_token
      if (creds.ct0) loginBody.ct0 = creds.ct0
      if (creds.login) loginBody.login = creds.login
      if (creds.password) loginBody.password = creds.password
      if (creds.totp_seed) loginBody.totp_seed = creds.totp_seed
    } else {
      if (creds.tiktok_sessionid) loginBody.sessionid = creds.tiktok_sessionid
      if (creds.tiktok_csrf) loginBody.tt_csrf_token = creds.tiktok_csrf
      if (creds.tiktok_webid) loginBody.tt_webid_v2 = creds.tiktok_webid
      if (creds.login) loginBody.login = creds.login
      if (creds.password) loginBody.password = creds.password
      if (creds.email) loginBody.email = creds.email
      if (creds.email_password) loginBody.email_password = creds.email_password
    }
    const result = await paidRequest(opts.api, 'POST', loginPath, loginBody, opts.passphrase)
    const cookies = (result.data?.cookies ?? []) as any[]
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error(`${opts.platform} login for @${rawHandle} returned no cookies`)
    }
    session = sv.saveSession(acc.id, opts.platform, cookies)
    sv.updateMeta(opts.platform, rawHandle, { last_action_at: new Date().toISOString() })
    yield {
      type: 'session_refresh_done',
      platform: opts.platform,
      handle: rawHandle,
      costChargedUsdc: 0.005,
      txSignature: result.txHash,
    }
  }

  // Build the enriched body. Start from resolvedInput so operation-specific
  // fields (text, target_user, etc.) flow through. Strip the planner's
  // handle/account_id fields, then inject the real internal account_id,
  // cookies, proxy_session_id, and (for change_username) the vault password.
  const enriched: Record<string, any> = { ...opts.resolvedInput }
  delete enriched.handle
  enriched.account_id = acc.id
  enriched.cookies = session!.cookies
  const psid2 = sv.getProxySessionId(opts.platform, rawHandle)
  if (psid2) enriched.proxy_session_id = psid2
  if (opts.capability === 'twitter_change_username') {
    const creds = sv.unlockCredentials(opts.platform, rawHandle)
    if (!creds.password) {
      throw new Error(`twitter_change_username needs the vault password for @${rawHandle}, but none is stored.`)
    }
    enriched.password = creds.password
  }
  return enriched
}

/**
 * Substitute {field_name} placeholders in an endpoint URL from the step's input.
 * Fields consumed into the path are REMOVED from the returned body so they
 * don't get sent twice. If a placeholder has no matching input, throws — the
 * executor surfaces that as a step_error.
 */
function substitutePathParams(
  endpoint: string,
  input: Record<string, any>,
): { url: string; body: Record<string, any> } {
  const body: Record<string, any> = { ...input }
  const url = endpoint.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, field) => {
    if (!(field in body)) {
      const present = Object.keys(input).join(', ') || '(empty)'
      throw new Error(
        `endpoint ${endpoint} requires path param '${field}' but step input has no such field. ` +
        `Input fields present: ${present}. ` +
        `If '${field}' should come from a prior step, the planner must include it as "$STEPS.sN.output.FIELD".`
      )
    }
    const value = body[field]
    delete body[field]
    return encodeURIComponent(String(value))
  })
  return { url, body }
}

export class Palmyr {
  public api: string
  public token?: string
  public passphrase?: string
  private autoPay: boolean
  private payerSolanaAddress?: string | null

  constructor(apiUrl?: string, autoPay?: boolean, token?: string, passphrase?: string) {
    this.api = apiUrl || process.env.PALMYR_API || DEFAULT_API
    this.token = token || process.env.PALMYR_TOKEN || process.env.PALMYR_API_KEY
    this.passphrase = passphrase || process.env.PALMYR_WALLET_PASSPHRASE
    this.autoPay = autoPay ?? true
  }

  // The Solana address of the wallet that pays (config.defaultPayWalletId, else
  // PALMYR_PAY_WALLET, else the first vault wallet with a Solana key). Needed to
  // own Solana-keyed resources (email inboxes) when the agent is paying on Base.
  private async resolvePayerSolanaAddress(): Promise<string | undefined> {
    if (this.payerSolanaAddress !== undefined) return this.payerSolanaAddress || undefined
    try {
      const { listVaultWallets } = await import('./vault.js')
      const { loadConfig } = await import('./config.js')
      const cfg: any = loadConfig()
      const targetId = cfg.defaultPayWalletId || process.env.PALMYR_PAY_WALLET
      const wallets = listVaultWallets()
      const w = (targetId && wallets.find((x: any) => x.id === targetId)) || wallets.find((x: any) => x.solanaAddress)
      this.payerSolanaAddress = w?.solanaAddress ?? null
    } catch {
      this.payerSolanaAddress = null
    }
    return this.payerSolanaAddress || undefined
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    const opts: RequestInit = { method, headers }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(this.api + path, opts)

    // Some edge layers (CDN, nginx) return HTML error pages for transient
    // upstream failures. Detect that before trying JSON.parse so the agent
    // gets a usable error instead of "Unexpected token '<'".
    const contentType = res.headers.get('content-type') || ''
    let data: any
    if (contentType.includes('application/json')) {
      data = await res.json().catch(() => ({ error: 'Invalid JSON response from server' }))
    } else {
      const text = await res.text().catch(() => '')
      if (res.status === 402) {
        // 402 without JSON body still handled by paidRequest below.
        data = {}
      } else {
        throw new Error(
          `Server returned ${res.status} ${res.statusText} with non-JSON body ` +
          `(${contentType || 'no content-type'}). This is usually a transient CDN/nginx error — retry in a moment. ` +
          `First 200 chars: ${text.slice(0, 200)}`
        )
      }
    }

    // If 402 and autoPay enabled, try to pay (uses local vault wallet via pay.ts)
    if (res.status === 402 && this.autoPay) {
      try {
        const { paidRequest } = await import('./pay.js')
        const result = await paidRequest(this.api, method, path, body, this.passphrase)
        return result.data
      } catch (e: any) {
        throw new Error(e.message)
      }
    }

    // Only treat `data.error` as an exception when the HTTP response itself
    // signaled failure. Some endpoints return 200 with an `error` field as
    // legitimate row data — most notably `GET /transfers/:id`, where a
    // failed async transfer's reason ends up in `row.error`. Throwing on
    // those would short-circuit the caller's status check. Mirrors the
    // pattern already used in `requestWithHeaders` (line ~1185).
    if (data.error && !res.ok) {
      const parts: string[] = [String(data.error)]
      if (data.message && data.message !== data.error) parts.push(String(data.message))
      if (data.hint) parts.push(`Hint: ${data.hint}`)
      const e: any = new Error(parts.join(' — '))
      // Attach structured fields the server set so callers can branch on
      // them without re-parsing the message string. Mostly useful for
      // 503 retry signalling (Retry-After + error_code), but generic enough
      // to apply to any structured server error.
      if (data.error_code) e.code = data.error_code
      if (typeof data.retry_after_seconds === 'number') e.retryAfterSeconds = data.retry_after_seconds
      e.httpStatus = res.status
      throw e
    }
    return data
  }

  // ── Phone ──
  async phoneSearch(country: string, limit?: number): Promise<any> {
    return this.request('GET', `/phone/numbers/search?country=${country}${limit ? '&limit=' + limit : ''}`)
  }

  async phoneBuy(country: string, areaCode?: string): Promise<any> {
    return this.request('POST', '/phone/numbers', { country, ...(areaCode ? { areaCode } : {}) })
  }

  async phoneSms(phoneId: string, to: string, body: string): Promise<any> {
    return this.request('POST', `/phone/numbers/${phoneId}/send`, { to, body })
  }

  async phoneCall(
    phoneId: string,
    to: string,
    tts?: string,
    opts?: { ttsVoice?: string; audioUrl?: string; record?: boolean; timeoutSecs?: number },
  ): Promise<any> {
    return this.request('POST', `/phone/numbers/${phoneId}/call`, { to, tts, ...(opts || {}) })
  }

  // Phone-number-scoped reads & lifecycle
  async phoneListNumbers(): Promise<any> {
    return this.request('GET', '/phone/numbers')
  }

  async phoneMessages(phoneId: string): Promise<any> {
    return this.request('GET', `/phone/numbers/${phoneId}/messages`)
  }

  async phoneMessage(messageId: string): Promise<any> {
    return this.request('GET', `/phone/messages/${messageId}`)
  }

  // Blocking wait for an SMS verification code (OTP). The server holds the
  // request up to timeout_s (max 90) and returns { found, code, ... }.
  async phoneWaitOtp(
    phoneId: string,
    opts: { timeoutS?: number; lookbackS?: number; pattern?: string } = {},
  ): Promise<any> {
    const body: Record<string, unknown> = {}
    if (opts.timeoutS !== undefined) body.timeout_s = opts.timeoutS
    if (opts.lookbackS !== undefined) body.lookback_s = opts.lookbackS
    if (opts.pattern !== undefined) body.pattern = opts.pattern
    return this.request('POST', `/phone/numbers/${phoneId}/wait-otp`, body)
  }

  async phoneCalls(phoneId: string): Promise<any> {
    return this.request('GET', `/phone/numbers/${phoneId}/calls`)
  }

  // Disposable receive-only temp numbers (pooled) — the phone analogue of the
  // temp email inbox. $0.20/30min lease; extend +30min (stackable, 24h cap).
  async phoneTemp(ttlSeconds?: number): Promise<any> {
    const body: Record<string, unknown> = {}
    if (ttlSeconds != null) body.ttl_seconds = ttlSeconds
    return this.request('POST', '/phone/temp', body)
  }

  async phoneExtendTemp(phoneId: string): Promise<any> {
    return this.request('POST', `/phone/temp/${encodeURIComponent(phoneId)}/extend`)
  }

  async phoneRelease(phoneId: string): Promise<any> {
    return this.request('DELETE', `/phone/numbers/${phoneId}`)
  }

  // Ownership: transfer / share / unshare (mirrors domains)
  async phoneTransferOwnership(phoneId: string, newOwner: string): Promise<any> {
    return this.request('POST', `/phone/numbers/${phoneId}/transfer-ownership`, { new_owner: newOwner })
  }

  async phoneShare(phoneId: string, withWallet: string): Promise<any> {
    return this.request('POST', `/phone/numbers/${phoneId}/share`, { with: withWallet })
  }

  async phoneUnshare(phoneId: string, wallet: string): Promise<any> {
    return this.request('POST', `/phone/numbers/${phoneId}/unshare`, { wallet })
  }

  // Call-control-scoped operations
  async phoneCallInfo(callControlId: string): Promise<any> {
    return this.request('GET', `/phone/calls/${callControlId}`)
  }

  async phoneSpeak(callControlId: string, text: string, opts?: { voice?: string; language?: string }): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/speak`, { text, ...(opts || {}) })
  }

  async phonePlay(callControlId: string, audioUrl: string): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/play`, { audioUrl })
  }

  async phoneDtmf(callControlId: string, digits: string): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/dtmf`, { digits })
  }

  async phoneGather(callControlId: string, opts?: {
    minDigits?: number
    maxDigits?: number
    timeoutMillis?: number
    terminatingDigit?: string
    prompt?: string
    promptVoice?: string
  }): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/gather`, opts || {})
  }

  async phoneRecord(callControlId: string, format?: string): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/record`, format ? { format } : {})
  }

  async phoneRecordStop(callControlId: string): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/record/stop`, {})
  }

  async phoneHangup(callControlId: string): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/hangup`, {})
  }

  async phoneAnswer(callControlId: string): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/answer`, {})
  }

  async phoneTransfer(callControlId: string, to: string): Promise<any> {
    return this.request('POST', `/phone/calls/${callControlId}/transfer`, { to })
  }

  // ── Email ──
  async emailCreate(name: string, walletAddress?: string, domain?: string): Promise<any> {
    const body: Record<string, unknown> = { name }
    if (walletAddress) body.walletAddress = walletAddress
    if (domain) body.domain = domain
    return this.request('POST', '/email/inboxes', body)
  }

  async emailExtendTemp(inboxId: string): Promise<any> {
    return this.request('POST', `/email/temp/${encodeURIComponent(inboxId)}/extend`)
  }

  async emailTemp(ttlSeconds?: number): Promise<any> {
    const body: Record<string, unknown> = {}
    if (ttlSeconds != null) body.ttl_seconds = ttlSeconds
    return this.request('POST', '/email/temp', body)
  }

  async emailListInboxes(): Promise<any> {
    return this.request('GET', '/email/inboxes')
  }

  async emailDomainStatus(domain: string): Promise<any> {
    return this.request('GET', `/email/domains/${encodeURIComponent(domain)}/status`)
  }

  async emailRegisterDomain(domain: string): Promise<any> {
    return this.request('POST', `/email/domains/${encodeURIComponent(domain)}/register`)
  }

  async emailRead(inboxId: string): Promise<any> {
    return this.request('GET', `/email/inboxes/${inboxId}/messages`)
  }

  async emailSend(inboxId: string, to: string, subject: string, body: string): Promise<any> {
    return this.request('POST', `/email/inboxes/${inboxId}/send`, { to, subject, body })
  }

  async emailThreads(inboxId: string): Promise<any> {
    return this.request('GET', `/email/inboxes/${inboxId}/threads`)
  }

  async emailDelete(inboxId: string): Promise<any> {
    return this.request('DELETE', `/email/inboxes/${encodeURIComponent(inboxId)}`)
  }

  // ── Compute ──
  async computePlans(opts: { location?: string } = {}): Promise<any> {
    const qs = opts.location ? `?location=${encodeURIComponent(opts.location)}` : ''
    return this.request('GET', `/compute/plans${qs}`)
  }

  async computeLocations(): Promise<any> {
    return this.request('GET', '/compute/locations')
  }

  /**
   * Deploy a Hetzner Cloud server.
   *
   * `install` controls what cloud-init bootstraps on the server. When set
   * (string or array), it overrides the legacy `installOpenClaw` boolean.
   * Pass `[]` for a vanilla Ubuntu box (cloud-init skipped, password auth
   * stays enabled). Discoverable via `GET /compute/install-recipes`.
   *
   * `location` picks a Hetzner datacenter slug (fsn1, nbg1, hel1, ash, hil,
   * sin). The server validates type-vs-location compatibility pre-payment so
   * cax11+ash fails as 400 with `Try one of: fsn1` instead of 422 after
   * x402 settles. Discoverable via `GET /compute/locations`.
   */
  async computeDeploy(
    name: string,
    serverType: string,
    opts: {
      sshPublicKey?: string
      sshKeyIds?: number[]
      installOpenClaw?: boolean
      install?: string | string[]
      location?: string
    } = {},
  ): Promise<any> {
    const body: Record<string, unknown> = {
      name,
      serverType,
      image: 'ubuntu-24.04',
    }
    if (opts.install !== undefined) {
      body.install = opts.install
    } else if (opts.installOpenClaw !== undefined) {
      body.installOpenClaw = opts.installOpenClaw
    }
    if (opts.sshPublicKey) body.sshPublicKey = opts.sshPublicKey
    if (opts.sshKeyIds?.length) body.sshKeyIds = opts.sshKeyIds
    if (opts.location) body.location = opts.location
    return this.request('POST', '/compute/servers', body)
  }

  /**
   * Rename a deployed server. Metadata-only; doesn't reboot. Local server
   * cache is updated by the CLI wrapper after a successful API call.
   */
  async computeRename(serverId: string, newName: string): Promise<any> {
    return this.request('PUT', `/compute/servers/${serverId}`, { name: newName })
  }

  async computeInstallRecipes(): Promise<any> {
    return this.request('GET', '/compute/install-recipes')
  }

  async computeList(): Promise<any> {
    return this.request('GET', '/compute/servers')
  }

  async computeDelete(serverId: string): Promise<any> {
    return this.request('DELETE', `/compute/servers/${serverId}`)
  }

  /**
   * Buy another billing period for a running (or idled-for-non-payment)
   * server. Costs the same as the original deploy for that type; renewing
   * early stacks onto the time left rather than discarding it.
   */
  async computeRenew(serverId: string): Promise<any> {
    return this.request('POST', `/compute/servers/${serverId}/renew`)
  }

  /**
   * Rebuild a server that was destroyed for non-payment, from the snapshot
   * taken at termination. Returns a NEW server id and IP.
   */
  async computeRestore(serverId: string): Promise<any> {
    return this.request('POST', `/compute/servers/${serverId}/restore`)
  }

  /**
   * Inject your SSH public key into a freshly-deployed VPS, remove the
   * platform's temporary key, and lock the root password. After this call,
   * only your key can SSH into the box.
   */
  async computeSetupSsh(serverId: string, publicKey: string): Promise<any> {
    return this.request('POST', `/compute/servers/${serverId}/setup-ssh`, { publicKey })
  }

  // ── SSH keys (Hetzner-managed, stable IDs) ──
  //
  // The numeric ID returned by `computeSshKeyAdd` is what `computeDeploy({
  // sshKeyIds: [...] })` consumes. Hetzner injects them into authorized_keys
  // at first boot — same outcome as inline `sshPublicKey`, but the key is
  // reusable across deploys without re-uploading.
  async computeSshKeyAdd(name: string, publicKey: string): Promise<any> {
    return this.request('POST', '/compute/ssh-keys', { name, publicKey })
  }

  async computeSshKeyList(): Promise<any> {
    return this.request('GET', '/compute/ssh-keys')
  }

  async computeSshKeyDelete(id: number | string): Promise<any> {
    return this.request('DELETE', `/compute/ssh-keys/${id}`)
  }

  async computeGet(serverId: string): Promise<any> {
    return this.request('GET', `/compute/servers/${serverId}`)
  }

  /**
   * Run a single command on a freshly-deployed server via the platform's
   * SSH key. Pre-handoff only — once `compute setup-ssh` has run we no
   * longer have access. `command` and `args` are POSIX-quoted server-side
   * so they pass through as distinct argv elements on the remote shell.
   */
  async computeExec(
    serverId: string,
    command: string,
    args: string[] = [],
    opts: { timeoutSec?: number } = {},
  ): Promise<any> {
    const body: Record<string, unknown> = { command, args }
    if (opts.timeoutSec) body.timeoutSec = opts.timeoutSec
    return this.request('POST', `/compute/servers/${serverId}/exec`, body)
  }

  async computeAction(serverId: string, action: string, opts: { image?: string } = {}): Promise<any> {
    const body: Record<string, unknown> = { action }
    if (opts.image) body.image = opts.image
    return this.request('POST', `/compute/servers/${serverId}/actions`, body)
  }

  // ── Domains ──
  async domainCheck(domain: string): Promise<any> {
    return this.request('GET', `/domains/check?domain=${domain}`)
  }

  async domainList(): Promise<any> {
    return this.request('GET', '/domains')
  }

  async domainPricing(domain: string): Promise<any> {
    return this.request('GET', `/domains/pricing?domain=${domain}`)
  }

  /**
   * Register a domain. As of the async migration this is a non-blocking call:
   * the server responds **202** with `{ operation_id, status: 'pending',
   * poll_url, poll_after_seconds, domain, expiresAt, cost, message }` and the
   * registrar order runs in the background. Poll {@link domainOperation} with
   * the returned `operation_id` until `done === true` to learn the final
   * outcome (`active` or `failed`). A legacy server may still answer **201**
   * with the registered domain synchronously — callers should treat a payload
   * lacking `operation_id` as already-done.
   *
   * Charged via x402 (registrar cost × markup); auto-paid when autoPay is on.
   */
  async domainBuy(domain: string): Promise<any> {
    return this.request('POST', '/domains/register', { domain })
  }

  /**
   * Poll a domain-registration operation started by {@link domainBuy}.
   * Returns `{ operation_id, status, done, domain, expiresAt, cost,
   * registrar_order_id, error, error_code, refund_status, dnsManagement,
   * created_at, started_at, completed_at }`. `status` ∈
   * `pending|registering|active|failed`; `done` is true once status is `active`
   * or `failed`. On `failed`, `refund_status` (`'sent'|'failed'|'manual_needed'`)
   * reflects the AUTOMATIC refund. Each call is paid via x402 (0.01 USDC,
   * owner-only) and auto-paid when autoPay is on.
   */
  async domainOperation(operationId: string): Promise<any> {
    return this.request('GET', `/domains/operations/${encodeURIComponent(operationId)}`)
  }

  /**
   * Read the live DNS records for an owned (or shared) domain. The endpoint
   * answers with the records ARRAY at the top level (not `{ records }`) — use
   * {@link dnsRecordsOf} to normalise either shape. 0.01 USDC ownership proof.
   */
  /**
   * Start a SERVER-SIDE TikTok login. The browser that authenticates is the one
   * that will later act — same persistent profile, same proxy exit, same
   * fingerprint — so the session is never a cookie jar in transit and no
   * device/IP mismatch is baked in at login. Returns `{ connect_url, token,
   * poll_url }`: hand `connect_url` to a human to scan with the TikTok app,
   * then poll {@link tiktokConnectStatus}. Costs 0.01 USDC (it holds one of two
   * long-idling login browsers for up to ten minutes).
   */
  async tiktokConnectServer(accountId: string, opts: { country?: string; proxySessionId?: string } = {}): Promise<any> {
    return this.request('POST', '/social/tiktok/connect', {
      account_id: accountId,
      ...(opts.country ? { country: opts.country } : {}),
      ...(opts.proxySessionId ? { proxy_session_id: opts.proxySessionId } : {}),
    })
  }

  /**
   * Every TikTok account this wallet owns on the server, with session health:
   * `status`, `profile_present`, `last_seen_at`, `hours_since_success`. Costs
   * 0.001 USDC — the payment is what identifies the caller, and a wallet only
   * ever sees its own accounts.
   */
  async tiktokAccounts(tag?: string): Promise<any> {
    return this.request('GET', `/social/tiktok/accounts${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`)
  }

  /** Poll a server-side login. Free. `done` is true on completed or failed. */
  async tiktokConnectStatus(token: string): Promise<any> {
    return this.request('GET', `/social/tiktok/connect/${encodeURIComponent(token)}`)
  }

  async domainDns(domain: string): Promise<any> {
    return this.request('GET', `/domains/${encodeURIComponent(domain)}/dns`)
  }

  /**
   * REPLACE the domain's DNS records with `records`, and return
   * `{ message, records }`. 0.01 USDC ownership proof; wallets the domain is
   * shared with may write too.
   *
   * This is a full replacement, not a merge — the registrar's setHosts call
   * takes the complete host list, so any record you omit is DELETED. That
   * matters most for MX/TXT rows: dropping them silently breaks mail on a
   * domain with a Palmyr inbox. Use {@link domainDnsAdd} to upsert a single
   * record while keeping the rest.
   *
   * Each record is `{ type, name, value, ttl? }` where `type` is one of
   * A | AAAA | CNAME | MX | TXT | URL | URL301, `name` is the host (`@` for the
   * apex), and `ttl` defaults to 1800 seconds.
   */
  async domainDnsSet(domain: string, records: DnsRecordInput[]): Promise<any> {
    return this.request('POST', `/domains/${encodeURIComponent(domain)}/dns`, { records })
  }

  /**
   * Upsert one record while preserving every other record on the domain: reads
   * the current set, replaces any row with the same `type` + `name`, and writes
   * the merged list back. Costs two calls (0.01 read + 0.01 write).
   *
   * Returns the same `{ message, records }` as {@link domainDnsSet}.
   */
  async domainDnsAdd(domain: string, record: DnsRecordInput): Promise<any> {
    const current = dnsRecordsOf(await this.domainDns(domain))
    const host = record.name || '@'
    const merged = current.filter(r => !(r.type === record.type && (r.name || '@') === host))
    merged.push({ ...record, name: host })
    return this.domainDnsSet(domain, merged)
  }

  async domainTransferOwnership(domain: string, newOwner: string): Promise<any> {
    return this.request('POST', `/domains/${domain}/transfer-ownership`, { new_owner: newOwner })
  }

  async domainShare(domain: string, withWallet: string): Promise<any> {
    return this.request('POST', `/domains/${domain}/share`, { with: withWallet })
  }

  async domainUnshare(domain: string, wallet: string): Promise<any> {
    return this.request('POST', `/domains/${domain}/unshare`, { wallet })
  }

  // ── Cards (prepaid Visa) ──
  /**
   * Buy a USA prepaid Visa card loaded with exactly `amount` USD ($5–$1000).
   * Async: the server responds **202** with `{ operation_id, card_id,
   * status: 'pending', poll_url, poll_after_seconds, pricing }` and the
   * purchase runs in the background. Poll {@link cardOperation} until
   * `done === true` (`ready` → fetch the number with {@link cardGet};
   * `failed` → `refund_status` reflects the automatic refund).
   * Charged via x402: amount + fee (3% min $0.50); auto-paid when autoPay is on.
   */
  async cardBuy(amount: number): Promise<any> {
    return this.request('POST', '/cards/buy', { amount })
  }

  /**
   * Poll a card purchase started by {@link cardBuy}. FREE — poll every
   * `poll_after_seconds` (~3s). `status` ∈
   * `pending|purchasing|provisioning|ready|failed`; `done` is true on
   * `ready`/`failed`. Never carries the card number — that's {@link cardGet}.
   */
  async cardOperation(operationId: string): Promise<any> {
    return this.request('GET', `/cards/operations/${encodeURIComponent(operationId)}`)
  }

  /** List cards owned by the paying wallet (status, last4, balance). $0.01 ownership proof. */
  async cardList(): Promise<any> {
    return this.request('GET', '/cards')
  }

  /** Full card number / CVV / expiry + balance — owner-only. $0.01 ownership proof. */
  async cardGet(cardId: string): Promise<any> {
    return this.request('GET', `/cards/${encodeURIComponent(cardId)}`)
  }

  /** Live balance + issuer transactions ($0.01; issuer re-scrape rate-limited to 1/5min per card). */
  async cardRefresh(cardId: string): Promise<any> {
    return this.request('POST', `/cards/${encodeURIComponent(cardId)}/refresh`)
  }

  // ── X account pool: transfer / share / claim ──
  async xAccountTransfer(id: string, toWallet: string): Promise<any> {
    return this.request('POST', `/x/accounts/${encodeURIComponent(id)}/transfer`, { to_wallet: toWallet })
  }

  async xAccountShare(id: string, withWallet: string): Promise<any> {
    return this.request('POST', `/x/accounts/${encodeURIComponent(id)}/share`, { with: withWallet })
  }

  async xAccountUnshare(id: string, wallet: string, opts: { rotate?: boolean } = {}): Promise<any> {
    return this.request('POST', `/x/accounts/${encodeURIComponent(id)}/unshare`, {
      wallet,
      ...(opts.rotate ? { rotate: true } : {}),
    })
  }

  /** Accounts the calling wallet owns or has shared access to. */
  async xAccountsMine(): Promise<any> {
    return this.request('GET', '/x/accounts/mine')
  }

  // ── Wallet ──
  async walletCreate(label?: string, chains?: string[], mode?: 'unmanaged' | 'managed'): Promise<any> {
    return this.request('POST', '/wallet', { label, chains, mode })
  }

  async walletImport(mnemonic: string, label?: string, mode?: 'unmanaged' | 'managed'): Promise<any> {
    return this.request('POST', '/wallet/import', { mnemonic, label, mode })
  }

  async walletList(): Promise<any> {
    return this.request('GET', '/wallet')
  }

  async walletGet(walletId: string): Promise<any> {
    return this.request('GET', `/wallet/${walletId}`)
  }

  async walletDelete(walletId: string): Promise<any> {
    return this.request('DELETE', `/wallet/${walletId}`)
  }

  async walletAddresses(walletId: string): Promise<any> {
    return this.request('GET', `/wallet/${walletId}/addresses`)
  }

  async walletDerive(walletId: string, chain: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/derive`, { chain })
  }

  /** Sign a transaction. Auth resolved from API key or session secret. */
  async walletSign(walletId: string, chain: string, transaction: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/sign`, { chain, transaction })
  }

  async walletSignMessage(walletId: string, chain: string, message: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/sign-message`, { chain, message })
  }

  async walletSignTyped(walletId: string, chain: string, typedData: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/sign-typed`, { chain, typedData })
  }

  async walletPolicy(walletId: string, policy: { per_tx_usdc?: number; daily_usdc?: number; allowed_chains?: string[] }): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/policy`, { policy })
  }

  async walletGetPolicy(walletId: string): Promise<any> {
    return this.request('GET', `/wallet/${walletId}/policy`)
  }

  async walletSpending(walletId: string): Promise<any> {
    return this.request('GET', `/wallet/${walletId}/spending`)
  }

  async walletApiKey(walletId: string, name: string, sessionSecret: string, policyIds?: string[], expiresAt?: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/api-key`, { name, sessionSecret, policyIds, expiresAt })
  }

  async walletRevokeApiKey(walletId: string, keyId: string): Promise<any> {
    return this.request('DELETE', `/wallet/${walletId}/api-key`, { keyId })
  }

  async walletConfig(walletId: string, sessionSecret: string): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/config`, { sessionSecret })
  }

  async walletRequestApproval(walletId: string, action: string, params: Record<string, any>): Promise<any> {
    return this.request('POST', `/wallet/${walletId}/request-approval`, { action, ...params })
  }

  // ── Social ──
  async socialTwitterLogin(
    accountId: string,
    login: string,
    password: string,
    totpSeed?: string,
    cookies?: { auth_token?: string; ct0?: string },
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/login', {
      account_id: accountId,
      ...(proxySessionId ? { proxy_session_id: proxySessionId } : {}),
      login,
      password,
      ...(totpSeed ? { totp_seed: totpSeed } : {}),
      ...(cookies?.auth_token ? { auth_token: cookies.auth_token } : {}),
      ...(cookies?.ct0 ? { ct0: cookies.ct0 } : {}),
    })
  }

  async socialTwitterRegister(
    username: string,
    password: string,
    opts?: {
      login?: string
      email?: string
      email_password?: string
      totp_seed?: string
      auth_token?: string
      ct0?: string
      country?: string
    }
  ): Promise<any> {
    return this.request('POST', '/social/twitter/register', {
      username,
      password,
      ...(opts?.login ? { login: opts.login } : {}),
      ...(opts?.email ? { email: opts.email } : {}),
      ...(opts?.email_password ? { email_password: opts.email_password } : {}),
      ...(opts?.totp_seed ? { totp_seed: opts.totp_seed } : {}),
      ...(opts?.auth_token ? { auth_token: opts.auth_token } : {}),
      ...(opts?.ct0 ? { ct0: opts.ct0 } : {}),
      ...(opts?.country ? { country: opts.country } : {}),
    })
  }
  async socialTwitterUnregister(accountId: string): Promise<any> {
    return this.request('DELETE', `/social/twitter/register/${encodeURIComponent(accountId)}`)
  }
  async socialTwitterListRegistered(): Promise<any> {
    return this.request('GET', '/social/twitter/registered')
  }

  // ── Transfer / share / unshare / claim on registered accounts ──
  // Mirrors xAccount* for the BYO-registered path. The CLI picks which
  // family to call based on where the account lives server-side.
  async socialTwitterRegisteredTransfer(accountId: string, toWallet: string): Promise<any> {
    return this.request('POST', `/social/twitter/registered/${encodeURIComponent(accountId)}/transfer`, { to_wallet: toWallet })
  }

  async socialTwitterRegisteredShare(accountId: string, withWallet: string): Promise<any> {
    return this.request('POST', `/social/twitter/registered/${encodeURIComponent(accountId)}/share`, { with: withWallet })
  }

  async socialTwitterRegisteredUnshare(accountId: string, wallet: string, opts: { rotate?: boolean } = {}): Promise<any> {
    return this.request('POST', `/social/twitter/registered/${encodeURIComponent(accountId)}/unshare`, {
      wallet,
      ...(opts.rotate ? { rotate: true } : {}),
    })
  }

  /** Registered-account claim: full creds for every account the wallet owns or has shared access to. */
  async socialTwitterRegisteredMine(): Promise<any> {
    return this.request('GET', '/social/twitter/registered/mine')
  }

  /**
   * Poll status of an in-flight transfer. Transfer endpoints return a
   * transfer_id; rotation runs in the background and this endpoint reflects
   * the row state (pending → rotating → completed | failed).
   */
  async transferStatus(transferId: string): Promise<any> {
    return this.request('GET', `/transfers/${encodeURIComponent(transferId)}`)
  }

  // ── Pool-bought X accounts: share / unshare / mine ──
  // Pool accounts live in social_account_pool (where `palmyr twitter buy`
  // writes). These mirror the same share semantics as x_accounts and
  // social_registered_accounts so the CLI can dispatch uniformly.
  async socialTwitterPoolShare(accountId: string, withWallet: string): Promise<any> {
    return this.request('POST', `/social/twitter/pool/${encodeURIComponent(accountId)}/share`, { with: withWallet })
  }

  async socialTwitterPoolUnshare(accountId: string, wallet: string): Promise<any> {
    return this.request('POST', `/social/twitter/pool/${encodeURIComponent(accountId)}/unshare`, { wallet })
  }

  /** Pool accounts the calling wallet owns or has shared access to, with full creds. */
  async socialTwitterPoolMine(): Promise<any> {
    return this.request('GET', '/social/twitter/pool/mine')
  }

  // ── Server-side scheduled posts ──
  // Pay at schedule time; worker fires at post_at with no further charge.
  // accountId is the 32-char hex returned by socialTwitterRegister().
  async socialScheduledPost(accountId: string, text: string, postAt: string, communityId?: string): Promise<any> {
    return this.request('POST', '/social/scheduled/post', {
      account_id: accountId, text, post_at: postAt,
      ...(communityId ? { community_id: communityId } : {}),
    })
  }
  async socialScheduledThread(accountId: string, texts: string[], postAt: string, communityId?: string): Promise<any> {
    return this.request('POST', '/social/scheduled/thread', {
      account_id: accountId, texts, post_at: postAt,
      ...(communityId ? { community_id: communityId } : {}),
    })
  }
  async socialScheduledMedia(
    accountId: string,
    text: string,
    media: Array<{ image_base64?: string; image_url?: string; video_base64?: string; video_url?: string }>,
    postAt: string,
    communityId?: string
  ): Promise<any> {
    return this.request('POST', '/social/scheduled/media', {
      account_id: accountId, text, media, post_at: postAt,
      ...(communityId ? { community_id: communityId } : {}),
    })
  }
  async socialScheduledList(filter?: {
    accountId?: string
    status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
    from?: string
    to?: string
    limit?: number
  }): Promise<any> {
    const qs = new URLSearchParams()
    if (filter?.accountId) qs.set('account_id', filter.accountId)
    if (filter?.status) qs.set('status', filter.status)
    if (filter?.from) qs.set('from', filter.from)
    if (filter?.to) qs.set('to', filter.to)
    if (filter?.limit) qs.set('limit', String(filter.limit))
    const path = '/social/scheduled' + (qs.toString() ? `?${qs}` : '')
    return this.request('GET', path)
  }
  async socialScheduledCancel(id: string): Promise<any> {
    return this.request('DELETE', `/social/scheduled/${encodeURIComponent(id)}`)
  }

  async socialTwitterPost(accountId: string, cookies: any[], text: string, proxySessionId?: string, communityId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/post', { account_id: accountId, proxy_session_id: proxySessionId, cookies, text, ...(communityId ? { community_id: communityId } : {}) })
  }
  async socialTwitterPostThread(accountId: string, cookies: any[], texts: string[], proxySessionId?: string, communityId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/post-thread', { account_id: accountId, proxy_session_id: proxySessionId, cookies, texts, ...(communityId ? { community_id: communityId } : {}) })
  }
  async socialTwitterPostWithMedia(
    accountId: string,
    cookies: any[],
    text: string,
    media: Array<{ image_base64?: string; image_url?: string; video_base64?: string; video_url?: string }>,
    proxySessionId?: string,
    communityId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/post-media', { account_id: accountId, proxy_session_id: proxySessionId, cookies, text, media, ...(communityId ? { community_id: communityId } : {}) })
  }
  async socialTwitterListMyTweets(accountId: string, cookies: any[], limit?: number, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/list-my-tweets', {
      account_id: accountId,
      proxy_session_id: proxySessionId,
      cookies,
      ...(typeof limit === 'number' ? { limit } : {}),
    })
  }
  async socialTwitterReply(accountId: string, cookies: any[], tweetUrl: string, text: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/reply', { account_id: accountId, proxy_session_id: proxySessionId, cookies, tweet_url: tweetUrl, text })
  }
  async socialTwitterLike(accountId: string, cookies: any[], tweetUrl: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/like', { account_id: accountId, proxy_session_id: proxySessionId, cookies, tweet_url: tweetUrl })
  }
  async socialTwitterRetweet(accountId: string, cookies: any[], tweetUrl: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/retweet', { account_id: accountId, proxy_session_id: proxySessionId, cookies, tweet_url: tweetUrl })
  }
  async socialTwitterFollow(accountId: string, cookies: any[], targetUser: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/follow', { account_id: accountId, proxy_session_id: proxySessionId, cookies, target_user: targetUser })
  }
  async socialTwitterUnfollow(accountId: string, cookies: any[], targetUser: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/unfollow', { account_id: accountId, proxy_session_id: proxySessionId, cookies, target_user: targetUser })
  }
  async socialTwitterDelete(accountId: string, cookies: any[], tweetUrl: string, proxySessionId?: string): Promise<any> {
    return this.request('POST', '/social/twitter/delete', { account_id: accountId, proxy_session_id: proxySessionId, cookies, tweet_url: tweetUrl })
  }
  async socialTwitterProfile(
    accountId: string,
    cookies: any[],
    patch: { bio?: string; display_name?: string; location?: string; website?: string },
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/profile', { account_id: accountId, proxy_session_id: proxySessionId, cookies, ...patch })
  }
  async socialTwitterAvatar(
    accountId: string,
    cookies: any[],
    image: { image_base64?: string; image_url?: string },
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/avatar', { account_id: accountId, proxy_session_id: proxySessionId, cookies, ...image })
  }
  async socialTwitterBanner(
    accountId: string,
    cookies: any[],
    image: { image_base64?: string; image_url?: string },
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/banner', { account_id: accountId, proxy_session_id: proxySessionId, cookies, ...image })
  }
  /** Poll an async X op (avatar / banner — both return { operation_id, poll_url,
   *  status }). Owner-scoped by the x402 signature; 404s for another wallet's
   *  operation. Terminal status is 'done' on success (result carries the image
   *  URL) or 'failed' (auto-refunded); `done` is true when terminal. */
  async socialTwitterOperation(operationId: string): Promise<any> {
    return this.request('GET', `/social/twitter/operations/${operationId}`)
  }
  async socialTwitterUsername(
    accountId: string,
    cookies: any[],
    newUsername: string,
    password: string,
    proxySessionId?: string
  ): Promise<any> {
    return this.request('POST', '/social/twitter/username', {
      account_id: accountId,
      proxy_session_id: proxySessionId,
      cookies,
      new_username: newUsername,
      password,
    })
  }

  async socialTwitterBuy(
    country?: string,
    ageCategory?: string,
    opts: {
      source?: string
      registeredCountry?: string
      registeredPlatform?: 'android' | 'ios' | 'web'
      maxUsernameChanges?: number
    } = {},
  ): Promise<any> {
    return this.request('POST', '/social/twitter/buy', {
      ...(country ? { country } : {}),
      ...(ageCategory ? { age_category: ageCategory } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.registeredCountry ? { registered_country: opts.registeredCountry } : {}),
      ...(opts.registeredPlatform ? { registered_platform: opts.registeredPlatform } : {}),
      ...(typeof opts.maxUsernameChanges === 'number' ? { max_username_changes: opts.maxUsernameChanges } : {}),
    })
  }

  // ── Pool country pricing + source multipliers ──

  // Public: prices per country + multipliers per source. Final charge for a
  // buy with both --country and --source is country_price * source_multiplier
  // (multiplier defaults to 1.0 when no row exists for the source).
  async socialTwitterPoolPrices(): Promise<any> {
    return this.request('GET', '/social/twitter/pool/prices')
  }

  // ── Disputes (buyer-facing) ──

  async socialTwitterDispute(accountId: string, opts: { reason?: 'suspended' | 'other'; evidence?: string } = {}): Promise<any> {
    return this.request('POST', '/social/twitter/dispute', {
      account_id: accountId,
      reason: opts.reason || 'suspended',
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
    })
  }

  async socialTwitterDisputeGet(id: string): Promise<any> {
    return this.request('GET', `/social/twitter/dispute/${encodeURIComponent(id)}`)
  }

  // ── TikTok ──
  /**
   * Log a TikTok account in. Two paths:
   *   - Cookie injection: pass `sessionid` (+ optional `tt_csrf_token`, `tt_webid_v2`).
   *   - Form login:       pass `login` + `password` — server uses CapSolver
   *                       to handle any captcha and harvests the cookies.
   * Either path returns the full cookie jar for the caller to cache locally.
   */
  async socialTiktokLogin(
    accountId: string,
    opts: {
      sessionid?: string
      ttCsrfToken?: string
      ttWebidV2?: string
      extraCookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
      login?: string
      password?: string
      email?: string
      emailPassword?: string
      proxySessionId?: string
      country?: string
    },
  ): Promise<any> {
    return this.request('POST', '/social/tiktok/login', {
      account_id: accountId,
      proxy_session_id: opts.proxySessionId,
      country: opts.country,
      sessionid: opts.sessionid,
      tt_csrf_token: opts.ttCsrfToken,
      tt_webid_v2: opts.ttWebidV2,
      extra_cookies: opts.extraCookies,
      login: opts.login,
      password: opts.password,
      email: opts.email,
      email_password: opts.emailPassword,
    })
  }

  async socialTiktokPost(
    accountId: string,
    cookies: any[],
    caption: string,
    media: { video_base64?: string; video_url?: string },
    opts?: { privacy?: 0 | 1 | 2; allow_comments?: boolean; allow_duet?: boolean; allow_stitch?: boolean; schedule_at?: string },
    proxySessionId?: string,
    country?: string,
  ): Promise<any> {
    return this.request('POST', '/social/tiktok/post', {
      account_id: accountId,
      proxy_session_id: proxySessionId,
      country,
      cookies,
      caption,
      ...media,
      ...(opts || {}),
    })
  }

  /** Poll an async TikTok operation (post / follow / like / delete / profile /
   *  avatar — all return { operation_id, poll_url, status }). Owner-scoped by
   *  the x402 signature; 404s for another wallet's operation. Terminal status is
   *  'posted'/'done' on success or 'failed' (auto-refunded); `done` is true when
   *  terminal. */
  async socialTiktokOperation(operationId: string): Promise<any> {
    return this.request('GET', `/social/tiktok/operations/${operationId}`)
  }

  /** Host an ephemeral login QR (data-URL) → returns a short token. Build the
   *  human-facing link as `${this.api}/connect/${token}`. Free, unauthenticated. */
  /** Create a hand-off session (no args → returns a token/link immediately),
   *  refresh its QR (pass qrDataUrl + token), or mark it done (token + done). */
  async socialTiktokHostQr(qrDataUrl?: string, token?: string, done?: boolean): Promise<{ token: string; expires_in_sec: number }> {
    return this.request('POST', '/social/tiktok/qr', { qr_data_url: qrDataUrl, token, done })
  }

  /** Stash a session jar for transfer to another machine; returns a one-time
   *  { transfer_code }. Used by `tiktok push` to move a session logged in on a
   *  trusted machine (real browser) to the machine that runs the ops. */
  async socialTiktokSessionStash(cookies: any[], label?: string): Promise<any> {
    return this.request('POST', '/social/tiktok/session/stash', { cookies, label })
  }

  /** Redeem a transfer code once → { ok, cookies }. Used by `tiktok pull`. */
  async socialTiktokSessionClaim(transferCode: string): Promise<any> {
    return this.request('POST', '/social/tiktok/session/claim', { transfer_code: transferCode })
  }

  async socialTiktokFollow(accountId: string, cookies: any[], targetUser: string, proxySessionId?: string, country?: string): Promise<any> {
    return this.request('POST', '/social/tiktok/follow', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, target_user: targetUser })
  }

  async socialTiktokLike(accountId: string, cookies: any[], videoUrl: string, proxySessionId?: string, country?: string): Promise<any> {
    return this.request('POST', '/social/tiktok/like', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, video_url: videoUrl })
  }

  async socialTiktokDelete(accountId: string, cookies: any[], videoUrl: string, proxySessionId?: string, country?: string): Promise<any> {
    return this.request('POST', '/social/tiktok/delete', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, video_url: videoUrl })
  }

  async socialTiktokProfile(
    accountId: string,
    cookies: any[],
    patch: { bio?: string; display_name?: string },
    proxySessionId?: string,
    country?: string,
  ): Promise<any> {
    return this.request('POST', '/social/tiktok/profile', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, ...patch })
  }

  async socialTiktokAvatar(
    accountId: string,
    cookies: any[],
    image: { image_base64?: string; image_url?: string },
    proxySessionId?: string,
    country?: string,
  ): Promise<any> {
    return this.request('POST', '/social/tiktok/avatar', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies, ...image })
  }

  async socialTiktokAnalytics(accountId: string, cookies: any[], proxySessionId?: string, country?: string): Promise<any> {
    return this.request('POST', '/social/tiktok/analytics', { account_id: accountId, proxy_session_id: proxySessionId, country, cookies })
  }

  /**
   * Stored per-post engagement history the server accumulated from past
   * analytics runs. Pass videoId for one video's full series, hours for
   * per-video growth over a window, or neither for the latest sample of each.
   */
  async socialTiktokSeries(accountId: string, opts: { videoId?: string; hours?: number } = {}): Promise<any> {
    const q = new URLSearchParams({ account_id: accountId })
    if (opts.videoId) q.set('video_id', opts.videoId)
    if (opts.hours) q.set('hours', String(opts.hours))
    return this.request('GET', `/social/tiktok/series?${q.toString()}`)
  }

  /**
   * Which caption openings earn views, measured against each account's OWN
   * median. Scope by accountId, or by tag to pool a niche across the accounts
   * the wallet owns. Pass `caption` to classify a draft before posting.
   */
  async socialTiktokHooks(opts: { accountId?: string; tag?: string; niche?: string; caption?: string; maturityDays?: number; recencyDays?: number } = {}): Promise<any> {
    const q = new URLSearchParams()
    if (opts.accountId) q.set('account_id', opts.accountId)
    if (opts.tag) q.set('tag', opts.tag)
    if (opts.niche) q.set('niche', opts.niche)
    if (opts.caption) q.set('caption', opts.caption)
    if (opts.maturityDays !== undefined) q.set('maturity_days', String(opts.maturityDays))
    if (opts.recencyDays !== undefined) q.set('recency_days', String(opts.recencyDays))
    return this.request('GET', `/social/tiktok/hooks?${q.toString()}`)
  }

  /**
   * Upload a niche collection. ADMIN ONLY — the server refuses this without a
   * pool-admin signature, because collection costs real money upstream and
   * must never be triggerable by ordinary traffic.
   */
  async socialTiktokCorpusUpload(
    niche: string,
    collections: { query: string; posts: any[] }[],
    costUsdc: number,
    adminHeaders: Record<string, string>,
  ): Promise<any> {
    return this.requestWithHeaders('POST', '/social/tiktok/corpus', { niche, collections, cost_usdc: costUsdc }, adminHeaders)
  }

  /** Free: the niche list, with how fresh each corpus is. */
  async socialTiktokNiches(): Promise<any> {
    return this.request('GET', '/social/tiktok/niches')
  }

  /** Posts you have scheduled. Palmyr's own record — TikTok exposes no way to
   *  read pending posts back, so edits made in TikTok Studio are invisible. */
  async socialTiktokScheduled(opts: { accountId?: string; includeDone?: boolean } = {}): Promise<any> {
    const q = new URLSearchParams()
    if (opts.accountId) q.set('account_id', opts.accountId)
    if (opts.includeDone) q.set('include_done', '1')
    const qs = q.toString()
    return this.request('GET', `/social/tiktok/scheduled${qs ? `?${qs}` : ''}`)
  }

  /** Cancel a scheduled post by deleting the held video (TikTok has no
   *  "unschedule"). Async: returns an operation to poll. */
  async socialTiktokCancelScheduled(operationId: string, accountId: string, cookies: any[], proxySessionId?: string, country?: string): Promise<any> {
    return this.request('POST', `/social/tiktok/scheduled/${encodeURIComponent(operationId)}/cancel`,
      { account_id: accountId, cookies, proxy_session_id: proxySessionId, country })
  }

  // ── Info ──
  async pricing(): Promise<any> {
    return this.request('GET', '/pricing')
  }

  async health(): Promise<any> {
    return this.request('GET', '/health')
  }

  // ── i402 — intent layer for x402 ──

  /**
   * Generate an i402 plan from a natural-language intent.
   * Returns the plan body (from the 402 response) or a clarification request.
   * Auto-pays the $0.10 orchestration fee unless autoPay is disabled.
   */
  async chat(
    intent: string,
    options: {
      budgetUsdc: number
      quality?: 'fast' | 'cheap' | 'best'
      params?: Record<string, unknown>
      constraints?: {
        excludeCapabilities?: string[]
        excludeProviders?: string[]
        requireProviders?: string[]
      }
      sessionId?: string
      deadlineSeconds?: number
      approve?: boolean
      autoApproveUnderUsdc?: number
    },
  ): Promise<any> {
    const body: Record<string, unknown> = {
      intent,
      budget_usdc: options.budgetUsdc,
    }
    if (options.quality) body.quality = options.quality
    if (options.params) body.params = options.params
    if (options.constraints) body.constraints = options.constraints
    if (options.deadlineSeconds) body.deadline_seconds = options.deadlineSeconds
    if (options.approve !== undefined) body.approve = options.approve
    if (options.autoApproveUnderUsdc !== undefined) body.auto_approve_under_usdc = options.autoApproveUnderUsdc

    const extraHeaders: Record<string, string> = {}
    if (options.sessionId) extraHeaders['X-Session-Id'] = options.sessionId

    return this.requestWithHeaders('POST', '/chat', body, extraHeaders)
  }

  /**
   * Client-side executor for an i402 plan.
   *
   * i402 v0.1 is agent-side-execution-only: the server returns a plan and stops;
   * this function iterates the plan's steps in topological order, signs a real
   * x402 payment for each step (via paidRequest), calls the endpoint, resolves
   * $STEPS.sN.output.field references into later-step inputs locally, and yields
   * events to the caller so a CLI or agent framework can render progress.
   *
   * Every step's x402 payment is a real on-chain transaction signed by this
   * client's wallet — no server-side escrow, no custodial proxy.
   *
   * Usage:
   *   const plan = await ao.chat("launch a brand", { budgetUsdc: 60 })
   *   for await (const event of ao.chatExecute(plan)) {
   *     console.log(event.type, event)
   *   }
   */
  async *chatExecute(
    plan: any,
    options: { stopOnFailure?: boolean; maxUsdc?: number } = {},
  ): AsyncGenerator<any, void, undefined> {
    if (!plan?.plan_id || !Array.isArray(plan?.steps)) {
      throw new Error('chatExecute requires a plan returned from chat()')
    }
    const stopOnFailure = options.stopOnFailure !== false

    // Resolve the global per-call spend ceiling once (flag/option wins, else
    // PALMYR_MAX_USDC env, else none). Every step's payment is additionally
    // capped at its own quoted cost + a small tolerance below, so a single
    // compromised step can't drain the wallet even if it sits under the global
    // ceiling. Tolerance absorbs benign rounding / minor server-side price
    // drift between planning and execution without rejecting honest charges.
    const { resolveSpendCeiling } = await import('./pay.js')
    const globalCeiling = resolveSpendCeiling(options.maxUsdc)
    const STEP_COST_TOLERANCE_USDC = 0.001

    yield { type: 'session', sessionId: plan.session_id }
    yield {
      type: 'plan',
      planId: plan.plan_id,
      steps: plan.steps.map((s: any) => ({
        stepId: s.step_id,
        provider: s.provider,
        capability: s.capability,
        costUsdc: s.cost_usdc,
      })),
      totalCostUsdc: plan.totals?.total_cost_usdc,
    }

    const ordered = topoOrderSteps(plan.steps)
    const priorOutputs: Record<string, any> = {}
    let encounteredFatal = false
    let totalSpent = 0

    const { paidRequest } = await import('./pay.js')

    for (const step of ordered) {
      const resolvedInput = resolveStepInput(step.input, priorOutputs)

      yield {
        type: 'step_start',
        stepId: step.step_id,
        provider: step.provider,
        capability: step.capability,
        costUsdc: step.cost_usdc,
      }

      const startMs = Date.now()
      try {
        // For social steps, ensure a vault session and replace handle/inject
        // cookies BEFORE path-param substitution. Credentials only ever live
        // in this local body — they never enter step.input or any persisted
        // plan/session record.
        let injectedInput: Record<string, any> = resolvedInput as Record<string, any>
        const platform = socialPlatformForCapability(step.capability)
        if (platform) {
          const url0 = new URL(step.x402?.endpoint ?? '')
          const apiBase = `${url0.protocol}//${url0.host}`
          const gen = injectSocialCredentials({
            platform,
            capability: step.capability,
            resolvedInput: resolvedInput as Record<string, any>,
            api: apiBase,
            passphrase: this.passphrase,
          })
          while (true) {
            const next = await gen.next()
            if (next.done) {
              injectedInput = next.value
              break
            }
            // Surface session_refresh events to the caller and bill them.
            if (next.value?.type === 'session_refresh_done') {
              totalSpent += Number(next.value.costChargedUsdc ?? 0)
            }
            yield next.value
          }
        }

        // Email inboxes are owned by a Solana pubkey (Ed25519 → X25519 E2E). When
        // paying on Base the x402 payer is an EVM address the route can't use as
        // the owner, so inject the paying wallet's Solana address here — the same
        // auto-fill the standalone `email create` does.
        if (step.capability === 'provision_email_inbox' && injectedInput && typeof injectedInput === 'object' && !injectedInput.walletAddress) {
          const sol = await this.resolvePayerSolanaAddress()
          if (sol) injectedInput.walletAddress = sol
        }

        // Substitute {placeholder} path params from input → concrete URL + pruned body
        const { url: concreteUrl, body: postBody } = substitutePathParams(
          step.x402?.endpoint ?? '',
          injectedInput,
        )
        const url = new URL(concreteUrl)
        const path = url.pathname + url.search
        const api = `${url.protocol}//${url.host}`
        const method = (step.x402?.method ?? 'POST').toUpperCase()

        // Per-step spend ceiling = min(global ceiling, this step's quoted cost
        // + tolerance). paidRequest enforces this BEFORE signing: if the step's
        // live 402 advertises more than its planned cost (beyond tolerance), or
        // more than the global ceiling, it aborts without paying. This is the
        // per-step guard against a malicious/misconfigured endpoint charging
        // more than the plan quoted the agent.
        const quoted = Number(step.cost_usdc ?? 0)
        const isDynamic = DYNAMIC_PRICED_CAPABILITIES.has(step.capability)
        // Dynamic-priced steps (register_domain per-TLD, deploy_vps per-type)
        // can't be bounded by the planner's static quote — the real 402 is the
        // truth (e.g. a .io domain quoted at $10 actually settles at ~$44). Bound
        // them by the global ceiling only; every other step stays capped at its
        // quote + tolerance so a rogue endpoint still can't overcharge.
        const quotedCeiling = (quoted > 0 && !isDynamic) ? quoted + STEP_COST_TOLERANCE_USDC : undefined
        let stepCeiling: number | undefined
        if (quotedCeiling !== undefined && globalCeiling !== undefined) {
          stepCeiling = Math.min(quotedCeiling, globalCeiling)
        } else {
          stepCeiling = quotedCeiling ?? globalCeiling
        }

        const result = await paidRequest(api, method, path, postBody, this.passphrase, 1, { maxUsdc: stepCeiling })
        totalSpent += Number(step.cost_usdc ?? 0)
        let output = result.data

        // Async-operation envelope (202 + poll_url): the step's real result isn't
        // ready yet (domain registration, VPS provisioning, etc.). Poll the
        // operation to a terminal state so downstream steps resolve against the
        // resource fields, not the operation handle — fixing the domain→inbox
        // race where the next step 403s on a not-yet-registered name.
        //
        // The poll endpoint may be FREE (TikTok ops) or PAID + owner-gated
        // (/domains/operations/:id is $0.01, the fee doubling as the owner proof;
        // /compute/servers/:id needs an ownership proof). Poll via this.request,
        // which auto-pays the 402 from the same owner wallet — the exact path the
        // standalone `domain buy` poll uses. A bare GET would get a 402 and look
        // like the operation failed. Free polls return 200 and pay nothing.
        if (isAsyncEnvelope(output)) {
          let pollPath = String(output.poll_url)
          if (/^https?:/i.test(pollPath)) { const u = new URL(pollPath); pollPath = u.pathname + u.search }
          const intervalMs = Math.max(1, Number(output.poll_after_seconds) || 5) * 1000
          // 120s was below what the work actually takes: a TikTok post runs 2-5
          // minutes of browser automation, so the executor gave up on ops that
          // were still going and aborted a plan the caller had already paid
          // for. The standalone CLI poller settled on ~6 min from watching real
          // runs; match it, and let a service ask for longer if it knows better.
          const hintedTimeoutMs = Number(output.poll_timeout_seconds) * 1000
          const timeoutMs = Number.isFinite(hintedTimeoutMs) && hintedTimeoutMs > 0 ? hintedTimeoutMs : 360_000
          const deadline = Date.now() + timeoutMs
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
          yield { type: 'step_poll', stepId: step.step_id, provider: step.provider, operationId: output.operation_id, status: output.status ?? 'pending' }
          let finalOp: any = null
          while (Date.now() < deadline) {
            await sleep(intervalMs)
            let op: any
            try {
              op = await this.request('GET', pollPath)
            } catch {
              yield { type: 'step_poll', stepId: step.step_id, provider: step.provider, operationId: output.operation_id, status: 'poll_error' }
              continue
            }
            const state = operationState(op)
            yield { type: 'step_poll', stepId: step.step_id, provider: step.provider, operationId: output.operation_id, status: op?.status ?? 'pending' }
            if (state === 'ok') { finalOp = op; break }
            if (state === 'failed') throw new Error(`async operation ${output.operation_id ?? ''} failed: ${op?.error || op?.message || op?.status || 'unknown'}`)
          }
          if (!finalOp) throw new Error(`async operation ${output.operation_id ?? ''} did not finish within ${Math.round(timeoutMs / 1000)}s — it may still be running; re-check ${output.poll_url}`)
          output = mergeOperationResult(output, finalOp)
        }

        const latencyMs = Date.now() - startMs
        priorOutputs[step.step_id] = output

        // After buying a pooled X account, persist it to the local social vault
        // so later rebrand/post steps in the SAME plan can resolve its handle —
        // injectSocialCredentials only reads the local vault, so without this the
        // buy → rebrand chain breaks with "account not in local vault".
        if (step.capability === 'twitter_buy_account' && output?.account?.username) {
          try {
            const sv = await import('./social-vault.js')
            const a = output.account
            if (!sv.getAccount('twitter', a.username)) {
              const ct0 = Array.isArray(a.cookies) ? a.cookies.find((c: any) => c?.name === 'ct0')?.value : undefined
              const summary = sv.importAccount('twitter', a.username, {
                login: a.credentials?.login || a.credentials?.email || a.username,
                password: a.credentials?.password,
                email: a.credentials?.email,
                auth_token: a.credentials?.auth_token,
                ct0,
              }, { source: 'i402-buy', proxy_session_id: a.proxy_session_id, country: a.country || undefined })
              if (Array.isArray(a.cookies) && a.cookies.length > 0) sv.saveSession(summary.id, 'twitter', a.cookies)
            }
          } catch { /* non-fatal: the rebrand step will surface a clear vault error if this didn't take */ }
        }

        yield {
          type: 'step_result',
          stepId: step.step_id,
          provider: step.provider,
          output,
          latencyMs,
          costChargedUsdc: step.cost_usdc,
          txSignature: result.txHash,
        }
      } catch (err: any) {
        const latencyMs = Date.now() - startMs
        const message = err?.message ?? String(err)
        encounteredFatal = true
        yield {
          type: 'step_error',
          stepId: step.step_id,
          provider: step.provider,
          error: message,
          latencyMs,
          fatal: stopOnFailure,
        }
        if (stopOnFailure) break
      }
    }

    yield {
      type: 'summary',
      spentUsdc: totalSpent,
      status: encounteredFatal ? 'failed' : 'completed',
    }
  }

  async chatGetSession(sessionId: string): Promise<any> {
    return this.request('GET', `/chat/${sessionId}`)
  }

  async chatCancel(sessionId: string): Promise<any> {
    return this.request('POST', `/chat/${sessionId}/cancel`)
  }

  async chatListSessions(): Promise<any> {
    return this.request('GET', '/chat')
  }

  async chatListCapabilities(): Promise<any> {
    return this.request('GET', '/chat/capabilities')
  }

  async chatListProviders(capability?: string): Promise<any> {
    const qs = capability ? `?capability=${encodeURIComponent(capability)}` : ''
    return this.request('GET', `/chat/providers${qs}`)
  }

  // ── Internal: variant of request() that supports extra headers ──
  private async requestWithHeaders(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    const opts: RequestInit = { method, headers }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(this.api + path, opts)

    const contentType = res.headers.get('content-type') || ''
    let data: any
    if (contentType.includes('application/json')) {
      data = await res.json().catch(() => ({}))
    } else {
      data = {}
    }

    if (res.status === 402 && this.autoPay) {
      try {
        const { paidRequest } = await import('./pay.js')
        const result = await paidRequest(this.api, method, path, body, this.passphrase)
        return result.data
      } catch (e: any) {
        throw new Error(e.message)
      }
    }

    if (data.error && res.status >= 400) throw new Error(data.error)
    return data
  }
}

export default Palmyr
