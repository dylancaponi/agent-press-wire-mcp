// Offline tests for the AI SDK tools (agent-press-wire-mcp/ai-sdk). fetch is mocked; a throwaway,
// unfunded key signs the x402 authorizations, so nothing touches a network or a real wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { agentPressWireTools } from "../dist/ai-sdk.js";
import { PAY_TO, USDC_BASE } from "../dist/guard.js";

const PRICES = { "/v1/press-release": "1000000", "/v1/wire-release": "99000000", "/v1/wire-release/premium": "299000000" };
const terms = (path, over = {}) => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: USDC_BASE,
  amount: PRICES[path],
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
  ...over,
});

/** Mock fetch: 402 without a payment header, then `paid` (status + body) with one. Records every call. */
function mockFetch({ paid = { status: 200, body: { id: "r_1", url: "https://agentpresswire.dev/r/r_1" } }, override = {}, throwOnPaid = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const sig = init.headers?.["PAYMENT-SIGNATURE"] ?? init.headers?.["payment-signature"];
    calls.push({ url, path, method: init.method ?? "GET", paid: Boolean(sig), sig: sig ? JSON.parse(Buffer.from(sig, "base64").toString()) : null, body: init.body });
    if ((init.method ?? "GET") === "GET") {
      if (path === "/v1/wire-release/w_abc123") return Response.json({ id: "w_abc123", status: "distributed", links: ["https://example.com/a"] });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!sig) {
      const pr = { x402Version: 2, resource: { url, description: "mock" }, accepts: [terms(path, override)] };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64"), "content-type": "application/json" } });
    }
    if (throwOnPaid) throw new TypeError("fetch failed");
    return Response.json(paid.body, { status: paid.status });
  };
  return { fetch, calls };
}

const wallet = privateKeyToAccount(generatePrivateKey());
const opts = { toolCallId: "t1", messages: [] };
const release = { product_url: "https://example.com", announcement: "v2 is out" };
const wire = { ...release, city: "Los Angeles", country: "United States", contact_email: "press@example.com" };

test("exports the four tools with zod input schemas", () => {
  const tools = agentPressWireTools();
  assert.deepEqual(Object.keys(tools).sort(), ["distributePressRelease", "getReleaseStatus", "publishPressRelease", "quotePressRelease"]);
  for (const t of Object.values(tools)) {
    assert.equal(typeof t.execute, "function");
    assert.equal(typeof t.description, "string");
    assert.ok(t.inputSchema);
  }
  assert.match(tools.publishPressRelease.description, /at most \$1 per call/);
});

test("rejects invalid caps", () => {
  assert.throws(() => agentPressWireTools({ maxPaymentUsd: -1 }), /maxPaymentUsd/);
  assert.throws(() => agentPressWireTools({ maxTotalUsd: Number.NaN }), /maxTotalUsd/);
});

test("quote: free, never signs, reports whether the default $1 cap allows each tier", async () => {
  const m = mockFetch();
  const tools = agentPressWireTools({ wallet, fetch: m.fetch });
  const nr = await tools.quotePressRelease.execute({ tier: "newsroom" }, opts);
  assert.equal(nr.status, "quote");
  assert.equal(nr.charged, false);
  assert.equal(nr.quote.priceUsd, 1);
  assert.equal(nr.quote.canPay, true);
  const w = await tools.quotePressRelease.execute({ tier: "wire" }, opts);
  assert.equal(w.quote.priceUsd, 99);
  assert.equal(w.quote.canPay, false);
  assert.match(w.quote.blocker, /maxPaymentUsd=1/);
  const p = await tools.quotePressRelease.execute({ tier: "premium" }, opts);
  assert.equal(p.quote.priceUsd, 299);
  assert.ok(m.calls.every((c) => !c.paid));
});

test("no wallet: paid tools only quote", async () => {
  const m = mockFetch();
  const r = await agentPressWireTools({ fetch: m.fetch }).publishPressRelease.execute(release, opts);
  assert.equal(r.status, "not_paid");
  assert.equal(r.charged, false);
  assert.match(r.reason, /no wallet/);
  assert.equal(r.quote.priceUsd, 1);
  assert.equal(m.calls.length, 1);
});

test("$1 newsroom release pays once with a pinned authorization", async () => {
  const m = mockFetch();
  const r = await agentPressWireTools({ wallet, fetch: m.fetch }).publishPressRelease.execute(release, opts);
  assert.equal(r.status, "paid");
  assert.equal(r.charged, true);
  assert.equal(r.priceUsd, 1);
  assert.equal(r.payer, wallet.address);
  assert.deepEqual(r.result, { id: "r_1", url: "https://agentpresswire.dev/r/r_1" });
  const paid = m.calls.filter((c) => c.paid);
  assert.equal(paid.length, 1);
  const auth = paid[0].sig.payload.authorization;
  assert.equal(auth.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(auth.value, "1000000");
  assert.equal(JSON.parse(paid[0].body).announcement, "v2 is out");
});

test("wire tier is refused under the default cap and paid when the cap allows it", async () => {
  const m = mockFetch({ paid: { status: 200, body: { order_id: "w_abc123" } } });
  const low = await agentPressWireTools({ wallet, fetch: m.fetch }).distributePressRelease.execute({ tier: "wire", ...wire }, opts);
  assert.equal(low.status, "not_paid");
  assert.match(low.reason, /maxPaymentUsd=1/);
  assert.equal(m.calls.filter((c) => c.paid).length, 0);

  const ok = await agentPressWireTools({ wallet, fetch: m.fetch, maxPaymentUsd: 99 }).distributePressRelease.execute({ tier: "wire", ...wire }, opts);
  assert.equal(ok.status, "paid");
  assert.equal(ok.priceUsd, 99);
  const prem = await agentPressWireTools({ wallet, fetch: m.fetch, maxPaymentUsd: 99 }).distributePressRelease.execute({ tier: "premium", ...wire }, opts);
  assert.equal(prem.status, "not_paid");
  assert.equal(m.calls.filter((c) => c.paid).length, 1);
  assert.equal(m.calls.find((c) => c.paid).path, "/v1/wire-release");
  assert.equal(JSON.parse(m.calls.find((c) => c.paid).body).tier, undefined);
});

test("maxTotalUsd: default allows one paid call per tool set", async () => {
  const m = mockFetch();
  const tools = agentPressWireTools({ wallet, fetch: m.fetch });
  assert.equal((await tools.publishPressRelease.execute(release, opts)).status, "paid");
  const second = await tools.publishPressRelease.execute(release, opts);
  assert.equal(second.status, "not_paid");
  assert.match(second.reason, /maxTotalUsd=1/);
  const three = agentPressWireTools({ wallet, fetch: m.fetch, maxTotalUsd: 3 });
  const results = await Promise.all([1, 2, 3, 4].map(() => three.publishPressRelease.execute(release, opts)));
  assert.equal(results.filter((r) => r.status === "paid").length, 3);
});

test("422 after payment: rejected, charged false, details passed through, cap released", async () => {
  const m = mockFetch({ paid: { status: 422, body: { error: "your copy did not pass our checks; you were not charged", details: ["body is 90 words; minimum is 150"] } } });
  const tools = agentPressWireTools({ wallet, fetch: m.fetch });
  const r = await tools.publishPressRelease.execute({ ...release, headline: "Example ships v2", body: "too short" }, opts);
  assert.equal(r.status, "rejected");
  assert.equal(r.charged, false);
  assert.equal(r.httpStatus, 422);
  assert.match(r.error, /not charged/);
  assert.deepEqual(r.details, ["body is 90 words; minimum is 150"]);
  assert.match(r.nextStep, /did not charge/);
  // the rejected call did not use up the total cap
  const again = await tools.publishPressRelease.execute(release, opts);
  assert.equal(again.status, "rejected");
  assert.equal(m.calls.filter((c) => c.paid).length, 2);
});

test("409 duplicate and 503 are reported as not charged", async () => {
  for (const status of [409, 503]) {
    const m = mockFetch({ paid: { status, body: { error: "mock" } } });
    const r = await agentPressWireTools({ wallet, fetch: m.fetch }).publishPressRelease.execute(release, opts);
    assert.equal(r.status, "rejected");
    assert.equal(r.charged, false);
    assert.equal(r.httpStatus, status);
  }
});

test("network error after signing: charged unknown, still counts toward the total", async () => {
  const m = mockFetch({ throwOnPaid: true });
  const tools = agentPressWireTools({ wallet, fetch: m.fetch });
  const r = await tools.publishPressRelease.execute(release, opts);
  assert.equal(r.status, "unknown");
  assert.equal(r.charged, "unknown");
  assert.ok(r.nonce);
  const next = await tools.publishPressRelease.execute(release, opts);
  assert.equal(next.status, "not_paid");
  assert.match(next.reason, /maxTotalUsd/);
});

test("refuses to pay when the 402 terms do not match the pins", async () => {
  for (const over of [{ payTo: "0x000000000000000000000000000000000000dEaD" }, { amount: "2000000" }, { maxTimeoutSeconds: 3600 }]) {
    const m = mockFetch({ override: over });
    const r = await agentPressWireTools({ wallet, fetch: m.fetch, maxPaymentUsd: 5, maxTotalUsd: 5 }).publishPressRelease.execute(release, opts);
    assert.equal(r.status, "not_paid");
    assert.match(r.reason, /pinned/);
    assert.equal(m.calls.filter((c) => c.paid).length, 0);
  }
});

test("getReleaseStatus is free and validates the id", async () => {
  const m = mockFetch();
  const tools = agentPressWireTools({ fetch: m.fetch });
  const ok = await tools.getReleaseStatus.execute({ order_id: "w_abc123" }, opts);
  assert.equal(ok.ok, true);
  assert.equal(ok.order.status, "distributed");
  const bad = await tools.getReleaseStatus.execute({ order_id: "../admin" }, opts);
  assert.equal(bad.ok, false);
  const missing = await tools.getReleaseStatus.execute({ order_id: "w_ffff" }, opts);
  assert.equal(missing.httpStatus, 404);
});

test("works inside generateText with a mock model (ai@7)", async () => {
  const { generateText, isStepCount } = await import("ai");
  const { MockLanguageModelV4 } = await import("ai/test");
  const m = mockFetch();
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
      if (step === 1)
        return {
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "publishPressRelease", input: JSON.stringify(release) }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: [],
        };
      return { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  const res = await generateText({ model, prompt: "announce v2", tools: agentPressWireTools({ wallet, fetch: m.fetch }), stopWhen: isStepCount(3) });
  assert.equal(res.text, "done");
  const tr = res.steps.flatMap((s) => s.toolResults)[0];
  assert.equal(tr.toolName, "publishPressRelease");
  assert.equal(tr.output.status, "paid");
});
