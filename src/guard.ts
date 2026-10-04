// Payment guard rails for the Agent Press Wire MCP server (audit item M2).
// Pure, testable pieces: pinned payment terms, confirm tokens, and the persisted spend ledger.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NETWORK = "eip155:8453"; // Base mainnet
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const USDC_DECIMALS = 6;
/** Agent Press Wire's receiving wallet. Hard-coded so a compromised server or PRESS_API_URL cannot redirect funds. */
export const PAY_TO = "0xF7887C1fAf0DbAedc80C78F9D396D594B69eba95";
/** Expected price per endpoint, in atomic USDC (6 decimals). Any other amount is refused. */
export const EXPECTED_ATOMIC: Readonly<Record<string, string>> = Object.freeze({
  "/v1/press-release": "1000000",
  "/v1/wire-release": "99000000",
  "/v1/wire-release/premium": "299000000",
});
export const MAX_TIMEOUT_SECONDS = 600;
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

export const usdToAtomic = (usd: number): bigint => BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
export const atomicToUsd = (atomic: bigint | string): number => Number(BigInt(atomic)) / 10 ** USDC_DECIMALS;

/** Minimal shape of an x402 payment requirement that we check. */
export interface Requirement {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** Returns null when the 402 terms match what we expect for this endpoint, else a human-readable reason. */
export function checkPinnedTerms(path: string, req: Requirement): string | null {
  const expected = EXPECTED_ATOMIC[path];
  if (!expected) return `no pinned price for endpoint ${path}`;
  if (req.scheme !== "exact") return `unexpected x402 scheme ${JSON.stringify(req.scheme)} (expected "exact")`;
  if (req.network !== NETWORK) return `unexpected network ${JSON.stringify(req.network)} (expected ${NETWORK})`;
  if (String(req.asset ?? "").toLowerCase() !== USDC_BASE) return `unexpected asset ${JSON.stringify(req.asset)} (expected USDC on Base)`;
  const method = req.extra?.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") return `unexpected assetTransferMethod ${JSON.stringify(method)} (only eip3009 is allowed)`;
  if (String(req.payTo ?? "").toLowerCase() !== PAY_TO.toLowerCase()) return `payTo ${JSON.stringify(req.payTo)} does not match the pinned Agent Press Wire wallet ${PAY_TO}`;
  if (String(req.amount) !== expected) return `amount ${JSON.stringify(req.amount)} does not match the pinned price ${expected} atomic USDC ($${atomicToUsd(expected)}) for ${path}`;
  const t = req.maxTimeoutSeconds;
  if (typeof t !== "number" || !Number.isInteger(t) || t <= 0 || t > MAX_TIMEOUT_SECONDS)
    return `maxTimeoutSeconds ${JSON.stringify(t)} is outside 1..${MAX_TIMEOUT_SECONDS}`;
  return null;
}

// ---------- confirm tokens ----------

/** Stable JSON: sorted keys, undefined dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const paramsHash = (path: string, body: unknown): string =>
  createHash("sha256").update(`${path}\n${canonicalJson(body)}`).digest("hex");

/**
 * Issues and verifies single-use confirm tokens. A token is bound to the endpoint, a hash of the
 * request params and the quoted amount, signed with a per-process random secret, and expires.
 */
export class ConfirmTokens {
  private readonly secret: Buffer;
  private readonly used = new Map<string, number>();
  constructor(
    private readonly ttlMs = CONFIRM_TTL_MS,
    secret?: Buffer,
  ) {
    this.secret = secret ?? randomBytes(32);
  }

  private mac(exp: number, path: string, body: unknown, amount: string): string {
    return createHmac("sha256", this.secret).update(`${exp}|${path}|${paramsHash(path, body)}|${amount}`).digest("hex");
  }

  issue(path: string, body: unknown, amount: string, now = Date.now()): string {
    const exp = now + this.ttlMs;
    return `ct1.${exp}.${this.mac(exp, path, body, amount)}`;
  }

  /** Returns null if valid (and marks the token used), else the reason it was rejected. */
  consume(token: string, path: string, body: unknown, amount: string, now = Date.now()): string | null {
    for (const [t, exp] of this.used) if (exp < now) this.used.delete(t);
    const m = /^ct1\.(\d{13,})\.([0-9a-f]{64})$/.exec(token.trim());
    if (!m) return "confirm_token is malformed";
    const exp = Number(m[1]);
    const want = Buffer.from(this.mac(exp, path, body, amount), "hex");
    const got = Buffer.from(m[2], "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got))
      return "confirm_token does not match this endpoint, these exact parameters and this price (or was issued by another server process)";
    if (exp < now) return "confirm_token has expired";
    if (this.used.has(m[2])) return "confirm_token was already used";
    this.used.set(m[2], exp);
    return null;
  }
}

// ---------- spend ledger ----------

export interface LedgerEntry {
  ts: string;
  endpoint: string;
  amount_atomic: string;
  pay_to: string;
  nonce: string | null;
  valid_before: string | null;
  status: "signed" | "settled" | "not_settled_per_server" | "unknown_network_error";
  http_status?: number;
}
export interface Ledger {
  version: 1;
  entries: LedgerEntry[];
}

export const ledgerDir = (): string => process.env.AGENT_PRESS_WIRE_HOME || join(homedir(), ".agent-press-wire");
export const ledgerPath = (dir = ledgerDir()): string => join(dir, "spend.json");

/** Loads the ledger. Missing file means empty. A corrupt file throws, so the caller fails closed. */
export function loadLedger(dir = ledgerDir()): Ledger {
  const p = ledgerPath(dir);
  if (!existsSync(p)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as Ledger;
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error(`spend ledger ${p} is not a valid version 1 ledger`);
  for (const e of parsed.entries) BigInt(e.amount_atomic); // throws on garbage
  return parsed;
}

export function saveLedger(ledger: Ledger, dir = ledgerDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = ledgerPath(dir);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * Every signed authorization counts toward the total, whatever the HTTP outcome, because the
 * server holds a settleable authorization until valid_before. Remove an entry by hand only after
 * confirming on-chain that it never settled.
 */
export const totalSpentAtomic = (ledger: Ledger): bigint => ledger.entries.reduce((s, e) => s + BigInt(e.amount_atomic), 0n);

/** Returns null if paying `amount` keeps the lifetime total within the cap, else the reason. */
export function checkTotalCap(ledger: Ledger, amountAtomic: bigint, maxTotalUsd: number): string | null {
  const spent = totalSpentAtomic(ledger);
  const cap = usdToAtomic(maxTotalUsd);
  if (spent + amountAtomic > cap)
    return `paying $${atomicToUsd(amountAtomic)} would bring total spend to $${atomicToUsd(spent + amountAtomic)}, over MAX_TOTAL_SPEND_USD=${maxTotalUsd} (already spent $${atomicToUsd(spent)} per ${ledgerPath()})`;
  return null;
}

/** Serializes ledger check + write within this process so concurrent calls cannot both pass the cap. */
let chain: Promise<unknown> = Promise.resolve();
export function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
