// Layer B/C/E proof (run: `npm run try:agent -- "<message>"`). Bypasses Telegram and memory, and
// drives the Agent directly so you can watch it reason: pick a repo, read real files, and act.
// As of Layer E the agent chooses the repo itself from your message (name it in the text), so no
// repo argument is needed.
//
// Examples:
//   npm run try:agent -- "In AgentOpsThrowAway, what does this repo do?"
//   npm run try:agent -- "Open a PR in the target repo adding a .gitignore for node."
//   npm run try:agent -- "Read the repo octocat/hello-world and summarize it"   (off-list -> refused)

import { Agent } from "../src/agent/agent.js";
import { allowedRepos } from "../src/github/client.js";

async function main(): Promise<void> {
  const message =
    process.argv.slice(2).join(" ") ||
    `List the files in ${allowedRepos()[0]} and summarize what the repo contains.`;

  console.log(`Allowed repos: ${allowedRepos().join(", ")}`);
  console.log(`Message: ${message}\n--- agent working (tool calls logged below) ---`);

  const agent = new Agent();
  const reply = await agent.reply(message);

  console.log("\n--- reply ---\n");
  console.log(reply);
}

main().catch((err) => {
  console.error("\nAgent run failed:", err?.message ?? err);
  process.exit(1);
});
