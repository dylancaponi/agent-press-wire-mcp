// Quote-mode smoke test against production. NEVER pays: no real key, MAX_SPEND_USD=0.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";

async function run(env, calls) {
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, X402_PRIVATE_KEY: "", MAX_SPEND_USD: "0", ...env } });
  const client = new Client({ name: "quote-test", version: "0" });
  await client.connect(transport);
  const out = [];
  for (const [name, args] of calls) {
    const r = await client.callTool({ name, arguments: args });
    out.push({ name, args, isError: !!r.isError, result: JSON.parse(r.content[0].text) });
  }
  const tools = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return { tools, out };
}

const wire = { product_url: "https://hono.dev", city: "Austin", country: "United States", contact_email: "press@example.com", announcement: "test quote" };
const a = await run({}, [
  ["announce_launch_newsroom", { product_url: "https://hono.dev", announcement: "test quote" }],
  ["distribute_press_release", { tier: "wire", ...wire }],
  ["distribute_press_release", { tier: "premium", ...wire }],
  ["get_release_status", { order_id: "w_deadbeef00" }],
  ["get_release_status", { order_id: "not-an-id" }],
]);
// Throwaway unfunded key + MAX_SPEND_USD=0.5: cap below $1 so the rail must still refuse to pay.
const b = await run({ X402_PRIVATE_KEY: generatePrivateKey(), MAX_SPEND_USD: "0.5" }, [["announce_launch_newsroom", { product_url: "https://hono.dev" }]]);

console.log("tools:", a.tools.join(", "));
let pass = true;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${label}`); pass &&= cond; };
const [nr, w, p, s404, sbad] = a.out;
check(`newsroom quote $${nr.result.quote?.price_usd} (${nr.result.reason})`, nr.result.mode === "quote" && nr.result.quote.price_usd === 1 && !nr.result.paid);
check(`wire quote $${w.result.quote?.price_usd}`, w.result.mode === "quote" && w.result.quote.price_usd === 99);
check(`premium quote $${p.result.quote?.price_usd}`, p.result.mode === "quote" && p.result.quote.price_usd === 299);
check(`status 404 handled: ${JSON.stringify(s404.result)}`, s404.isError && s404.result.http_status === 404);
check(`status bad id rejected locally: ${sbad.result.error}`, sbad.isError);
const g = b.out[0].result;
check(`cap rail with key set: ${g.reason}`, g.mode === "quote" && !g.paid);
console.log(JSON.stringify(nr.result, null, 2));
process.exit(pass ? 0 : 1);
