// Agent Press Wire tools for the Vercel AI SDK (import from "agent-press-wire-mcp/ai-sdk").
//
// Paid tools pay per call in USDC on Base over x402 from the caller's own wallet. Before anything
// is signed: a wallet is configured, the price is at or below maxPaymentUsd (default $1), the
// running total for this tool set stays at or below maxTotalUsd, and the server's 402 terms match
// the pinned payTo, price, asset and network in guard.ts. Otherwise the tool returns the quote and
// does not pay.

import { tool } from "ai";
import { z } from "zod";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentRequired, PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { NETWORK, USDC_BASE, PAY_TO, atomicToUsd, checkPinnedTerms, usdToAtomic } from "./guard.js";

export const VERSION = "0.3.0";
const DEFAULT_BASE_URL = "https://agentpresswire.dev";
const DEFAULT_TIMEOUT_MS = 180_000;

/** A viem LocalAccount (for example privateKeyToAccount(key)) or any x402 EVM client signer. */
export type PaymentWallet = ConstructorParameters<typeof ExactEvmScheme>[0];

export interface AgentPressWireToolsOptions {
  /** Wallet that pays, holding USDC on Base. Without it the paid tools only return quotes. */
  wallet?: PaymentWallet;
  /** Most this tool set may pay for one call, in USD. Default 1, which allows the $1 newsroom release and quotes the wire tiers. Set 99 or 299 to allow those. */
  maxPaymentUsd?: number;
  /** Most this tool set may pay in total across calls, in USD. Default: maxPaymentUsd (one paid call). */
  maxTotalUsd?: number;
  /** API origin. Default https://agentpresswire.dev. Payment terms are pinned, so another origin cannot change the payee or the price. */
  baseUrl?: string;
  /** Custom fetch, for tests or proxies. Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per request timeout in ms. Default 180000 (drafting takes about 20 seconds, wire orders longer). */
  timeoutMs?: number;
}

export type Tier = "newsroom" | "wire" | "premium";
const TIER_PATH: Record<Tier, string> = {
  newsroom: "/v1/press-release",
  wire: "/v1/wire-release",
  premium: "/v1/wire-release/premium",
};

export interface Quote {
  tier: Tier;
  endpoint: string;
  priceUsd: number;
  asset: "USDC";
  network: "Base mainnet (eip155:8453)";
  payTo: string;
  withinMaxPayment: boolean;
  withinMaxTotal: boolean;
  walletConfigured: boolean;
  canPay: boolean;
  blocker?: string;
}

/** Result of a paid tool call. `charged` is false whenever no money moved. */
export type PaidResult =
  | { status: "paid"; charged: true; priceUsd: number; payer: string; nonce: string | null; settlement: unknown; result: unknown }
  | { status: "not_paid"; charged: false; reason: string; quote?: Quote }
  | { status: "rejected"; charged: false; httpStatus: number; error: string; details?: unknown; nextStep: string }
  | { status: "unknown"; charged: "unknown"; error: string; payer: string; nonce: string | null; validBefore: string | null };

function positiveUsd(name: string, v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${name} must be a finite number >= 0 (USD)`);
  return v;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

function errorText(body: unknown, status: number): { error: string; details?: unknown } {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; details?: unknown };
    return { error: typeof b.error === "string" ? b.error : `HTTP ${status}`, details: b.details };
  }
  return { error: typeof body === "string" && body ? body : `HTTP ${status}` };
}

function nextStepFor(status: number): string {
  if (status === 422)
    return "The service rejected this input and did not charge. Read error and details, fix the input (usually add a clear announcement, or fix the supplied headline/body), then call again.";
  if (status === 409) return "Duplicate of an order already accepted from this wallet in the last 24 hours. Not charged again. Use the id in the error.";
  if (status === 503 || status === 502) return "Temporary failure on the service side. Not charged. Try again later.";
  return "The service reported a failure and did not settle the payment.";
}

const pickUsdcOnBase = (pr: PaymentRequired): PaymentRequirements | undefined =>
  pr.accepts.find((r) => r.network === NETWORK && String(r.asset).toLowerCase() === USDC_BASE);

/** Builds the Agent Press Wire tool set. Spend limits apply across all tools from one call of this function. */
export function agentPressWireTools(options: AgentPressWireToolsOptions = {}) {
  const maxPaymentUsd = positiveUsd("maxPaymentUsd", options.maxPaymentUsd, 1);
  const maxTotalUsd = positiveUsd("maxTotalUsd", options.maxTotalUsd, maxPaymentUsd);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wallet = options.wallet;
  const headers = { "content-type": "application/json", "user-agent": `agent-press-wire-ai-sdk/${VERSION}` };

  // Atomic USDC reserved by signed authorizations. A call that the server answers with an error is
  // released (the service never settles a failed job); a call with an unknown outcome stays reserved.
  let reservedAtomic = 0n;
  let lock: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  type Probe =
    | { kind: "terms"; terms: PaymentRequired; req: PaymentRequirements; quote: Quote }
    | { kind: "done"; result: PaidResult };

  /** Unpaid POST that reads the 402 terms and checks them against the pins and the caps. */
  async function probe(tier: Tier, body: Record<string, unknown>): Promise<Probe> {
    const path = TIER_PATH[tier];
    const url = `${baseUrl}${path}`;
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { kind: "done", result: { status: "not_paid", charged: false, reason: `network error calling ${url}: ${(e as Error).message}` } };
    }
    if (res.status !== 402) {
      const b = await readBody(res);
      const { error, details } = errorText(b, res.status);
      return {
        kind: "done",
        result: res.ok
          ? { status: "not_paid", charged: false, reason: `expected a 402 payment request from ${url}, got HTTP ${res.status}; refusing to continue` }
          : { status: "rejected", charged: false, httpStatus: res.status, error, details, nextStep: nextStepFor(res.status) },
      };
    }
    let terms: PaymentRequired;
    try {
      terms = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => res.headers.get(n), await readBody(res));
    } catch (e) {
      return { kind: "done", result: { status: "not_paid", charged: false, reason: `could not parse x402 payment terms: ${(e as Error).message}` } };
    }
    const req = pickUsdcOnBase(terms);
    if (!req) return { kind: "done", result: { status: "not_paid", charged: false, reason: "server did not offer USDC on Base; refusing to pay" } };
    const mismatch = checkPinnedTerms(path, req);
    if (mismatch)
      return { kind: "done", result: { status: "not_paid", charged: false, reason: `refusing to pay: payment terms do not match the pinned Agent Press Wire terms. ${mismatch}` } };

    const priceAtomic = BigInt(req.amount);
    const priceUsd = atomicToUsd(priceAtomic);
    const withinMaxPayment = priceAtomic <= usdToAtomic(maxPaymentUsd);
    const withinMaxTotal = reservedAtomic + priceAtomic <= usdToAtomic(maxTotalUsd);
    const blocker = !wallet
      ? "no wallet configured; this tool set only quotes"
      : !withinMaxPayment
        ? `price $${priceUsd} is over maxPaymentUsd=${maxPaymentUsd}; the developer must raise maxPaymentUsd to allow it`
        : !withinMaxTotal
          ? `paying $${priceUsd} would bring this tool set's total to $${atomicToUsd(reservedAtomic + priceAtomic)}, over maxTotalUsd=${maxTotalUsd}`
          : undefined;
    const quote: Quote = {
      tier,
      endpoint: `POST ${url}`,
      priceUsd,
      asset: "USDC",
      network: "Base mainnet (eip155:8453)",
      payTo: req.payTo,
      withinMaxPayment,
      withinMaxTotal,
      walletConfigured: Boolean(wallet),
      canPay: !blocker,
      ...(blocker ? { blocker } : {}),
    };
    return { kind: "terms", terms, req, quote };
  }

  async function paidPost(tier: Tier, body: Record<string, unknown>): Promise<PaidResult> {
    const p = await probe(tier, body);
    if (p.kind === "done") return p.result;
    const { terms, req, quote } = p;
    if (!quote.canPay || !wallet) return { status: "not_paid", charged: false, reason: quote.blocker ?? "not allowed", quote };

    const path = TIER_PATH[tier];
    const priceAtomic = BigInt(req.amount);
    const client = new x402Client()
      .register(NETWORK, new ExactEvmScheme(wallet))
      .registerPolicy((_v, reqs) => reqs.filter((r) => checkPinnedTerms(path, r) === null && BigInt(r.amount) <= usdToAtomic(maxPaymentUsd)))
      .setSpendControls({ maxAmountPerPayment: `$${maxPaymentUsd}` });
    const http = new x402HTTPClient(client);

    // Total check, signing and the reservation happen under one lock so parallel tool calls cannot both pass.
    const signed = await withLock(async () => {
      if (reservedAtomic + priceAtomic > usdToAtomic(maxTotalUsd))
        return { error: `paying $${quote.priceUsd} would exceed maxTotalUsd=${maxTotalUsd}` };
      let payload;
      try {
        payload = await http.createPaymentPayload({ ...terms, accepts: [req] });
      } catch (e) {
        return { error: `could not create payment: ${(e as Error).message}` };
      }
      const auth = (payload.payload as { authorization?: { nonce?: string; validBefore?: string; to?: string; value?: string } })?.authorization;
      if (!auth || String(auth.to).toLowerCase() !== PAY_TO.toLowerCase() || String(auth.value) !== req.amount)
        return { error: "refusing to send: signed authorization does not match the pinned payTo and price" };
      reservedAtomic += priceAtomic;
      return { paymentHeaders: http.encodePaymentSignatureHeader(payload), nonce: auth.nonce ?? null, validBefore: auth.validBefore ?? null };
    });
    if ("error" in signed) return { status: "not_paid", charged: false, reason: signed.error ?? "payment refused", quote };

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { ...headers, ...signed.paymentHeaders },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return {
        status: "unknown",
        charged: "unknown",
        error: `network error after sending a signed payment authorization: ${(e as Error).message}. Check the wallet for a USDC transfer with this nonce before retrying. It still counts toward maxTotalUsd.`,
        payer: wallet.address,
        nonce: signed.nonce,
        validBefore: signed.validBefore,
      };
    }
    const result = await readBody(res);
    if (!res.ok) {
      reservedAtomic -= priceAtomic; // the service does not settle failed jobs (x402 settles only on 2xx)
      const { error, details } = errorText(result, res.status);
      return { status: "rejected", charged: false, httpStatus: res.status, error, details, nextStep: nextStepFor(res.status) };
    }
    let settlement: unknown = null;
    try {
      settlement = http.getPaymentSettleResponse((n) => res.headers.get(n));
    } catch {
      /* no settlement header */
    }
    return { status: "paid", charged: true, priceUsd: quote.priceUsd, payer: wallet.address, nonce: signed.nonce, settlement, result };
  }

  const productUrl = z.string().url().describe("Public URL of the product, launch page, or repo being announced.");
  const announcement = z
    .string()
    .max(500)
    .optional()
    .describe("What is being announced (launch, new version, feature, funding, milestone). Strongly recommended: without it only news visible on the page is used, and the call fails uncharged if the page shows none.");
  const company = z.string().max(100).optional().describe("Company or project name.");
  const headline = z
    .string()
    .max(200)
    .optional()
    .describe("Optional, together with body: a finished headline (3 to 20 words, naming the company). With headline and body the release is published as written after safety checks instead of being drafted.");
  const releaseBody = z
    .string()
    .max(12000)
    .optional()
    .describe("Optional, together with headline: finished release text, plain English, blank line between paragraphs, 150 to 900 words (380 to 900 on wire tiers), links only to the product's own site.");
  const pictureUrl = z
    .string()
    .max(1400000)
    .optional()
    .describe(
      "Optional featured picture: a public http(s) URL or a data:image/png|jpeg|webp|gif;base64 URI, PNG/JPEG/WebP/GIF, max 1 MB. Without it the service uses the product page's og:image picture unless no_image is true. Every picture is safety reviewed before charging (no nudity, violence, hate symbols, other companies' logos, money or health claims, news-site screenshots, hidden instructions); a supplied picture that fails returns an uncharged error with the reason, a page picture that fails is just left out.",
    );
  const pictureAlt = z.string().max(125).optional().describe("Optional alt text for the featured picture, max 125 characters (defaults to the headline).");
  const pictureCaption = z.string().max(300).optional().describe("Optional caption under the featured picture, max 300 characters.");
  const noPicture = z.boolean().optional().describe("Optional: true to publish without a picture (turns off the automatic picture from the product page).");
  const inlinePictures = z
    .array(
      z.object({
        url: z.string().max(1400000).describe("http(s) URL or data:image/...;base64 URI, max 1 MB."),
        alt: z.string().max(125).optional().describe("Alt text, max 125 characters."),
        caption: z.string().max(300).optional().describe("Optional caption, max 300 characters."),
      }),
    )
    .max(3)
    .optional()
    .describe("Only with your own headline and body: up to 3 pictures placed inside the release, at lines [image 1], [image 2], [image 3] in the body (or spread evenly if there are no marker lines). Same formats, limit and safety review as image_url.");
  const pictures = { image_url: pictureUrl, image_alt: pictureAlt, image_caption: pictureCaption, no_image: noPicture, images: inlinePictures };
  const wireInput = {
    product_url: productUrl,
    city: z.string().min(1).max(80).describe("City of the announcing company (newswire dateline)."),
    country: z.string().min(1).max(80).describe("Country name, for example 'United States'."),
    contact_email: z.string().email().describe("Media contact email printed on the release (required by newswires)."),
    announcement,
    company,
    headline,
    body: releaseBody,
    ...pictures,
  };

  const capNote = `Pays in USDC on Base from the developer's wallet. This tool set pays at most $${maxPaymentUsd} per call and $${maxTotalUsd} in total; anything above that returns a quote with charged=false. The service only charges when the job succeeds: errors (status "rejected") are never charged.`;

  return {
    quotePressRelease: tool({
      description:
        "FREE. Get the current price of a press release tier and whether this tool set is allowed to pay it, without paying. Tiers: newsroom ($1, published on a search-indexed newsroom page), wire ($99, 500+ news sites plus TV and radio network sites), premium ($299, adds AP News, USA Today, Barchart, StreetInsider). Use before a paid call to show the user the price. It does not check the release content.",
      inputSchema: z.object({
        tier: z.enum(["newsroom", "wire", "premium"]).describe("Which product to price."),
        product_url: productUrl.optional(),
      }),
      execute: async ({ tier, product_url }) => {
        const p = await probe(tier, product_url ? { product_url } : {});
        if (p.kind === "done") return { ...p.result, charged: false as const };
        return { status: "quote" as const, charged: false as const, quote: p.quote };
      },
    }),

    publishPressRelease: tool({
      description:
        "Announce a product launch, release or update with a press release published on Agent Press Wire's public, search-indexed newsroom. PRICE: $1 USDC. Drafts a factual 350 to 450 word AP-style release from the product URL (or publishes the user's own headline and body after safety checks), with the page's og:image picture or one you pass in image_url, and returns the headline, newsroom URL and the release text. About 20 seconds. " +
        capNote,
      inputSchema: z.object({
        product_url: productUrl,
        announcement,
        company,
        contact: z.string().max(200).optional().describe("Media contact line (name, email or URL) printed at the end."),
        headline,
        body: releaseBody,
        ...pictures,
      }),
      execute: async (input) => paidPost("newsroom", input),
    }),

    distributePressRelease: tool({
      description:
        'Write a press release and distribute it over a newswire. PRICE: tier "wire" $99 USDC (500+ news sites plus 100+ TV and radio network sites), tier "premium" $299 USDC (adds AP News, USA Today, Barchart, StreetInsider). Returns an order_id; check it with getReleaseStatus for live links (usually same day on weekdays). Not accepted: crypto token sales, gambling, adult, health or cure claims, cannabis, market-moving news (acquisitions, earnings, IPOs, stock, FDA, lawsuits). ' +
        capNote,
      inputSchema: z.object({ tier: z.enum(["wire", "premium"]).describe('"wire" $99 or "premium" $299.'), ...wireInput }),
      execute: async ({ tier, ...input }) => paidPost(tier, input),
    }),

    getReleaseStatus: tool({
      description: "FREE. Status and live coverage links for a newswire order from distributePressRelease (order id like w_3f9d0a1b2c).",
      inputSchema: z.object({ order_id: z.string().describe("order_id returned by distributePressRelease.") }),
      execute: async ({ order_id }) => {
        const id = order_id.trim();
        if (!/^w_[0-9a-f]+$/.test(id)) return { ok: false, error: "order_id must look like w_<hex>, as returned by distributePressRelease" };
        let res: Response;
        try {
          res = await doFetch(`${baseUrl}/v1/wire-release/${id}`, { headers: { "user-agent": headers["user-agent"] }, signal: AbortSignal.timeout(30_000) });
        } catch (e) {
          return { ok: false, error: `network error: ${(e as Error).message}` };
        }
        const b = await readBody(res);
        if (!res.ok) return { ok: false, httpStatus: res.status, ...errorText(b, res.status) };
        return { ok: true, order: b };
      },
    }),
  };
}

export type AgentPressWireTools = ReturnType<typeof agentPressWireTools>;
