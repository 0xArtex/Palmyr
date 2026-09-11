import agentGraphRoute from "./routes/agent-graph";
import agentLeaderboardRoute from "./routes/agent-leaderboard";
import agentBackupRoute from "./routes/agent-backup";
import agentWorkflowsRoutes from "./routes/agent-workflows";
import apiMapRoute from "./routes/api-map";
import agentActivityRoutes from "./routes/agent-activity";
import serviceHealthRouter from "./routes/service-health";
import dashboardRoutes from "./routes/dashboard";
import alertsRouter from "./routes/alerts";
import agentScoreRoutes from "./routes/agent-score";
import express from "express";
import path from "path";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import "./db"; // Initialize database
import { DATA_DIR, db } from "./db";
import { classifyAgent } from "./utils/agent-classifier";
import { storage } from "./services/storage";
import phoneRoutes from "./routes/phone";
import emailRoutes from "./routes/email";
import socialRoutes from "./routes/social";
import marketRoutes from "./routes/market";
import domainRoutes from "./routes/domains";
import xAccountRoutes from "./routes/xaccounts";
import skillsRoutes from "./routes/skills";
import computeRoutes from "./routes/compute";
import webhookRoutes from "./routes/webhooks";
import agentRoutes from "./routes/agents";
import statsRoutes from "./routes/stats";
import telemetryRoutes from "./routes/telemetry";
import messageRoutes from "./routes/messages";
import agentToolkitRouter from "./routes/agent-toolkit";
import whyRouter from "./routes/why";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import agentNetworkRouter from "./routes/agent-network";
import { requestLogger } from "./middleware/requestLog";
import { cors } from "./middleware/cors";
import { requestTimeout, isTimeoutExempt } from "./middleware/timeout";
import { rateLimit } from "./middleware/rateLimit";
import { securityHeaders, paramPollution, sqlInjectionGuard, sanitizeInputs, bruteForceProtection } from "./middleware/security";
import activityRoutes from "./routes/activity";
import analyticsRoutes from "./routes/analytics";
import changelogRoutes from "./routes/changelog";
import reputationRoutes from "./routes/reputation";
import statusRoutes from "./routes/status";
import usecasesRoutes from "./routes/usecases";
import faqRoutes from "./routes/faq";
import { getHealth, getVersion } from "./utils/health";
import compatibilityRoutes from "./routes/compatibility";
import eventsRoutes from "./routes/events";
import templatesRoutes from "./routes/templates";
import logsRoutes from "./routes/logs";
import metricsRoutes from "./routes/metrics";
import agentManifestRoutes from "./routes/agent-manifest";
import {
  createTikTokCompatibilityProxy,
  mountTikTokServiceDiscovery,
  tiktokCanonicalAlias,
  tiktokHostIsolation,
} from "./middleware/tiktok-service";


const app = express();

// tiktok.palmyr.ai owns the stable /v1 contract. Rewrite it before body-size
// and timeout classification so the existing runtime keeps its proven media
// limits and browser-operation exemptions during extraction.
app.use(tiktokCanonicalAlias);

// gzip JSON + JS + CSS + HTML responses. WebP/MP4/PNG are skipped by the
// default `compressible` filter so already-compressed bytes don't get re-run.
import compression from "compression";
// Exempt /mcp from compression: the MCP Streamable HTTP transport can stream
// responses, and buffering them through gzip breaks streaming (and the
// Cloudflare tunnel). enableJsonResponse keeps replies plain JSON, but skipping
// compression here is belt-and-suspenders.
app.use(compression({ filter: (req, res) => !req.path.startsWith("/mcp") && compression.filter(req, res) }));

app.use(securityHeaders);
app.use(paramPollution);
// Social image-upload endpoints transfer up to ~10 MB of base64 image data;
// TikTok video uploads can hit ~100 MB (base64 is ~1.33× the raw bytes).
// Everything else stays on the security-tight 100 KB default.
const IMAGE_UPLOAD_ROUTES = new Set([
  "/social/twitter/avatar",
  "/social/twitter/banner",
  "/social/twitter/deploy",
  "/social/tiktok/avatar",
  // Buy carries the new account's avatar inline (image_base64) for the on-the-spot
  // rebrand, same tier as the standalone avatar op.
  "/social/tiktok/buy",
]);
const VIDEO_UPLOAD_ROUTES = new Set([
  "/social/tiktok/post",
  // X media routes accept 1-4 images OR 1 video — use the video tier so video
  // uploads aren't capped at 15 MB. Direct + scheduled both pass payload over
  // base64 so the wire size is ~1.33× the raw media bytes.
  "/social/twitter/post-media",
  "/social/scheduled/media",
]);
app.use((req, res, next) => {
  // Express is non-strict by default, so /social/twitter/post-media/ (trailing
  // slash) still hits the handler — normalize it before the Set lookup so the
  // upload tier isn't silently downgraded to 100kb and 413'd.
  const p = req.path.length > 1 && req.path.endsWith("/") ? req.path.slice(0, -1) : req.path;
  const limit = p === "/mcp"
    ? "1mb" // MCP JSON-RPC (tool calls with modest payloads); above the 100kb default, below the media tiers
    : VIDEO_UPLOAD_ROUTES.has(p)
    ? "150mb"
    : IMAGE_UPLOAD_ROUTES.has(p)
      ? "15mb"
      : "100kb";
  // Capture the exact request bytes so Ed25519/HMAC webhook verifiers (Telnyx
  // `${timestamp}|${rawBody}`) can prove authenticity — the parsed body does
  // NOT round-trip through JSON.stringify for real provider payloads, so
  // without this every signed webhook silently fails verification. Cheap: the
  // buffer is already in memory during parsing.
  return express.json({
    limit,
    verify: (r: any, _res, buf: Buffer) => { r.rawBody = buf; },
  })(req, res, next);
});

app.use(cors);
app.use(sanitizeInputs);
app.use(sqlInjectionGuard);
app.use(bruteForceProtection);

// Wallet routes BEFORE timeout (on-chain signing can take 60s+)
// Vault directories are created lazily on first write (see ensureVault in wallet-vault.ts)
import walletRoutes from "./routes/wallet";
import walletPasskeyRoutes from "./routes/wallet-passkey";
// These mounts sit BEFORE the global rate limiter (added later) so that the
// timeout exemption for slow on-chain signing applies — but that left the
// sensitive wallet endpoints (key derivation, message/tx signing, API-key
// minting, managed-wallet registration, passkey ops) with NO rate cap. Attach
// an explicit, stricter limiter here so they can't be hammered / brute-probed.
app.use("/wallet", rateLimit(60, 60_000));
app.use("/wallet", walletRoutes);
app.use("/wallet", walletPasskeyRoutes);

// Social routes run a headless browser and can legitimately take 60-90s
// through a residential proxy. /chat (i402) streams multi-step plan execution
// which can run 10-30 minutes for compound outcomes like a product launch.
// /domains/register blocks on Namecheap (availability + balance preflight, then
// the actual registration), which can exceed 30s — killing it mid-flight after
// x402 settlement would charge the payer for a registration that never lands.
// /phone/numbers/:id/wait-otp (and ONLY that phone route) blocks up to 90s by
// design — a 30s 408 would fire AFTER x402 settlement and drop a verification
// code the payer already paid for. Skip the default 30s timeout for these
// slow synchronous ops (predicate lives in middleware/timeout.ts so tests can
// pin the list).
app.use((req, res, next) => {
  if (isTimeoutExempt(req.path)) {
    return next();
  }
  return requestTimeout(30_000)(req, res, next);
});

// Discovery endpoints (well-known + openapi) mounted BEFORE the global rate
// limiter so x402scan / Bazaar crawlers can probe them without 429s. Their
// handlers introspect the live router stack, so they reflect any route
// registered later in this file.
import { mountDiscoveryRoutes } from "./routes/well-known";
mountTikTokServiceDiscovery(app);
mountDiscoveryRoutes(app);
// The two products share a process during migration, not a public route
// surface. TikTok discovery handlers run above; this guard admits only its
// explicit /v1 contract and QR hand-off before Palmyr's other routes mount.
app.use(tiktokHostIsolation);

app.use(rateLimit(200, 60_000));
app.use(requestLogger);

// ── Static files (landing page) ──────────────────────────────
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Landing page ─────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));

});
// ── API info (moved from GET /) ──────────────────────────────
// Single machine entry point. Deliberately does NOT hand-enumerate services
// (that list always drifts) — it links to the generated, drift-free surfaces.
// The full, live, x402-priced route list lives in /openapi.json (built by
// walking the router) and /.well-known/x402.
import { enumeratePaidRoutes } from "./services/route-discovery";
app.get("/api", (req, res) => {
  const host = req.get("host") || "palmyr.ai";
  const base = `https://${host}`;
  res.json({
    service: "Palmyr",
    description: "Autonomous infrastructure for AI agents — pay with USDC on Solana or Base via x402.",
    version: getVersion().version,
    status: "operational",
    identity: "Your wallet is your identity. Pay via x402; the wallet that pays owns the resource.",
    discovery: {
      openapi: `${base}/openapi.json`,
      x402: `${base}/.well-known/x402`,
      pricing: `${base}/pricing`,
      agent_guide: `${base}/skill.md`,
    },
    paid_routes: enumeratePaidRoutes(app).length,
  });

});
import healthRouter from "./routes/health"; app.use("/health", healthRouter);

// ── Ping aliases ─────────────────────────────────────────────
// /ping and /api/ping existed pre-launch and external uptime monitors may
// still point at them. Alias both to the same real liveness data as
// /health/ping — actual process state only, no synthetic latency/region.
const pingHandler = (_req: express.Request, res: express.Response) => {
  res.json({ status: "ok", uptime_seconds: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
};
app.get("/ping", pingHandler);
app.get("/api/ping", pingHandler);

// ── Version endpoint ─────────────────────────────────────────
app.get("/version", (_req, res) => {
  res.json(getVersion());

});
// ── TikTok connect QR hand-off page (public, unauthenticated) ──
// A human opens /connect/<token> to scan the login QR an agent forwarded them.
// READ-ONLY by design: `:token` is the public read token, so these routes only
// ever render/return the current QR + status. Replacing the QR requires the
// separate writer credential on POST /social/tiktok/qr (see qr-handoff.ts) — the
// forwarded link is never a write capability, which blocks QR-swap takeover.
import { getQrSession, renderQrPage, renderExpiredPage } from "./services/qr-handoff";
import { noteConnectViewer } from "./services/tiktok-server-connect";
import { clientCountry } from "./middleware/client-ip";
import { warnIfSelfHosted } from "./services/self-hosted";
app.get("/connect/:token", (req, res) => {
  const sess = getQrSession(req.params.token);
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store");
  // A server-side login waits for this moment before starting its browser, so
  // the exit country can be matched to whoever is about to scan. TikTok weighs
  // the distance between the scanning phone and the browser being authorised —
  // that gap is the signature of a QR phishing attack — so a login on the wrong
  // continent is refused outright. Reading the country here means nobody has to
  // know it in advance. Harmless for a locally-driven QR relay: no run exists
  // under that token, and this returns immediately.
  if (sess) noteConnectViewer(req.params.token, clientCountry(req));
  // Render the page for any live session (even before the QR renders — it polls
  // and fills in); only an unknown/expired token gets the expired page.
  res.status(sess ? 200 : 404).send(sess ? renderQrPage(req.params.token) : renderExpiredPage());
});
// The page polls this to live-refresh the (rotating) QR + show completion.
app.get("/connect/:token/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  const sess = getQrSession(req.params.token);
  if (!sess) { res.status(404).json({ state: "expired", qr: null }); return; }
  res.json(sess);
});

// ── API Documentation ─────────────────────────────────────────
// Swagger UI renders the SAME generated spec served at /openapi.json
// (buildOpenApiDoc walks the live router), so /docs can never drift from the
// real, x402-priced surface. Pointing the UI at the URL keeps a single source
// of truth instead of a hand-maintained spec.
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(undefined, { swaggerOptions: { url: "/openapi.json" } }),
);

// ── Dashboard session resolution (global) ────────────────────
import { resolveDashboardSession } from "./middleware/dashboard-session";
app.use(resolveDashboardSession as any);

// ── Routes ────────────────────────────────────────────────────
app.use("/phone", phoneRoutes);
app.use("/email", emailRoutes);
// Palmyr compatibility boundary: when TIKTOK_SERVICE_ORIGIN is set, only the
// explicitly versioned public routes cross into the TikTok service. This runs
// before Palmyr's own social/x402 handlers, so settlement happens exactly once
// at the canonical service and its challenge/receipt pass through unchanged.
app.use(createTikTokCompatibilityProxy({ origin: config.tiktokServiceOrigin }));
app.use("/social", socialRoutes);
app.use("/market", marketRoutes);
app.use("/x", xAccountRoutes);
app.use("/skills", skillsRoutes);
app.use("/domains", domainRoutes);
app.use("/compute", computeRoutes);
// Prepaid Visa cards (Laso Finance upstream) — buy with exact balance via
// dynamic x402 pricing; async 202+poll; PAN/CVV encrypted at rest.
import cardsRoutes from "./routes/cards";
app.use("/cards", cardsRoutes);
import transfersRoutes from "./routes/transfers";
app.use("/transfers", transfersRoutes);
import agentChatRoutes from "./routes/agent-chat";
app.use("/chat", agentChatRoutes);
// Hosted MCP server — curated Palmyr capabilities as x402-paid MCP tools, plus
// the registry domain-verification well-known for the ai.palmyr namespace.
import mcpRoutes, { mcpRegistryAuthRouter } from "./routes/mcp";
app.use("/mcp", mcpRoutes);
app.use(mcpRegistryAuthRouter);
// Agent Skills discovery (/.well-known/agent-skills/index.json) + hosted skill
// references (/skill/references/:name) — enables `npx skills add https://palmyr.ai`.
import agentSkillsRoutes from "./routes/agent-skills";
app.use(agentSkillsRoutes);
import discoveryRoutes from "./routes/discovery";
app.use("/api/discovery", discoveryRoutes);
// /discover (legacy server-rendered HTML) → /discovery (new React-built SPA).
app.get("/discover", (_req, res) => res.redirect(301, "/discovery"));
app.get("/discovery", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "discovery", "index.html"))
);
// /socials — one-click TikTok account storefront (deploy from the warmed pool).
app.get("/socials", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "socials.html"))
);
import provisionRoutes from "./routes/provision";
app.use("/provision", provisionRoutes);
// wallet routes proxied to port 3002 (see above, before timeout middleware)
import dashboardAuthRoutes from "./routes/dashboard-auth";
app.use("/auth", dashboardAuthRoutes);
import balanceRoutes from "./routes/balance";
app.use("/balance", balanceRoutes);
import projectRoutes from "./routes/projects";
app.use("/projects", projectRoutes);

// ── Agent Management (free) ──────────────────────────────────
app.use("/agents", agentRoutes);

// ── Platform Stats (free) ────────────────────────────────────
app.use("/stats", statsRoutes);

// ── Opt-in CLI telemetry (free, no auth) ─────────────────────
app.use("/telemetry", telemetryRoutes);

// ── Agent Messaging (free) ───────────────────────────────────
app.use("/messages", messageRoutes);

// ── Activity Feed (free) ─────────────────────────────────────
app.use("/activity", activityRoutes);
app.use("/analytics", analyticsRoutes);

// ── Webhook Routes (no x402 payment, for provider callbacks) ─
app.use("/webhooks", webhookRoutes);
app.use("/api/why", whyRouter);

// ── Pricing info (no auth required) ──────────────────────────
// Generated from the live paid-route registry (route-discovery walks the
// router), so it can NEVER drift from the actual x402 prices the way the old
// hand-maintained map did. Dynamically-priced routes (e.g. per-TLD domain
// registration) report "dynamic" — hit the route's 402 challenge for the exact
// amount. Treasury addresses come from config so wallet rotation is env-only.
app.get("/pricing", (req, res) => {
  const host = req.get("host") || "palmyr.ai";
  const routes = enumeratePaidRoutes(app).map((r) => {
    const meta: any = r.metadata || {};
    // A route is "dynamic" if it explicitly flags it (forward-compatible with a
    // future PaidRoute.dynamicPrice) or its description says so — the advertised
    // priceUsdc is then only a representative figure, not the charged amount.
    const isDynamic =
      (r as any).dynamicPrice === true ||
      /\bdynamic(ally)?\b/i.test(meta.description || "");
    return {
      method: r.method,
      path: r.path,
      price_usdc: isDynamic ? "dynamic" : r.priceUsdc,
      ...(isDynamic ? { price_note: "Exact amount returned in the route's 402 challenge." } : {}),
      description: meta.description || `${r.method} ${r.path}`,
      ...(meta.category ? { category: meta.category } : {}),
    };
  });
  res.json({
    currency: "USDC",
    networks: ["solana", "base"],
    auth: "Your wallet is your identity. Pay via x402 — your wallet address owns the resource.",
    note: "Generated from the live route registry; see /openapi.json for the full machine-readable spec.",
    routes,
    treasury: {
      solana: config.treasuryWallet,
      base: config.treasuryEvmWallet,
    },
    docs: `https://${host}/skill.md`,
  });

});
// ── Skill documentation for agents ───────────────────────────
// Previously a 35-byte broken stub at public/skill.md was intercepting this
// route via express.static — agents fetching palmyr.ai/skill.md got a path
// string instead of the actual skill. Stub removed; handler now actually runs.
app.get("/skill.md", (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const skillPath = path.join(__dirname, '..', 'skills', 'palmyr', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    res.status(404).send('# skill.md not found');
    return;
  }
  // Log who's pulling the skill — agent attribution for marketing. Never
  // blocks the response on failure.
  try {
    const ua = (req.headers['user-agent'] as string | undefined) || null;
    const rawReferer = req.headers['referer'] || req.headers['referrer'] || null;
    const referer = Array.isArray(rawReferer) ? rawReferer[0] : (rawReferer as string | null);
    db.prepare(
      `INSERT INTO skill_fetches (source, user_agent, agent_kind, referer)
       VALUES (?, ?, ?, ?)`
    ).run(
      'skill.md',
      ua ? ua.slice(0, 512) : null,
      classifyAgent(ua),
      referer ? referer.slice(0, 512) : null,
    );
  } catch {}
  res.setHeader('Content-Type', 'text/markdown');
  res.send(fs.readFileSync(skillPath, 'utf-8'));
});
// ── Changelog ─────────────────────────────────────────────
app.use("/api/use-cases", usecasesRoutes);
app.use("/changelog", changelogRoutes);
app.use("/status", statusRoutes);
app.use("/api/compatibility", compatibilityRoutes);
app.use("/api/faq", faqRoutes);
app.use("/api/events", eventsRoutes);
app.use("/api/templates", templatesRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/metrics", metricsRoutes);
import verifyRouter from "./routes/verify";
import whoamiRouter from "./routes/whoami";
import feedbackRouter from "./routes/feedback";
app.use("/api/agents/verify", verifyRouter);
app.use("/api/whoami", whoamiRouter);
app.use("/api/feedback", feedbackRouter);

// ── Error handling ────────────────────────────────────────────
// ── Deep health check ────────────────────────────────────────
app.get("/health/deep", (_req, res) => {
  // Public + unauthenticated: keep it to liveness only. Host system internals
  // (CPU count, load average, free/total memory) let an attacker fingerprint
  // the box and time a DoS, so they are deliberately NOT exposed here. The
  // stale hackathon "FREE" block was also removed (the event is long over).
  const uptimeS = Math.floor(process.uptime());
  res.json({
    status: "healthy",
    version: getVersion().version,
    uptime: { seconds: uptimeS, human: `${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m ${uptimeS%60}s` },
  });

});
app.use("/api/alerts", alertsRouter);
app.use("/api/agents/reputation", reputationRoutes);
app.use("/api/dashboard", dashboardRoutes);
import configRouter from "./routes/config";
app.use("/api/config", configRouter);
import demoRequestRouter from "./routes/demo-request";
app.use("/api/demo-request", demoRequestRouter);
app.use("/api/agent-workflows", agentWorkflowsRoutes);

app.use("/api/agent-score", agentScoreRoutes);
// /api/wallet → same wallet routes
app.use("/api/wallet", walletRoutes);
app.use("/api/wallet", walletPasskeyRoutes);
import agentProfileRouter from "./routes/agent-profile";
import agentDirectoryRouter from "./routes/agent-directory";
app.use("/api/agent-profile", agentProfileRouter);
app.use("/api/agent-directory", agentDirectoryRouter);
import debugRouter from "./routes/debug";
import invoiceRouter from "./routes/invoice";
import webhooksRouter from "./routes/webhooks";
app.use("/api/debug", debugRouter);
app.use("/api/invoice", invoiceRouter);
app.use("/api/webhooks", webhooksRouter);
import systemMetricsRouter from "./routes/system-metrics";
import architectureRoute from "./routes/architecture";
app.use("/api/system-metrics", systemMetricsRouter);
app.use("/api/agent-toolkit", agentToolkitRouter);
app.use("/api", serviceHealthRouter);
app.use("/api/architecture", architectureRoute);
import systemHealthRoute from "./routes/system-health";
app.use("/api/system-health", systemHealthRoute);
app.use("/api/agent-activity", agentActivityRoutes);
app.use(apiMapRoute);
import agentRatingRoute from "./routes/agent-rating";
app.use("/api/agent-rating", agentRatingRoute);
import healthMonitorRoute from "./routes/health-monitor";
app.use("/api/health-monitor", healthMonitorRoute);
import agentTasksRoute from "./routes/agent-tasks";
app.use("/api/tasks", agentTasksRoute);
import agentNotificationsRoute from "./routes/agent-notifications";
app.use("/api/notifications", agentNotificationsRoute);
import agentCommsRoute from "./routes/agent-comms";app.use("/api/agent-comms", agentCommsRoute);
import agentEscrowRoute from "./routes/agent-escrow";
import agentWebhooksRoute from "./routes/agent-webhooks"; app.use("/api/agent-webhooks", agentWebhooksRoute);
app.use("/api/agent-escrow", agentEscrowRoute);
import agentQueueRoute from "./routes/agent-queue";
app.use("/api/queue", agentQueueRoute);
import agentDashboardRoute from "./routes/agent-dashboard";app.use("/api/agent-dashboard", agentDashboardRoute);
import agentTemplatesRoute from "./routes/agent-templates";
app.use("/api/agent-templates", agentTemplatesRoute);
import agentBatchRoute from "./routes/agent-batch";app.use("/api/agent-batch", agentBatchRoute);
import agentStatsLiveRoute from "./routes/agent-stats-live";
import agentKanbanRoute from "./routes/agent-kanban";
app.use("/api/agent-kanban", agentKanbanRoute);
app.use("/api/agent-stats", agentStatsLiveRoute);
app.use("/api", agentManifestRoutes);
import agentAlertsRoute from "./routes/agent-alerts";
import agentIdentityRoute from "./routes/agent-identity";
app.use("/api/agent-alerts", agentAlertsRoute);
app.use("/api/agent-identity", agentIdentityRoute);
import agentSecretsRoute from "./routes/agent-secrets";
app.use("/api/agent-secrets", agentSecretsRoute);
import agentCronRoute from "./routes/agent-cron";
import agentEnvRouter from "./routes/agent-env";
app.use("/api/agent-env", agentEnvRouter);
app.use("/api/agent-cron", agentCronRoute);
app.use("/api/agent-backup", agentBackupRoute);
import agentBillingRoute from "./routes/agent-billing";
app.use("/api/agent-billing", agentBillingRoute);
import agentOnboardRoute from "./routes/agent-onboard"; app.use("/api/agent-onboard", agentOnboardRoute);
import agentConfigRoute from "./routes/agent-config";
import agentMetricsRoute from "./routes/agent-metrics";
app.use("/api/agent-config", agentConfigRoute);
app.use("/api/agent-metrics", agentMetricsRoute);
import agentSnapshotRoute from "./routes/agent-snapshot"; app.use(agentSnapshotRoute);
import agentChangelogRoute from "./routes/agent-changelog";
app.use("/api/agent-changelog", agentChangelogRoute);
import agentCompareRoute from "./routes/agent-compare";
app.use("/api/agent-compare", agentCompareRoute);
import agentQuicksetup from "./routes/agent-quicksetup";app.use("/api/quicksetup", agentQuicksetup);
app.use("/api/agent-leaderboard", agentLeaderboardRoute);
app.use("/api/agent-graph", agentGraphRoute);
import agentInboxRouter from "./routes/agent-inbox";
app.use("/api/inbox", agentInboxRouter);
// /api/search is served by agentSearchV2Router (mounted below) — the more
// complete impl (also searches logs + marketplace). A second router was
// previously also mounted here at /api/search and, registering first, shadowed
// v2 entirely; removed to keep a single canonical search handler.
app.use("/api/agent-network", agentNetworkRouter);
import agentPulseRouter from "./routes/agent-pulse";
app.use("/api/agent-pulse", agentPulseRouter);
import agentSearchV2Router from "./routes/agent-search-v2";
app.use("/api/search", agentSearchV2Router);
import agentDiscoveryRoute from "./routes/agent-discovery";
app.use("/api/agent-discovery", agentDiscoveryRoute);
import agentIntegrationTestRoute from "./routes/agent-integration-test";app.use("/api/agent-integration-test", agentIntegrationTestRoute);
import platformHealthRoute from "./routes/platform-health";app.use(platformHealthRoute);
// ── x402 Facilitator Proxy ────────────────────────────────────
app.all("/x402/*", async (req, res) => {
  try {
    const targetPath = req.path.replace("/x402", "");
    const targetUrl = `http://localhost:8090${targetPath}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (req.headers.authorization) headers["Authorization"] = req.headers.authorization as string;
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const data = await resp.text();
    res.status(resp.status).set("Content-Type", resp.headers.get("content-type") || "application/json").send(data);
  } catch (err: any) {
    res.status(502).json({ error: "Facilitator proxy error", message: err.message });
  }
});

app.use(notFoundHandler);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────
import { startDepositMonitor } from "./services/deposit-monitor";
import { startDomainRegistrationRecovery } from "./services/domain-registration";
import { startCardPurchaseRecovery } from "./services/card-purchases";
import { startTikTokPostRecovery } from "./services/tiktok-post-jobs";
import { startTikTokOpsRecovery } from "./services/tiktok-ops-jobs";
import { startXOpsRecovery } from "./services/x-ops-jobs";
import { seedPalmyrPrimitives } from "./services/i402-providers";
import { ensureProviderEmbeddings, embeddingsAvailable } from "./services/i402-embeddings";
import { refreshFederatedCatalogs } from "./services/i402-agentic-market";
import { refreshHcloudTypes } from "./services/hcloud-types";
import { startRefundRetryLoop } from "./services/refund";

async function refreshI402Federations(): Promise<void> {
  try {
    const results = await refreshFederatedCatalogs();
    for (const r of results) {
      console.log(
        `[i402] ingested ${r.source}: ${r.registered} registered, ${r.skipped_unknown_capability} skipped, ${r.errors.length} errors (of ${r.fetched} fetched)`
      );
      for (const err of r.errors.slice(0, 3)) console.warn(`   ⚠ ${err}`);
    }
  } catch (err: any) {
    console.warn("[i402] federated catalog refresh failed:", err?.message ?? err);
  }
}

app.listen(config.port, () => {
  startDepositMonitor();
  seedPalmyrPrimitives();
  // Server-side social-post scheduler — polls scheduled_social_posts and
  // fires due items via the same internal post functions used by the
  // direct-post routes. Disable with SOCIAL_SCHEDULER_DISABLED=1.
  void import("./services/social-scheduler").then(m => m.startSocialScheduler());
  // Pull live Hetzner server-type catalog so we never hardcode types that
  // get deprecated. Background refresh; falls back to a tiny static list if
  // the API is unreachable at boot.
  refreshHcloudTypes().catch(err =>
    console.warn("[hcloud-types] initial refresh failed:", err?.message ?? err)
  );
  // Drain any refunds that previously failed before broadcast (e.g. treasury
  // key was missing) — warns at boot when refunds can't work, retries hourly.
  startRefundRetryLoop();
  // Reconcile domain registrations left in-flight by a previous process — the
  // registrar tells us which completed (mark active) vs never registered (refund).
  startDomainRegistrationRecovery();
  // Reconcile async TikTok posts left in-flight by a previous process — pending
  // jobs (never published) refund; mid-publish jobs flag for manual review.
  startTikTokPostRecovery();
  // Fail+refund any TikTok follow/like/delete/profile/avatar ops orphaned by a
  // restart (safe to retry — no reconcile needed).
  startTikTokOpsRecovery();
  // Same for orphaned X avatar/banner ops.
  startXOpsRecovery();
  // Reconcile card purchases left in-flight by a previous process — the
  // on-chain EIP-3009 nonce + Laso's account state tell us which paid (adopt
  // the card / recover the balance) vs never paid (refund the agent).
  startCardPurchaseRecovery();
  // Enforce the VPS billing period: notify on lapse, power off after the idle
  // grace, then snapshot + destroy. Servers were sold as monthly but nothing
  // ever ended the period, so one deploy fee ran a box indefinitely.
  // PALMYR_VPS_LIFECYCLE_DISABLED=1 turns the whole sweep off.
  void import("./services/compute-lifecycle").then(m => m.startComputeLifecycle());
  if (embeddingsAvailable()) {
    // Non-blocking: compute any missing provider embeddings in the background.
    ensureProviderEmbeddings().catch(err =>
      console.warn("[i402] provider embedding ensure failed:", err?.message ?? err)
    );
  }
  // Initial federation pull + periodic refresh. Errors never crash the server.
  refreshI402Federations();
  const refreshMinutes = parseInt(process.env.I402_AGENTIC_MARKET_REFRESH_MINUTES ?? "60", 10);
  if (refreshMinutes > 0 && process.env.I402_AGENTIC_MARKET_CATALOG_URL) {
    setInterval(refreshI402Federations, refreshMinutes * 60 * 1000).unref();
  }
  // Hard-delete disposable temp inboxes 48h past their expiry — only hard
  // deletion frees the UNIQUE(address) slot so a tmp-* address can be recycled.
  // Hourly, unref'd so it never holds the process open. Errors never crash.
  setInterval(() => {
    try {
      const n = storage.deleteExpiredTempInboxes(48 * 3600);
      if (n > 0) console.log(`[email] swept ${n} expired temp inbox(es)`);
    } catch (err: any) {
      console.warn("[email] temp inbox sweep failed:", err?.message ?? err);
    }
  }, 60 * 60 * 1000).unref();
  // Hard-delete disposable temp phone leases 15min past expiry (the grace IS the
  // inter-lease quarantine that keeps a pooled number un-leasable until its dead
  // lease row is gone). Pure-DB — never calls Telnyx (pooled numbers stay on our
  // account). Hourly, unref'd; errors never crash.
  setInterval(() => {
    try {
      const n = storage.deleteExpiredTempPhoneLeases(15 * 60);
      if (n > 0) console.log(`[phone] swept ${n} expired temp lease(s) back to the pool`);
    } catch (err: any) {
      console.warn("[phone] temp lease sweep failed:", err?.message ?? err);
    }
  }, 60 * 60 * 1000).unref();
  console.log(`⚡ Palmyr running on port ${config.port}`);
  console.log(`   Treasury: ${config.treasuryWallet}`);
  console.log(`   Network:  Solana (${config.solanaRpcUrl})`);
  console.log(`   Email:    *@${config.emailDomain}`);
  if (config.tempEmailDomains.length && !(config.tempEmailDomains.length === 1 && config.tempEmailDomains[0] === config.emailDomain)) {
    console.log(`   Temp:     disposable inboxes on ${config.tempEmailDomains.join(", ")}`);
  }
  console.log(`   i402:     reference implementation wired at /chat`);
  warnIfSelfHosted();
});
export default app;
