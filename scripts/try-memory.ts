// Layer D proof (run: `npm run try:memory -- "<message>"`). Drives the memory-backed conversation
// seam directly (no Telegram). It uses a FIXED chat id, so running it repeatedly in separate
// processes simulates serverless cold starts hitting the same conversation. The agent picks which
// allowed repo to use from your message (Layer E), so no repo argument is needed.
//
// Prove persistence across a cold start (two separate processes):
//   npm run try:memory -- "My name is Abdu and my favorite file in AgentOpsThrowAway is tip.js."
//   npm run try:memory -- "Without me repeating them, what's my name and which file did I say I liked?"
//
// With Upstash creds set, the SECOND command (a brand-new process) still knows the answer.

import { handleMessage } from "../src/agent/conversation.js";
import { memory } from "../src/memory/store.js";

// Stable id so every run shares one conversation (that's the whole point of the cold-start test).
const DEMO_CHAT_ID = 999_000_001;

async function main(): Promise<void> {
  const message = process.argv.slice(2).join(" ") || "What have we talked about so far?";

  const priorCount = (await memory.load(DEMO_CHAT_ID)).length;
  console.log(`Chat ${DEMO_CHAT_ID} - ${priorCount} message(s) already in memory.`);
  console.log(`You: ${message}\n--- agent working ---`);

  const reply = await handleMessage(DEMO_CHAT_ID, message);

  console.log("\n--- reply ---\n");
  console.log(reply);
  console.log(`\n(memory now holds ${(await memory.load(DEMO_CHAT_ID)).length} messages for this chat)`);
}

main().catch((err) => {
  console.error("\nMemory run failed:", err?.message ?? err);
  process.exit(1);
});
