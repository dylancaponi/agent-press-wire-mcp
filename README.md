# Agent Press Wire MCP server

An MCP server that lets AI agents (Claude Desktop, Claude Code, Cursor, any MCP client) announce product launches and distribute press releases through [Agent Press Wire](https://agentpresswire.dev). Each call is paid in USDC on Base over [x402](https://x402.org), from **your own wallet**. No account, no API key.

## Tools

| Tool | Price | What it does |
| --- | --- | --- |
| `announce_launch_newsroom` | $1 USDC | Drafts a 350-450 word AP-style press release from your product URL and publishes it on a public, search-indexed newsroom page. About 20 seconds. |
| `distribute_press_release` | `tier: "wire"` $99 USDC, `tier: "premium"` $299 USDC | Drafts a 450-600 word release and distributes it over a newswire to 500+ news sites plus 100+ TV and radio network sites. Premium adds AP News, USA Today, Barchart and StreetInsider. Requires `city`, `country`, `contact_email`. Returns an `order_id`. |
| `get_release_status` | Free | Status and live coverage links for a wire order. |

The service only charges when the job succeeds. Failed drafts, rejected topics and wire rejections are not charged.

## Bring your own copy

Both paid tools accept optional `headline` and `body`. When both are given, Agent Press Wire skips drafting and publishes or distributes the text as written (only a media contact line may be appended). Requirements: plain English text, paragraphs separated by blank lines, body 150 to 900 words (380 to 900 for the wire tiers), a 3 to 20 word headline naming the announcing company, at most 5 links and only to the product's own site. The copy goes through the same safety checks as a drafted release (prohibited topics, market-moving claims on wire tiers, brand must match the page, link policy, model safety review); failures come back uncharged with the reasons.

## Pictures

By default the release uses the picture the product page shares (`og:image`, else `twitter:image`). Pass `image_url` (a public http(s) URL or a `data:image/...;base64` URI, PNG/JPEG/WebP/GIF, max 1 MB) with optional `image_alt` (max 125 characters) and `image_caption` (max 300) to choose it, or `no_image: true` for none. With your own `headline` and `body` you can also pass up to 3 inline pictures in `images` (`[{url, alt, caption}]`), placed at `[image 1]`, `[image 2]`, `[image 3]` lines in the body. Every picture gets a safety review before charging; a picture you supply that fails returns an uncharged error with the reason, and a page picture that fails is left out.

## Safety: quote mode by default

Paid tools **charge real USDC**. Settings that control spending:

- `X402_PRIVATE_KEY`: private key of your own Base wallet holding USDC. Without it the server only quotes.
- `MAX_SPEND_USD`: the most the server may pay for a single call. Default `0`, which means quote only: every paid tool returns the x402 price terms and never pays.
- `MAX_TOTAL_SPEND_USD`: lifetime cap across all calls and restarts. Defaults to `MAX_SPEND_USD`, so out of the box you get at most one paid call until you raise it. Spend is tracked in a ledger at `~/.agent-press-wire/spend.json` (override the directory with `AGENT_PRESS_WIRE_HOME`). Every signed payment authorization is counted, whatever the HTTP outcome, because the server could still settle it until it expires. If a call failed and your wallet shows no transfer for its nonce after `valid_before`, you can delete that entry from the ledger.

Paying takes two calls. The first call (without `confirm_token`, or with `quote_only: true`) returns the price and a `confirm_token`. The agent shows the user the exact price, and after the user approves it calls again with the **same parameters** and that `confirm_token`. Tokens are single use, expire after 10 minutes, and are bound to the endpoint, a hash of the request parameters and the price.

A payment only happens when all of these hold:

- the key is set, the price is at or below `MAX_SPEND_USD`, and the lifetime total stays at or below `MAX_TOTAL_SPEND_USD`;
- a valid `confirm_token` was passed and `quote_only` is not true;
- the server's x402 terms match values pinned in this package: pay to `0xF7887C1fAf0DbAedc80C78F9D396D594B69eba95`, exactly $1 for `/v1/press-release`, $99 for `/v1/wire-release`, $299 for `/v1/wire-release/premium`, USDC on Base mainnet, scheme `exact` with an EIP-3009 transfer authorization, and `maxTimeoutSeconds` of 600 or less. Any mismatch is refused, so a compromised server or a wrong `PRESS_API_URL` cannot redirect funds or raise the price.

The per-call cap is enforced twice: by this server before signing, and by the x402 client's own spend controls.

If a paid call fails after the authorization was signed, the result says the payment was **not settled per the server** and includes the authorization `nonce`, `valid_before` and payer address. Check your wallet before retrying.

Examples: `MAX_SPEND_USD=1 MAX_TOTAL_SPEND_USD=5` allows up to five $1 newsroom releases and only quotes the wire tiers. `MAX_SPEND_USD=99 MAX_TOTAL_SPEND_USD=99` allows one standard wire release. Use a dedicated wallet funded with only what you intend to spend.

## Install

Requires Node 20+.

### Claude Code

```bash
claude mcp add agent-press-wire \
  -e X402_PRIVATE_KEY=0xYOUR_KEY -e MAX_SPEND_USD=1 -e MAX_TOTAL_SPEND_USD=5 \
  -- npx -y agent-press-wire-mcp
```

Quote only (no wallet): `claude mcp add agent-press-wire -- npx -y agent-press-wire-mcp`

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-press-wire": {
      "command": "npx",
      "args": ["-y", "agent-press-wire-mcp"],
      "env": {
        "X402_PRIVATE_KEY": "0xYOUR_KEY",
        "MAX_SPEND_USD": "1",
        "MAX_TOTAL_SPEND_USD": "5"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "agent-press-wire": {
      "command": "npx",
      "args": ["-y", "agent-press-wire-mcp"],
      "env": {
        "X402_PRIVATE_KEY": "0xYOUR_KEY",
        "MAX_SPEND_USD": "1",
        "MAX_TOTAL_SPEND_USD": "5"
      }
    }
  }
}
```

Other clients: run `npx -y agent-press-wire-mcp` as a stdio server with the same environment variables.

## Vercel AI SDK

The same service is available as AI SDK tools from the `agent-press-wire-mcp/ai-sdk` subpath. Requires `ai` 7 or later.

```bash
npm install agent-press-wire-mcp ai viem
```

```ts
import { generateText, isStepCount } from 'ai';
import { agentPressWireTools } from 'agent-press-wire-mcp/ai-sdk';
import { privateKeyToAccount } from 'viem/accounts';

const tools = agentPressWireTools({
  wallet: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  maxPaymentUsd: 1,
});

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  prompt: 'We just shipped v2 of https://example.com with offline sync. Publish a press release about it.',
  tools,
  stopWhen: isStepCount(3),
});
```

| Tool | Price | What it does |
| --- | --- | --- |
| `quotePressRelease` | Free | Price of a tier (`newsroom`, `wire`, `premium`) and whether this tool set may pay it. Never signs anything. |
| `publishPressRelease` | $1 USDC | Same as `announce_launch_newsroom` above. |
| `distributePressRelease` | $99 or $299 USDC | Same as `distribute_press_release` above. |
| `getReleaseStatus` | Free | Status and links for a wire order. |

Options:

- `wallet`: a viem account (or any x402 EVM signer) holding USDC on Base. Without it the paid tools only return quotes.
- `maxPaymentUsd`: most one call may pay. Default `1`, so the newsroom release works and the wire tiers only quote. Set `99` or `299` to allow those.
- `maxTotalUsd`: most the tool set may pay across all calls. Defaults to `maxPaymentUsd`, so one paid call.
- `baseUrl`, `fetch`, `timeoutMs`: for testing and proxies. Payment terms are pinned the same way as in the MCP server, so a different `baseUrl` cannot change the payee or the price.

The model cannot change these limits. Each paid tool reads the server's 402 terms first and pays only if they match the pinned wallet and price and the caps allow it.

Every paid tool returns an object with `status` and `charged`:

- `paid`, `charged: true`: the job succeeded and the service settled the payment. `result` holds the release or the wire order.
- `not_paid`, `charged: false`: nothing was signed, for example no wallet or the price is over a cap. `quote` holds the price.
- `rejected`, `charged: false`: the service refused the job (HTTP 422 for bad input or a topic it does not accept, 409 for a duplicate, 502 or 503 for a failure on its side). `error` and `details` say what to fix. The service does not settle failed jobs, so these do not count toward `maxTotalUsd`.
- `unknown`, `charged: "unknown"`: the network failed after a payment authorization was sent. Check the wallet for the `nonce` before retrying. This one keeps counting toward `maxTotalUsd`.

To have a person approve the wire tiers, use the AI SDK's approval setting: `toolApproval: { distributePressRelease: 'user-approval' }` in `generateText` or `streamText`.

Integration guide: https://agentpresswire.dev/docs/ai-sdk

## Example prompts

- "Announce my launch: https://example.com, we just shipped v2 with offline mode."
- "Write and distribute a press release for https://example.com. We're in Austin, United States, press@example.com."
- "How much would it cost to get press coverage for my product?" (the agent calls with `quote_only: true`)
- After the user approves a quoted price, the agent repeats the call with the returned `confirm_token`.
- "Check the status of press release w_3f9d0a1b2c."

## Quote response

```json
{
  "mode": "quote",
  "paid": false,
  "reason": "no confirm_token: this was a quote",
  "quote": { "price_usd": 99, "asset": "USDC", "network": "Base mainnet (eip155:8453)", "pay_to": "0xF7887C1fAf0DbAedc80C78F9D396D594B69eba95" },
  "spend": { "spent_total_usd": 0, "max_total_spend_usd": 99, "max_spend_usd": 99 },
  "confirm_token": "ct1.1791069332201.6cba...d563",
  "confirm_token_expires_in_seconds": 600
}
```

## Development

```bash
npm install
npm run build
npm test             # offline guard-rail tests against a localhost mock x402 server; never pays
npm run test:quote   # quote-mode smoke test against production; never pays
npx @modelcontextprotocol/inspector node dist/index.js
```

`PRESS_API_URL` overrides the API base URL for testing.

## License

MIT
