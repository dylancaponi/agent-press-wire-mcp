// Offline tests for the payment guard rails (audit M2, L4). NEVER touches a real network or wallet:
// the paid flow runs against a localhost mock x402 server with a throwaway, unfunded key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";
import { PAY_TO, USDC_BASE, ConfirmTokens, checkPinnedTerms, checkTotalCap, loadLedger, saveLedger } from "../dist/guard.js";

const goodReq = (path = "/v1/press-release") => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: USDC_BASE,
  amount: { "/v1/press-release": "1000000", "/v1/wire-release": "99000000", "/v1/wire-release/premium": "299000000" }[path],
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
});

// ---------- unit: pins ----------
test("pins accept the real terms for each endpoint", () => {
  for (const p of ["/v1/press-release", "/v1/wire-release", "/v1/wire-release/premium"]) assert.equal(checkPinnedTerms(p, goodReq(p)), null);
  assert.equal(checkPinnedTerms("/v1/press-release", { ...goodReq(), payTo: PAY_TO.toLowerCase() }), null);
});
test("pins refuse payTo, amount, timeout, scheme and transfer-method mismatches", () => {
  assert.match(checkPinnedTerms("/v1/press-release", { ...goodReq(), payTo: "0x000000000000000000000000000000000000dEaD" }), /payTo/);
  assert.match(checkPinnedTerms("/v1/press-release", { ...goodReq(), amount: "99000000" }), /amount/);
  assert.match(checkPinnedTerms("/v1/wire-release", goodReq("/v1/press-release")), /amount/);
  assert.match(checkPinnedTerms("/v1/press-release", { ...goodReq(), maxTimeoutSeconds: 601 }), /maxTimeoutSeconds/);
  assert.equal(checkPinnedTerms("/v1/press-release", { ...goodReq(), maxTimeoutSeconds: 600 }), null);
  assert.match(checkPinnedTerms("/v1/press-release", { ...goodReq(), scheme: "upto" }), /scheme/);
  assert.match(checkPinnedTerms("/v1/press-release", { ...goodReq(), extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } }), /permit2/);
  assert.match(checkPinnedTerms("/v1/other", goodReq()), /no pinned price/);
});

// ---------- unit: confirm tokens ----------
test("confirm_token is bound to endpoint, params, amount, expiry and single use", () => {
  const t = new ConfirmTokens(60_000);
  const body = { product_url: "https://x.dev", announcement: "v2", company: undefined };
  const now = Date.now();
  const tok = t.issue("/v1/press-release", body, "1000000", now);
  assert.match(t.consume(tok, "/v1/wire-release", body, "1000000", now), /does not match/);
  assert.match(t.consume(tok, "/v1/press-release", { ...body, announcement: "v3" }, "1000000", now), /does not match/);
  assert.match(t.consume(tok, "/v1/press-release", body, "2000000", now), /does not match/);
  assert.match(t.consume(tok, "/v1/press-release", body, "1000000", now + 61_000), /expired/);
  assert.match(t.consume("garbage", "/v1/press-release", body, "1000000", now), /malformed/);
  assert.match(new ConfirmTokens().consume(tok, "/v1/press-release", body, "1000000", now), /does not match/);
  // key order and undefined fields do not matter
  assert.equal(t.consume(tok, "/v1/press-release", { announcement: "v2", product_url: "https://x.dev" }, "1000000", now), null);
  assert.match(t.consume(tok, "/v1/press-release", body, "1000000", now), /already used/);
});

// ---------- unit: ledger ----------
test("ledger persists, sums, enforces the total cap and fails closed when corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "apw-ledger-"));
  assert.deepEqual(loadLedger(dir), { version: 1, entries: [] });
  const l = loadLedger(dir);
  l.entries.push({ ts: "t", endpoint: "/v1/press-release", amount_atomic: "1000000", pay_to: PAY_TO, nonce: "0x1", valid_before: "1", status: "signed" });
  saveLedger(l, dir);
  const back = loadLedger(dir);
  assert.equal(back.entries.length, 1);
  assert.equal(checkTotalCap(back, 1_000_000n, 2), null);
  assert.match(checkTotalCap(back, 1_000_000n, 1.5), /MAX_TOTAL_SPEND_USD/);
  writeFileSync(join(dir, "spend.json"), "{not json");
  assert.throws(() => loadLedger(dir));
});

// ---------- integration: MCP stdio against a localhost mock x402 server ----------
const mock = { req: goodReq(), paidStatus: 200, signatures: [] };
const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const sig = req.headers["payment-signature"];
    if (!sig) {
      const pr = { x402Version: 2, resource: { url: `http://mock${req.url}`, description: "mock" }, accepts: [{ ...mock.req }] };
      res.writeHead(402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64"), "content-type": "application/json" });
      return res.end("{}");
    }
    mock.signatures.push(JSON.parse(Buffer.from(sig, "base64").toString()));
    res.writeHead(mock.paidStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(mock.paidStatus === 200 ? { ok: true, mock: true } : { error: "mock failure" }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PRESS_API_URL = `http://127.0.0.1:${server.address().port}`;

async function withClient(env, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, PRESS_API_URL, X402_PRIVATE_KEY: generatePrivateKey(), MAX_SPEND_USD: "1", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "hardening-test", version: "0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, ...JSON.parse(r.content[0].text) };
  };
  try {
    return await fn(call);
  } finally {
    await client.close();
  }
}
const nr = { product_url: "https://hono.dev", announcement: "test" };

test("paid flow: quote -> confirm_token -> mock pay, ledger + total cap enforced", async () => {
  const home = mkdtempSync(join(tmpdir(), "apw-home-"));
  Object.assign(mock, { req: goodReq(), paidStatus: 200, signatures: [] });
  await withClient({ AGENT_PRESS_WIRE_HOME: home, MAX_TOTAL_SPEND_USD: "1" }, async (call) => {
    const noTok = await call("announce_launch_newsroom", nr);
    assert.equal(noTok.mode, "quote");
    assert.match(noTok.reason, /no confirm_token/);
    assert.equal(mock.signatures.length, 0);

    const bad = await call("announce_launch_newsroom", { ...nr, announcement: "different", confirm_token: noTok.confirm_token });
    assert.ok(bad.isError);
    assert.match(bad.error, /does not match/);
    assert.equal(mock.signatures.length, 0);

    const q = await call("announce_launch_newsroom", { ...nr, quote_only: true });
    const paid = await call("announce_launch_newsroom", { ...nr, confirm_token: q.confirm_token });
    assert.equal(paid.paid, true, JSON.stringify(paid));
    assert.equal(mock.signatures.length, 1);
    assert.equal(mock.signatures[0].payload.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
    assert.equal(paid.payment.nonce, mock.signatures[0].payload.authorization.nonce);

    const ledger = JSON.parse(readFileSync(join(home, "spend.json"), "utf8"));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].status, "settled");

    const reuse = await call("announce_launch_newsroom", { ...nr, confirm_token: q.confirm_token });
    assert.equal(reuse.paid, false);
    assert.match(reuse.reason, /MAX_TOTAL_SPEND_USD/);
    assert.equal(mock.signatures.length, 1);
  });
  // Ledger survives a restart: a new process still sees $1 spent.
  await withClient({ AGENT_PRESS_WIRE_HOME: home, MAX_TOTAL_SPEND_USD: "1" }, async (call) => {
    const q = await call("announce_launch_newsroom", nr);
    assert.match(q.reason, /MAX_TOTAL_SPEND_USD/);
    assert.equal(q.spend.spent_total_usd, 1);
  });
});

test("pin mismatch from the server is refused with no token and no signature", async () => {
  const home = mkdtempSync(join(tmpdir(), "apw-home-"));
  for (const [label, req] of [
    ["payTo", { ...goodReq(), payTo: "0x000000000000000000000000000000000000dEaD" }],
    ["amount", { ...goodReq(), amount: "900000" }],
    ["maxTimeoutSeconds", { ...goodReq(), maxTimeoutSeconds: 86400 }],
  ]) {
    Object.assign(mock, { req, paidStatus: 200, signatures: [] });
    await withClient({ AGENT_PRESS_WIRE_HOME: home }, async (call) => {
      const r = await call("announce_launch_newsroom", nr);
      assert.ok(r.isError, label);
      assert.match(r.error, new RegExp(label));
      assert.equal(r.confirm_token, undefined);
      assert.equal(mock.signatures.length, 0);
    });
  }
  assert.equal(existsSync(join(home, "spend.json")), false);
});

test("L4: non-2xx after signing reports not settled per server, with nonce, and still counts", async () => {
  const home = mkdtempSync(join(tmpdir(), "apw-home-"));
  Object.assign(mock, { req: goodReq(), paidStatus: 422, signatures: [] });
  await withClient({ AGENT_PRESS_WIRE_HOME: home, MAX_TOTAL_SPEND_USD: "5" }, async (call) => {
    const q = await call("announce_launch_newsroom", nr);
    const r = await call("announce_launch_newsroom", { ...nr, confirm_token: q.confirm_token });
    assert.ok(r.isError);
    assert.equal(r.charged, undefined);
    assert.equal(r.settled, "not settled per server");
    assert.equal(r.payment.nonce, mock.signatures[0].payload.authorization.nonce);
    assert.match(r.note, /check your wallet/i);
    const q2 = await call("announce_launch_newsroom", nr);
    assert.equal(q2.spend.spent_total_usd, 1);
  });
  const ledger = JSON.parse(readFileSync(join(home, "spend.json"), "utf8"));
  assert.equal(ledger.entries[0].status, "not_settled_per_server");
  server.close();
});
