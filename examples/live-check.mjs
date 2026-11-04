// Live end-to-end check of the AI SDK tools against the real service.
// A scripted mock model (no model-provider key needed) calls publishPressRelease
// once through generateText; the tool then pays the live endpoint with x402.
//
//   BUYER_KEY=0x... node examples/live-check.mjs            # free: quote only
//   BUYER_KEY=0x... node examples/live-check.mjs --pay      # spends $1 USDC on Base
//
// Needs `npm run build` first (imports dist/) and `ai` 7 installed (dev dependency).
import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { privateKeyToAccount } from "viem/accounts";
import { agentPressWireTools } from "../dist/ai-sdk.js";

const pay = process.argv.includes("--pay");
const key = process.env.BUYER_KEY;
if (!key) throw new Error("set BUYER_KEY to a funded Base wallet private key");
const wallet = privateKeyToAccount(key);

// Tag our own test traffic so the service's stats can tell it apart.
const ua = process.env.LIVE_CHECK_UA || "agent-press-wire-mcp-live-check/0.3.0";
const taggedFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), "user-agent": ua } });

const tools = agentPressWireTools({ wallet, maxPaymentUsd: 1, fetch: taggedFetch });

const release = {
  product_url: process.env.PRODUCT_URL || "https://agentpresswire.dev",
  announcement:
    process.env.ANNOUNCEMENT ||
    "Agent Press Wire 0.3.0 adds Vercel AI SDK tools: import agentPressWireTools from agent-press-wire-mcp/ai-sdk to quote, publish or distribute a press release from an AI SDK agent, with a per-call spend cap the model cannot raise and payment terms pinned in the package.",
};

const quote = await tools.quotePressRelease.execute({ tier: "newsroom" }, { toolCallId: "q1", messages: [] });
console.log("quote:", JSON.stringify(quote));
if (!pay) {
  console.log("dry run only (pass --pay to spend $1).");
  process.exit(0);
}

let step = 0;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV4({
  doGenerate: async () => {
    step++;
    if (step === 1)
      return {
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "publishPressRelease", input: JSON.stringify(release) }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      };
    return { content: [{ type: "text", text: "Published." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
  },
});

const res = await generateText({ model, prompt: "Announce the 0.3.0 release.", tools, stopWhen: isStepCount(3) });
const tr = res.steps.flatMap((s) => s.toolResults)[0];
console.log("text:", res.text);
console.log("tool:", tr?.toolName);
console.log("output:", JSON.stringify(tr?.output, null, 2));
