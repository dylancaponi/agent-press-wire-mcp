import { generateText, isStepCount } from 'ai';
import { agentPressWireTools } from 'agent-press-wire-mcp/ai-sdk';
import { privateKeyToAccount } from 'viem/accounts';

// Paid calls spend real USDC on Base from this wallet. maxPaymentUsd caps each
// call (default $1, enough for a newsroom release; the $99 and $299 wire tiers
// need a higher cap) and the model cannot raise it.
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

console.log(text);
