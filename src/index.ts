#!/usr/bin/env node
// Agent Press Wire MCP server (stdio).
// Lets AI agents announce launches and distribute press releases via
// https://agentpresswire.dev, paying per call in USDC on Base over x402.
//
// Safety (all must hold before anything is signed):
//   X402_PRIVATE_KEY set, quoted price <= MAX_SPEND_USD (default 0 = quote only),
//   lifetime total <= MAX_TOTAL_SPEND_USD (persisted ledger), 402 terms match the pinned
//   payTo / price / asset / network, maxTimeoutSeconds <= 600, and a valid confirm_token
//   from a prior quote for the same endpoint and parameters.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentRequired, PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  NETWORK,
  USDC_BASE,
  PAY_TO,
  CONFIRM_TTL_MS,
  ConfirmTokens,
  atomicToUsd,
  checkPinnedTerms,
  checkTotalCap,
  ledgerPath,
  loadLedger,
  saveLedger,
  totalSpentAtomic,
  usdToAtomic,
  withLedgerLock,
  type LedgerEntry,
} from "./guard.js";

const VERSION = "0.1.1";
const BASE_URL = (process.env.PRESS_API_URL || "https://agentpresswire.dev").replace(/\/+$/, "");
const TIMEOUT_MS = 180_000;

function envUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
const maxSpendUsd = (): number => envUsd("MAX_SPEND_USD", 0);
/** Lifetime cap across all calls and restarts. Defaults to MAX_SPEND_USD (one paid call's worth). */
const maxTotalSpendUsd = (): number => envUsd("MAX_TOTAL_SPEND_USD", maxSpendUsd());

function walletKey(): `0x${string}` | null {
  const raw = (process.env.X402_PRIVATE_KEY || "").trim();
  if (!raw) return null;
  const k = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("X402_PRIVATE_KEY must be a 32-byte hex private key");
  return k as `0x${string}`;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (obj: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (obj: unknown): ToolResult => ({ ...ok(obj), isError: true });

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

function pickUsdcOnBase(pr: PaymentRequired): PaymentRequirements | undefined {
  return pr.accepts.find((r) => r.network === NETWORK && String(r.asset).toLowerCase() === USDC_BASE);
}

const tokens = new ConfirmTokens();

function updateLedgerEntry(nonce: string | null, ts: string, patch: Partial<LedgerEntry>): void {
  try {
    const l = loadLedger();
    const e = l.entries.find((x) => x.ts === ts && x.nonce === nonce);
    if (e) Object.assign(e, patch);
    saveLedger(l);
  } catch (err) {
    console.error(`could not update spend ledger: ${(err as Error).message}`);
  }
}

/**
 * POST to a paid endpoint. First call is always unpaid to read the 402 terms, which must match the
 * pinned payTo and price. Without a valid confirm_token (or with quote_only) it returns a quote and
 * a fresh confirm_token. With one, it pays only if every rail allows it.
 */
async function paidPost(
  path: string,
  body: Record<string, unknown>,
  quoteOnly: boolean,
  confirmToken: string | undefined,
): Promise<ToolResult> {
  const url = `${BASE_URL}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `agent-press-wire-mcp/${VERSION}` },
    body: JSON.stringify(body),
  };

  let first: Response;
  try {
    first = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return fail({ error: `network error calling ${url}: ${(e as Error).message}` });
  }
  if (first.status !== 402) {
    // Should not happen for a paid route; surface whatever the server said.
    return first.ok ? ok(await readBody(first)) : fail({ http_status: first.status, response: await readBody(first) });
  }

  // Parse x402 payment terms. Use a scheme-less client purely for decoding.
  const decoder = new x402HTTPClient(new x402Client());
  let terms: PaymentRequired;
  try {
    terms = decoder.getPaymentRequiredResponse((n) => first.headers.get(n), await readBody(first));
  } catch (e) {
    return fail({ error: `could not parse x402 payment terms: ${(e as Error).message}` });
  }
  const req = pickUsdcOnBase(terms);
  if (!req) return fail({ error: "server did not offer USDC on Base; refusing to pay", accepts: terms.accepts });
  const mismatch = checkPinnedTerms(path, req);
  if (mismatch)
    return fail({
      error: `refusing to pay: the server's x402 terms do not match the pinned Agent Press Wire terms. ${mismatch}`,
      charged: false,
      offered: req,
    });

  const priceAtomic = BigInt(req.amount);
  const priceUsd = atomicToUsd(priceAtomic);
  const cap = maxSpendUsd();
  const totalCap = maxTotalSpendUsd();
  const quote = {
    endpoint: `POST ${url}`,
    price_usd: priceUsd,
    price_usdc_atomic: req.amount,
    asset: "USDC",
    network: "Base mainnet (eip155:8453)",
    pay_to: req.payTo,
    description: terms.resource?.description,
  };

  let key: `0x${string}` | null;
  try {
    key = walletKey();
  } catch (e) {
    return fail({ error: (e as Error).message, quote });
  }

  let spentAtomic: bigint;
  try {
    spentAtomic = totalSpentAtomic(loadLedger());
  } catch (e) {
    return fail({ error: `refusing to pay: cannot read spend ledger ${ledgerPath()}: ${(e as Error).message}`, quote });
  }
  const totalReason =
    spentAtomic + priceAtomic > usdToAtomic(totalCap)
      ? `total spend would be $${atomicToUsd(spentAtomic + priceAtomic)}, over MAX_TOTAL_SPEND_USD=${totalCap} (already spent $${atomicToUsd(spentAtomic)} per ${ledgerPath()})`
      : null;

  const blocker = !key
    ? "X402_PRIVATE_KEY is not set"
    : priceUsd > cap
      ? `price $${priceUsd} exceeds MAX_SPEND_USD=${cap} (set MAX_SPEND_USD >= ${priceUsd} to allow this charge)`
      : totalReason;

  if (quoteOnly || !confirmToken || blocker) {
    const reason = quoteOnly ? "quote_only=true" : blocker ?? "no confirm_token: this was a quote";
    return ok({
      mode: "quote",
      paid: false,
      charged: false,
      reason,
      quote,
      spend: { spent_total_usd: atomicToUsd(spentAtomic), max_total_spend_usd: totalCap, max_spend_usd: cap },
      confirm_token: tokens.issue(path, body, req.amount),
      confirm_token_expires_in_seconds: CONFIRM_TTL_MS / 1000,
      next_step: blocker
        ? `Paying is not possible right now: ${blocker}. Show the user this price; the user must change the MCP server settings to allow it.`
        : "Show the user this exact price and get explicit approval. Then call this tool again with the SAME parameters, quote_only=false and this confirm_token (single use, expires in 10 minutes).",
    });
  }

  const tokenError = tokens.consume(confirmToken, path, body, req.amount);
  if (tokenError)
    return fail({
      error: `refusing to pay: ${tokenError}. Call again with quote_only=true to get a fresh quote and confirm_token, confirm the price with the user, then retry with identical parameters.`,
      charged: false,
      quote,
    });

  // Pay. Second guard: x402 client-side spend control capped at MAX_SPEND_USD.
  const account = privateKeyToAccount(key!);
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(account))
    .registerPolicy((_v, reqs) => reqs.filter((r) => checkPinnedTerms(path, r) === null && atomicToUsd(r.amount) <= cap))
    .setSpendControls({ maxAmountPerPayment: `$${cap}` });
  const http = new x402HTTPClient(client);

  // Total cap check, signing and the ledger write happen under one lock so concurrent calls cannot both pass.
  const signed = await withLedgerLock(async () => {
    let ledger;
    try {
      ledger = loadLedger();
    } catch (e) {
      return { error: `refusing to pay: cannot read spend ledger ${ledgerPath()}: ${(e as Error).message}` };
    }
    const over = checkTotalCap(ledger, priceAtomic, totalCap);
    if (over) return { error: `refusing to pay: ${over}` };
    let payload;
    try {
      payload = await http.createPaymentPayload({ ...terms, accepts: [req] });
    } catch (e) {
      return { error: `could not create payment: ${(e as Error).message}` };
    }
    const auth = (payload.payload as { authorization?: { nonce?: string; validBefore?: string; to?: string; value?: string } })?.authorization;
    if (!auth || String(auth.to).toLowerCase() !== PAY_TO.toLowerCase() || String(auth.value) !== req.amount)
      return { error: "refusing to send: signed authorization does not match the pinned payTo and price" };
    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      endpoint: path,
      amount_atomic: req.amount,
      pay_to: req.payTo,
      nonce: auth.nonce ?? null,
      valid_before: auth.validBefore ?? null,
      status: "signed",
    };
    ledger.entries.push(entry);
    try {
      saveLedger(ledger);
    } catch (e) {
      return { error: `refusing to send payment: cannot write spend ledger ${ledgerPath()}: ${(e as Error).message}` };
    }
    return { headers: http.encodePaymentSignatureHeader(payload), entry };
  });
  if ("error" in signed) return fail({ error: signed.error, charged: false, quote });
  const { headers: paymentHeaders, entry } = signed;
  const payment = { nonce: entry.nonce, valid_before_unix: entry.valid_before, payer: account.address, pay_to: entry.pay_to };

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...paymentHeaders },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    updateLedgerEntry(entry.nonce, entry.ts, { status: "unknown_network_error" });
    return fail({
      error: `network error after sending a signed payment authorization: ${(e as Error).message}. Settlement status is unknown. Check your wallet for a USDC transfer with this authorization nonce before retrying.`,
      settled: "unknown",
      payment,
      quote,
    });
  }

  let settlement: unknown = null;
  try {
    settlement = http.getPaymentSettleResponse((n) => res.headers.get(n));
  } catch {
    /* no settlement header */
  }
  const result = await readBody(res);
  if (!res.ok) {
    updateLedgerEntry(entry.nonce, entry.ts, { status: "not_settled_per_server", http_status: res.status });
    return fail({
      http_status: res.status,
      settled: "not settled per server",
      note: `The server reported failure and says it did not settle the payment, but it holds a signed authorization until valid_before. Check your wallet for a USDC transfer with nonce ${entry.nonce} before retrying. This authorization still counts toward MAX_TOTAL_SPEND_USD in ${ledgerPath()}.`,
      payment,
      response: result,
      quote,
    });
  }
  updateLedgerEntry(entry.nonce, entry.ts, { status: "settled", http_status: res.status });
  return ok({ mode: "paid", paid: true, price_usd: priceUsd, payment, settlement, result });
}

const server = new McpServer({ name: "agent-press-wire", version: VERSION });

const PAY_NOTE =
  "Charges REAL USDC on Base mainnet from the user's own wallet (X402_PRIVATE_KEY) via x402. Two steps: call first WITHOUT confirm_token (or with quote_only=true) to get the price and a confirm_token; show the user the exact price and get explicit approval; then call again with identical parameters and that confirm_token (single use, expires in 10 minutes). " +
  "It only pays if the price is <= MAX_SPEND_USD, the lifetime total stays <= MAX_TOTAL_SPEND_USD, and the server's payment terms match the pinned Agent Press Wire wallet and price; otherwise it returns the quote without paying. The service only settles payment if the job succeeds.";

const announcement = z
  .string()
  .max(500)
  .optional()
  .describe(
    "What is being announced (launch, new version, feature, funding, milestone). Strongly recommended: without it only news visible on the page is written about, and the call fails uncharged if there is none.",
  );
const quoteOnly = z
  .boolean()
  .optional()
  .default(false)
  .describe("If true, never pay: just return the x402 price quote and a confirm_token. Use this first to show the user the price.");
const confirmToken = z
  .string()
  .max(200)
  .optional()
  .describe("confirm_token from a previous quote of this tool with the exact same parameters, passed only after the user approved the quoted price. Without it the call only quotes.");

server.registerTool(
  "announce_launch_newsroom",
  {
    title: "Announce a launch (press release on newsroom page, $1)",
    description:
      `Announce a product launch, release, or update with a press release. PRICE: $1 USDC per call. Use when the user says things like "announce my launch", "write a press release", "publish a press release for my product", "announce our new version". ` +
      "Given a product URL, Agent Press Wire drafts a factual 350-450 word AP-style press release from the page and publishes it on a public, search-indexed newsroom page (IndexNow ping to Bing/Yandex). Returns the headline, newsroom URL, and the release in markdown. About 20 seconds. " +
      "For distribution to real news sites, use distribute_press_release instead. " +
      PAY_NOTE,
    inputSchema: {
      product_url: z.string().url().describe("Public URL of the product, launch page, or repo being announced."),
      announcement,
      company: z.string().max(100).optional().describe("Optional company or project name."),
      contact: z.string().max(200).optional().describe("Optional media contact line (name, email or URL) printed at the end."),
      quote_only: quoteOnly,
      confirm_token: confirmToken,
    },
    annotations: { title: "Announce launch ($1)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ product_url, announcement, company, contact, quote_only, confirm_token }) =>
    paidPost("/v1/press-release", { product_url, announcement, company, contact }, quote_only, confirm_token),
);

server.registerTool(
  "distribute_press_release",
  {
    title: "Write and distribute a press release over a newswire ($99 / $299)",
    description:
      `Write a press release and distribute it over a newswire to get press coverage. PRICE: tier "wire" = $99 USDC (500+ news sites plus 100+ TV and radio network sites); tier "premium" = $299 USDC (everything in wire plus AP News, USA Today, Barchart, StreetInsider). ` +
      `Use when the user says things like "get press coverage", "write and distribute a press release", "send a press release to news sites", "put out a press release on the wire", "PR distribution". ` +
      "Drafts a 450-600 word AP-style release from the product URL; it goes through editorial review and is distributed, usually same day on weekdays. Returns an order_id; poll get_release_status for live links. Not accepted: crypto token sales, gambling, adult, health/cure claims, cannabis. " +
      PAY_NOTE,
    inputSchema: {
      tier: z.enum(["wire", "premium"]).describe('"wire" = $99 (500+ news sites); "premium" = $299 (adds AP News, USA Today, Barchart, StreetInsider).'),
      product_url: z.string().url().describe("Public URL of the product, launch page, or repo being announced."),
      city: z.string().min(1).max(80).describe("City of the announcing company (newswire dateline)."),
      country: z.string().min(1).max(80).describe("Country name, e.g. 'United States'."),
      contact_email: z.string().email().describe("Media contact email printed on the release (required by newswires)."),
      announcement,
      company: z.string().max(100).optional().describe("Optional company or project name."),
      quote_only: quoteOnly,
      confirm_token: confirmToken,
    },
    annotations: { title: "Distribute press release ($99/$299)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ tier, product_url, city, country, contact_email, announcement, company, quote_only, confirm_token }) =>
    paidPost(
      tier === "premium" ? "/v1/wire-release/premium" : "/v1/wire-release",
      { product_url, city, country, contact_email, announcement, company },
      quote_only,
      confirm_token,
    ),
);

server.registerTool(
  "get_release_status",
  {
    title: "Get press release distribution status (free)",
    description:
      "FREE. Check the status of a newswire press release order from distribute_press_release (order id like w_ab12cd34ef) and get live links to the published coverage once distributed.",
    inputSchema: {
      order_id: z.string().describe("The order_id returned by distribute_press_release, e.g. w_3f9d0a1b2c."),
    },
    annotations: { title: "Release status (free)", readOnlyHint: true, openWorldHint: true },
  },
  async ({ order_id }) => {
    const id = order_id.trim();
    if (!/^w_[0-9a-f]+$/.test(id)) return fail({ error: "order_id must look like w_<hex>, as returned by distribute_press_release" });
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/v1/wire-release/${id}`, {
        headers: { "user-agent": `agent-press-wire-mcp/${VERSION}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return fail({ error: `network error: ${(e as Error).message}` });
    }
    const body = await readBody(res);
    if (res.status === 404) return fail({ error: `no wire order found with id ${id}`, http_status: 404 });
    if (!res.ok) return fail({ http_status: res.status, response: body });
    return ok(body);
  },
);

await server.connect(new StdioServerTransport());
console.error(`agent-press-wire MCP ${VERSION} ready (${BASE_URL}, MAX_SPEND_USD=${maxSpendUsd()}, MAX_TOTAL_SPEND_USD=${maxTotalSpendUsd()}, ledger ${ledgerPath()}, wallet ${process.env.X402_PRIVATE_KEY ? "set" : "not set"})`);
