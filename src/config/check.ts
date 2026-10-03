// Layer A proof (run: `npm run config:check`). No network, no side effects - it just
// loads the centralized config and the externalized prompts and prints what took effect,
// so you can confirm the two Layer A guarantees by editing config alone:
//   1. Swap the model    -> set LLM_MODEL in .env, re-run, see the new model here.
//   2. Edit a prompt     -> change prompts.txt, re-run, see the new text here.
// If either the env or prompts.txt is malformed, importing them throws a clear error
// before this prints anything - that's the fail-fast behavior working.

import { config } from "./env.js";
import { prompts } from "../agent/prompts/index.js";
import { repoKey } from "../types/index.js";

function snippet(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

console.log("=== AgentOps v3 config check ===\n");

console.log("LLM:");
console.log(`  model    : ${config.llm.model}`);
console.log(`  base URL : ${config.llm.baseUrl}`);
console.log(`  api key  : ${config.llm.apiKey ? "set" : "MISSING"}\n`);

console.log("Telegram:");
console.log(`  bot token     : ${config.telegram.botToken ? "set" : "MISSING"}`);
console.log(`  allowed users : ${config.telegram.allowedUserIds.size} id(s)`);
console.log(`  webhook secret: ${config.telegram.webhookSecret ? "set" : "not set (local polling)"}\n`);

console.log("GitHub:");
console.log(`  PAT        : ${config.github.pat ? "set" : "MISSING"}`);
console.log(`  playground : ${repoKey(config.github.playgroundRepo)}`);
console.log(
  `  targets    : ${
    config.github.targetRepos.length ? config.github.targetRepos.map(repoKey).join(", ") : "(none configured yet)"
  }\n`
);

console.log("Memory:");
console.log(
  `  Upstash Redis: ${
    config.memory.upstashUrl && config.memory.upstashToken
      ? "configured (persistent)"
      : "not set (in-memory fallback; won't persist across cold starts)"
  }\n`
);

console.log("Prompts (from prompts.txt):");
for (const [key, text] of Object.entries(prompts)) {
  console.log(`  [${key}] ${snippet(text)}`);
}

console.log("\nOK - config and prompts loaded and validated.");
