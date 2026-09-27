import "dotenv/config";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
}

if (process.env.ALLOWED_TELEGRAM_USER_IDS === undefined) {
  throw new Error(
    "ALLOWED_TELEGRAM_USER_IDS is not set. Add it to .env (can be empty at first - run the bot, " +
      "message it, and your rejected user ID will be logged below so you can add it)."
  );
}

const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
if (!deepseekApiKey) {
  throw new Error("DEEPSEEK_API_KEY is not set. Copy .env.example to .env and fill it in.");
}

// Explicit timeouts on both clients: without one, a request stuck on a dead connection (e.g. a
// socket left open across a laptop sleep/resume cycle) hangs forever with no error and no trace
// on either provider's dashboard - "Thinking..." never gets replaced. Failing fast surfaces that
// as a normal error reply instead of silence.
//
// Two separate ceilings, not one shared value: Octokit calls are small metadata/blob round trips
// and 30s comfortably catches a genuinely stuck one. DeepSeek's draftCodeAndTests call can be
// asked to generate full content for a dozen-plus files in one completion (milestones have no
// file-count cap by design) - real generation time scales with that, so it needs real headroom,
// not the same "detect a dead socket" budget. Both stay well under Telegraf's 280s handler ceiling.
const OCTOKIT_TIMEOUT_MS = 30_000;
const DEEPSEEK_TIMEOUT_MS = 180_000;

// Telegram rejects any single message over this length with 400 MESSAGE_TOO_LONG - a long
// DeepSeek reply (e.g. a detailed plan) must be split before sending, not just before formatting.
const TELEGRAM_MESSAGE_LIMIT = 4096;

function splitForTelegram(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    // Prefer breaking on the last newline before the limit so we don't split mid-sentence or
    // mid-Markdown-token; fall back to a hard cut if there's no newline to break on.
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) {
      cut = limit;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

// The SDK already retries connection-level errors (ECONNRESET, etc.) automatically with backoff -
// default maxRetries is 2 (3 total attempts). Raised here because a real failure mode hit was all
// 3 attempts hitting ECONNRESET back to back on an unstable link (VPN over a flaky connection),
// not a code bug - more attempts, not different handling, is the right response to that.
const deepseek = new OpenAI({
  apiKey: deepseekApiKey,
  baseURL: "https://api.deepseek.com",
  timeout: DEEPSEEK_TIMEOUT_MS,
  maxRetries: 5,
});

// Structured diagnostics for the DeepSeek calls that can fail silently. An empty, truncated, or
// unparseable completion comes back as a normal HTTP 200 (finish_reason=stop, no thrown error), so
// nothing in the stack logs it - the failure just collapses into a generic "couldn't do it" reply.
// deepseek-v4-flash is a reasoning model whose hidden reasoning-token burn is large and highly
// variable (measured 13k-29k tokens on byte-identical input, ~60% of runs producing unusable
// output on a logic-heavy milestone), which is the dominant cause of those failures. Logging
// finish_reason + token usage + the specific reject reason turns each one into a one-line record.
function logCompletion(label: string, completion: OpenAI.Chat.Completions.ChatCompletion): void {
  const choice = completion.choices[0];
  const usage = completion.usage;
  console.log(
    `[deepseek] ${label}: finish_reason=${choice?.finish_reason ?? "?"} ` +
      `content_len=${choice?.message?.content?.length ?? 0} ` +
      `completion_tokens=${usage?.completion_tokens ?? "?"} ` +
      `reasoning_tokens=${usage?.completion_tokens_details?.reasoning_tokens ?? "?"} ` +
      `prompt_tokens=${usage?.prompt_tokens ?? "?"}`
  );
}

function logCompletionReject(label: string, reason: string): void {
  console.warn(`[deepseek] ${label}: REJECTED - ${reason}`);
}

const githubPat = process.env.GITHUB_PAT;
if (!githubPat) {
  throw new Error("GITHUB_PAT is not set. Copy .env.example to .env and fill it in.");
}

const octokit = new Octokit({ auth: githubPat });

// AbortSignal.timeout() fires once and then stays aborted forever, so it can't be set once at
// construction time - it has to be a fresh signal on every request. This hook applies that to
// every octokit.rest.* call without needing to touch each of the many call sites individually.
octokit.hook.before("request", (options) => {
  options.request.signal = AbortSignal.timeout(OCTOKIT_TIMEOUT_MS);
});

type RepoRef = { owner: string; repo: string };

function parseRepoEnv(envName: string): RepoRef {
  const full = process.env[envName];
  if (!full) {
    throw new Error(`${envName} is not set. Add it to .env (format: owner/repo).`);
  }
  const [owner, repo] = full.split("/");
  if (!owner || !repo) {
    throw new Error(`${envName} must be in "owner/repo" format, got: ${full}`);
  }
  return { owner, repo };
}

// PLAYGROUND / TARGET: PLAYGROUND is the agent's scratch space for the autonomous milestone builder
// (off by default - see builderEnabled) AND now also holds the small conversation-continuity state
// file (.agent-state/<chatId>.json) for the client-facing flow, so a "which repo?" question survives
// between serverless invocations. TARGET is where a finished roadmap is promoted via one PR. Both are
// named explicitly - never "any repo the model mentions." (The PAT needs write access to PLAYGROUND.)
const playgroundRepo = parseRepoEnv("GITHUB_PLAYGROUND_REPO");
const targetRepo = parseRepoEnv("GITHUB_TARGET_REPO");

// The autonomous multi-milestone builder is OFF by default. It's powerful but brittle on a
// serverless/webhook backend: long, reasoning-heavy builds fight a hard function-duration cap. The
// reliable, client-facing path is the single focused change -> one PR flow below. Turn this on
// ("true") only on infra that can carry long-running builds.
const builderEnabled = (process.env.ENABLE_AUTONOMOUS_BUILDER ?? "").trim().toLowerCase() === "true";

// Repos the single-PR flow may open PRs / issues into: an explicit, named allow-list - never
// org-wide, never repo-creation (the CLAUDE.md security line). Defaults to just the target repo so
// existing single-repo setups keep working; set GITHUB_PR_REPOS="owner/a,owner/b" to let one bot
// serve several repos. The first entry is the default when a message names no repo.
function parseRepoList(envName: string): RepoRef[] {
  const raw = process.env[envName];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((full) => {
      const [owner, repo] = full.split("/");
      if (!owner || !repo) throw new Error(`${envName} entry "${full}" must be in "owner/repo" format.`);
      return { owner, repo };
    });
}
const configuredPrRepos = parseRepoList("GITHUB_PR_REPOS");
const singlePrRepos: RepoRef[] = configuredPrRepos.length > 0 ? configuredPrRepos : [targetRepo];
const defaultPrRepo = singlePrRepos[0];

const allowedRepoKeys = new Set([playgroundRepo, targetRepo, ...singlePrRepos].map((r) => `${r.owner}/${r.repo}`));

function assertRepoAllowed(repo: RepoRef): void {
  const key = `${repo.owner}/${repo.repo}`;
  if (!allowedRepoKeys.has(key)) {
    throw new Error(`Refusing to act on "${key}" - not on the repo allow-list (${[...allowedRepoKeys].join(", ")}).`);
  }
}

const allowedUserIds = new Set(
  process.env.ALLOWED_TELEGRAM_USER_IDS.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map(Number)
);

// Telegraf wraps every update in its own internal timeout (default 90s) and, if that fires,
// its DEFAULT error handler logs and then re-throws - crashing the whole process outright,
// bypassing our own try/catch entirely since that catch lives inside the timed-out handler,
// not around Telegraf's wrapper. Two changes, together:
// 1. Raise the ceiling to just under Vercel Hobby's hard 300s function duration limit (see
//    DEPLOYMENT.md / decisions.md Layer 5) - a milestone that can't finish within that window
//    won't work once deployed either, so local dev should hit the same wall, not a tighter one.
// 2. Register a real handler so hitting that ceiling (or any other unexpected error) reports
//    a friendly message and the process survives, instead of crashing outright.
export const bot = new Telegraf(token, { handlerTimeout: 280_000 });

bot.catch((err, ctx) => {
  console.error("Unhandled error while processing update:", err);
  ctx.reply("Sorry, something went wrong (or took too long) handling that. Try again, or with a smaller request.").catch((replyErr) => {
    console.error("Couldn't even send the error reply:", replyErr);
  });
});

bot.use((ctx, next) => {
  const senderId = ctx.from?.id;
  if (senderId === undefined || !allowedUserIds.has(senderId)) {
    console.log(`Ignored message from unauthorized user ID: ${senderId}`);
    return;
  }
  return next();
});

const TELEGRAM_FORMATTING_NOTE =
  "This text is shown directly in Telegram, not GitHub, so format it for Telegram's Markdown: " +
  "use *word* (single asterisks) for bold, _word_ for italic, no ## headers, no markdown tables, plain paragraphs.";

// CI (.github/workflows/test.yml in playground) auto-detects ONE of these ecosystems by its
// marker file and runs that ecosystem's fixed, human-written test command - there's no support
// beyond this list, and a milestone outside it means CI silently has nothing to run. Keep this
// list and the workflow file in sync by hand; there's no single source of truth to avoid that.
const SUPPORTED_ECOSYSTEMS =
  "Node/TypeScript (marker: package.json; tests: test/*.test.ts using node:test, run via `npm test`), " +
  "Python (marker: requirements.txt or pyproject.toml; tests: test_*.py using pytest), " +
  "Go (marker: go.mod; tests: *_test.go using the standard `testing` package), " +
  "Rust (marker: Cargo.toml; tests: #[test] functions, run via `cargo test`), " +
  "Java/Maven (marker: pom.xml; tests: JUnit under src/test/java), " +
  "Ruby (marker: Gemfile; tests: RSpec under spec/), " +
  ".NET (marker: a .csproj or .sln file; tests: any .NET test framework, run via `dotnet test`)";

const STACK_NOTE =
  "Pick ONE of these supported ecosystems for this milestone, matching whatever the repo already " +
  `established in earlier milestones unless there's a good reason to switch: ${SUPPORTED_ECOSYSTEMS}. ` +
  "CI auto-detects the ecosystem from its marker file and runs that ecosystem's fixed test command - " +
  "include the right marker file, and use that ecosystem's idiomatic test file location/framework " +
  "exactly as described above, or CI will have nothing to run.";

// Real, measured constraint (not an arbitrary guess): a single milestone build - drafting code
// and tests via DeepSeek, then committing - has to finish inside one serverless function call,
// which is hard-capped at a few minutes on the current hosting plan. Milestones with a dozen-plus
// files have repeatedly blown past that ceiling. Keep milestones small enough to comfortably fit;
// bump this only after the hosting plan's own duration limit is raised.
const MAX_FILES_PER_MILESTONE = 4;
const MAX_ARTIFACTS_PER_MILESTONE = MAX_FILES_PER_MILESTONE * 2; // + roughly one test file each

const MILESTONE_SIZE_NOTE =
  `Each milestone must be small enough to draft and commit inside one short automated build cycle: ` +
  `at most ${MAX_FILES_PER_MILESTONE} source/target files (plus their tests). If a genuinely useful slice would ` +
  "need more than that, split it into two or more smaller milestones instead of cramming it into one - " +
  "many small milestones are strongly preferred over a few large ones. Keep any sample/fixture data " +
  "minimal (a handful of representative rows/fields), never an exhaustive dataset.";

type Intent = "chat" | "issue" | "pr";

async function classifyIntent(message: string): Promise<Intent> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Classify the developer's Telegram message into exactly one intent for a GitHub agent. " +
          'Reply with ONLY a json object shaped like {"intent": "chat" | "issue" | "pr"}. ' +
          '"issue" = they want a bug/task tracked as a GitHub issue (reporting a problem, asking to file/log something). ' +
          '"pr" = they want an actual file/code change made (a new request to change or create something). ' +
          '"chat" = anything else: greetings, questions, general conversation, or anything unclear. ' +
          'If you are not confident it is "issue" or "pr", choose "chat".',
      },
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return "chat";
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed.intent === "issue" || parsed.intent === "pr") {
      return parsed.intent;
    }
  } catch {
    // falls through to the safe "chat" default below
  }
  return "chat";
}

function fallbackIssueFields(message: string): { title: string; body: string } {
  const firstLine = message.split("\n")[0].trim();
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  return { title: title || "Untitled issue", body: message };
}

async function interpretAsIssue(message: string): Promise<{ title: string; body: string }> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You turn a developer's message into a GitHub issue. Reply with ONLY a json object " +
          'shaped like {"title": "short summary", "body": "fuller description"} and nothing else.',
      },
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return fallbackIssueFields(message);
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.title === "string" && typeof parsed.body === "string" && parsed.title.trim()) {
      return { title: parsed.title, body: parsed.body };
    }
  } catch {
    // fall through to heuristic fallback below
  }
  return fallbackIssueFields(message);
}

function isSafeRepoPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("..");
}

// "ref" rather than "defaultBranch" - this is also used against in-progress feature branches
// once a build spans several milestones on one persistent playground branch.
async function fetchRepoFileList(repo: RepoRef, ref: string): Promise<string[]> {
  assertRepoAllowed(repo);
  try {
    const { data: tree } = await octokit.rest.git.getTree({
      owner: repo.owner,
      repo: repo.repo,
      tree_sha: ref,
      recursive: "true",
    });
    return tree.tree
      .filter((entry): entry is typeof entry & { path: string } => entry.type === "blob" && typeof entry.path === "string")
      .map((entry) => entry.path)
      .slice(0, 300);
  } catch (err) {
    if ((err as { status?: number }).status === 409) {
      return []; // empty repo, no commits yet
    }
    throw err;
  }
}

async function fetchFile(repo: RepoRef, path: string, ref: string): Promise<{ content: string; sha: string } | null> {
  assertRepoAllowed(repo);
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: repo.owner, repo: repo.repo, path, ref });
    if (!Array.isArray(data) && data.type === "file" && data.content) {
      return { content: Buffer.from(data.content, "base64").toString("utf-8"), sha: data.sha };
    }
    return null;
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return null;
    }
    throw err;
  }
}

// A repo's default branch doesn't change mid-flight, and this is called several times per request
// (plus once per message now that state is read every time) - so memoise it per repo to cut GitHub
// round trips. The cache lives for the process; on serverless that's effectively per-invocation.
const defaultBranchCache = new Map<string, string>();
async function getDefaultBranch(repo: RepoRef): Promise<string> {
  assertRepoAllowed(repo);
  const key = `${repo.owner}/${repo.repo}`;
  const cached = defaultBranchCache.get(key);
  if (cached) return cached;
  const { data: repoInfo } = await octokit.rest.repos.get({ owner: repo.owner, repo: repo.repo });
  defaultBranchCache.set(key, repoInfo.default_branch);
  return repoInfo.default_branch;
}

// ---------------------------------------------------------------------------
// Pipeline state - stored as a file inside the playground repo, not in memory.
// A serverless webhook invocation shares no memory with the next one, and a
// roadmap (roadmap -> N milestones, each: plan -> approve -> code+tests -> CI
// -> next) can span minutes to hours. Reusing GitHub access we already have
// avoids needing a database for that durability. State here only ever holds
// small text/paths, never full file content - the actual code lives in git
// commits on the branch; content is re-fetched from there when needed, never
// duplicated into this JSON.
// ---------------------------------------------------------------------------

type FileChange = { path: string; content: string };

type Milestone = { name: string; goal: string };

// Shared by every phase from "roadmap approved" onward: the overall roadmap, the one
// long-lived playground branch every milestone commits onto, and every path written so
// far (so the final promotion knows exactly what to copy into target).
type RoadmapFields = {
  originalMessage: string;
  roadmapText: string;
  milestones: Milestone[];
  branchName: string;
  logPath: string;
  touchedPaths: string[];
};

type MilestoneCodeFields = RoadmapFields & {
  milestoneIndex: number;
  milestonePlanText: string;
  filePaths: string[];
  testPaths: string[];
  commitMessage: string;
  milestoneSummary: string;
};

// Each phase is its own variant (not a union'd "phase" field on one shared shape) so that
// Extract<PipelineState, { phase: "..." }> narrows correctly at every call site below.
// What a just-opened single PR touched, remembered so the user can promote the SAME change into
// another allowed repo (the playground -> target bridge, CLAUDE.md Section 4) without the agent
// having to re-plan or re-know what it built. Content isn't stored - it's re-read from the branch.
type LastPrFields = {
  sourceRepo: RepoRef;
  branch: string;
  paths: string[];
  requestMessage: string;
  prUrl: string;
};

type PipelineState =
  // Client-facing (builder-off) flow: we asked "which repo?" and are holding the original request
  // until the user answers, so the answer and the remembered request can be combined.
  | { phase: "awaiting_repo_choice"; pendingMessage: string; pendingIntent: "issue" | "pr" }
  // A single PR was just opened; the user may ask to promote the same change into another repo.
  | ({ phase: "pr_opened" } & LastPrFields)
  // Promote was requested but the destination repo was unclear; waiting for the user to name it.
  | ({ phase: "awaiting_promote_target" } & LastPrFields)
  | { phase: "roadmap_pending"; originalMessage: string; roadmapText: string; milestones: Milestone[] }
  | ({ phase: "milestone_plan_pending" } & RoadmapFields & { milestoneIndex: number; milestonePlanText: string })
  | ({ phase: "milestone_pending_ci" } & MilestoneCodeFields)
  | ({ phase: "milestone_ci_failed" } & MilestoneCodeFields & { ciFailureSummary: string })
  | ({ phase: "roadmap_awaiting_promote" } & RoadmapFields);

function statePath(chatId: number): string {
  return `.agent-state/${chatId}.json`;
}

function projectLogPath(chatId: number): string {
  return `.agent-plan/${chatId}.md`;
}

async function readState(chatId: number): Promise<PipelineState | null> {
  const defaultBranch = await getDefaultBranch(playgroundRepo);
  const file = await fetchFile(playgroundRepo, statePath(chatId), defaultBranch);
  if (!file) {
    return null;
  }
  try {
    return JSON.parse(file.content) as PipelineState;
  } catch {
    return null;
  }
}

async function writeState(chatId: number, state: PipelineState): Promise<void> {
  assertRepoAllowed(playgroundRepo);
  const defaultBranch = await getDefaultBranch(playgroundRepo);
  const path = statePath(chatId);
  const existing = await fetchFile(playgroundRepo, path, defaultBranch);
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: playgroundRepo.owner,
    repo: playgroundRepo.repo,
    path,
    message: `[agent-state] chat ${chatId}: ${state.phase}`,
    content: Buffer.from(JSON.stringify(state, null, 2), "utf-8").toString("base64"),
    branch: defaultBranch,
    sha: existing?.sha,
  });
}

async function clearState(chatId: number): Promise<void> {
  assertRepoAllowed(playgroundRepo);
  const defaultBranch = await getDefaultBranch(playgroundRepo);
  const path = statePath(chatId);
  const existing = await fetchFile(playgroundRepo, path, defaultBranch);
  if (existing) {
    await octokit.rest.repos.deleteFile({
      owner: playgroundRepo.owner,
      repo: playgroundRepo.repo,
      path,
      message: `[agent-state] chat ${chatId}: cleared`,
      sha: existing.sha,
      branch: defaultBranch,
    });
  }
}

// Human-readable running log of what's been built so far this roadmap, committed onto the
// same playground branch as the code. This is the project's persistent "why", not the pipeline
// state file above (which only holds conversation-resumption metadata) - same pattern this
// project uses on itself via decisions.md, just scoped to one agent-built roadmap.
async function readProjectLog(chatId: number, branchName: string): Promise<string> {
  const file = await fetchFile(playgroundRepo, projectLogPath(chatId), branchName);
  return file?.content ?? "";
}

async function appendMilestoneToLog(chatId: number, branchName: string, milestone: Milestone, summary: string): Promise<void> {
  assertRepoAllowed(playgroundRepo);
  const path = projectLogPath(chatId);
  const existing = await fetchFile(playgroundRepo, path, branchName);
  const entry = `## ${milestone.name}\n\n${summary}\n`;
  const content = existing ? `${existing.content}\n${entry}` : `# Project log\n\n${entry}`;
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: playgroundRepo.owner,
    repo: playgroundRepo.repo,
    path,
    message: `[agent-plan] log: ${milestone.name}`,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch: branchName,
    sha: existing?.sha,
  });
}

// ---------------------------------------------------------------------------
// Stage 1: roadmap (break the request into shippable milestones - no code).
// ---------------------------------------------------------------------------

function renderRoadmapText(summary: string, milestones: Milestone[]): string {
  const list = milestones.map((m, i) => `${i + 1}. *${m.name}* — ${m.goal}`).join("\n");
  return `${summary}\n\n*Milestones:*\n${list}`;
}

function fallbackRoadmap(message: string): { roadmapText: string; milestones: Milestone[] } {
  const milestones: Milestone[] = [{ name: "Build the request", goal: message }];
  return { roadmapText: renderRoadmapText("Single milestone (couldn't break this down further).", milestones), milestones };
}

async function draftRoadmap(message: string, fileList: string[]): Promise<{ roadmapText: string; milestones: Milestone[] }> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "A developer asked a GitHub agent for a code change. Before writing any code, break the request into " +
          "an ordered list of milestones - each one a genuinely useful, shippable slice that builds on the ones " +
          "before it (not an arbitrary file split). " +
          `${MILESTONE_SIZE_NOTE} It is normal and expected for a real feature to need many milestones (8-15+, ` +
          "sometimes more) rather than a handful of large ones - err toward more, smaller milestones. Reply with " +
          'ONLY a json object shaped like {"summary": "one paragraph overview of the whole plan", "milestones": ' +
          '[{"name": "short milestone name", "goal": "what this milestone delivers and why it comes at this ' +
          'point"}]}. Never pad the list with busywork, but never merge more work into one milestone than the ' +
          `size limit above allows. Do NOT write code - this is a roadmap for a human to approve or push back ` +
          `on. ${TELEGRAM_FORMATTING_NOTE}\n\n` +
          `Repository files:\n${fileList.join("\n") || "(repository has no files yet)"}`,
      },
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return fallbackRoadmap(message);
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.milestones) &&
      parsed.milestones.length > 0 &&
      parsed.milestones.every((m: unknown) => typeof m === "object" && m !== null && typeof (m as Milestone).name === "string" && typeof (m as Milestone).goal === "string")
    ) {
      return { roadmapText: renderRoadmapText(parsed.summary, parsed.milestones), milestones: parsed.milestones };
    }
  } catch {
    // falls through to the fallback below
  }
  return fallbackRoadmap(message);
}

async function reviseRoadmap(
  originalMessage: string,
  currentRoadmapText: string,
  currentMilestones: Milestone[],
  feedback: string
): Promise<{ roadmapText: string; milestones: Milestone[] }> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You previously proposed this milestone roadmap:\n\n" +
          currentRoadmapText +
          "\n\nfor this original request:\n\n" +
          originalMessage +
          "\n\nA senior engineer gave feedback on it. Revise the roadmap to address the feedback. " +
          `${MILESTONE_SIZE_NOTE} Reply with ONLY a json object shaped like {"summary": "one paragraph ` +
          'overview", "milestones": [{"name": "...", ' +
          `"goal": "..."}]} - the full revised roadmap, not a diff of changes. ${TELEGRAM_FORMATTING_NOTE}`,
      },
      { role: "user", content: feedback },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return { roadmapText: currentRoadmapText, milestones: currentMilestones };
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.milestones) &&
      parsed.milestones.length > 0 &&
      parsed.milestones.every((m: unknown) => typeof m === "object" && m !== null && typeof (m as Milestone).name === "string" && typeof (m as Milestone).goal === "string")
    ) {
      return { roadmapText: renderRoadmapText(parsed.summary, parsed.milestones), milestones: parsed.milestones };
    }
  } catch {
    // falls through to the unchanged-roadmap return below
  }
  return { roadmapText: currentRoadmapText, milestones: currentMilestones };
}

type PlanResponseDecision = "approve" | "revise" | "unrelated";

// Generic: works for both the overall roadmap and a single milestone's detailed plan - both
// are just "a text proposal awaiting a senior engineer's approve/revise/unrelated decision."
async function classifyPlanResponse(planText: string, message: string): Promise<PlanResponseDecision> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "A developer previously proposed this plan and is waiting for a senior engineer's " +
          `decision on it:\n\n${planText}\n\n` +
          'Classify the engineer\'s reply. Reply with ONLY a json object shaped like {"decision": "approve" | "revise" | "unrelated"}. ' +
          '"approve" = they are approving the plan as-is (e.g. "looks good", "approved", "go ahead", "yes"). ' +
          '"revise" = they want changes to the plan (feedback, corrections, a different approach). ' +
          '"unrelated" = the message has nothing to do with this plan (a new topic, a new unrelated request, small talk). ' +
          'If unsure between "approve" and "revise", choose "revise".',
      },
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return "revise";
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.decision === "approve" || parsed.decision === "revise" || parsed.decision === "unrelated") {
      return parsed.decision;
    }
  } catch {
    // falls through
  }
  return "revise";
}

// ---------------------------------------------------------------------------
// Stage 2: per-milestone plan (architecture/approach for just this slice, given
// the approved roadmap and whatever earlier milestones already built - no code).
// ---------------------------------------------------------------------------

async function draftMilestonePlan(
  originalMessage: string,
  roadmapText: string,
  milestone: Milestone,
  fileList: string[],
  logText: string
): Promise<string> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    messages: [
      {
        role: "system",
        content:
          `A developer approved this overall roadmap:\n\n${roadmapText}\n\n` +
          `You are now planning just ONE milestone of it: "${milestone.name}" — ${milestone.goal}\n\n` +
          "Propose a short engineering plan for this milestone only (files/approach, key decisions, edge cases) " +
          "for a senior engineer to review before you write code. Do NOT write code or a diff, and do not " +
          `redo work from earlier milestones. ${STACK_NOTE} ${MILESTONE_SIZE_NOTE} ${TELEGRAM_FORMATTING_NOTE}\n\n` +
          (logText ? `Work already completed in earlier milestones:\n${logText}\n\n` : "") +
          `Repository files so far:\n${fileList.join("\n") || "(no files yet)"}`,
      },
      { role: "user", content: originalMessage },
    ],
  });
  return completion.choices[0]?.message?.content ?? "DeepSeek returned an empty response while planning this milestone.";
}

// Reused for both roadmap and milestone-plan revisions - a plan is just text either way.
async function revisePlan(originalMessage: string, currentPlan: string, feedback: string): Promise<string> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    messages: [
      {
        role: "system",
        content:
          "You previously proposed this plan:\n\n" +
          currentPlan +
          "\n\nfor this original request:\n\n" +
          originalMessage +
          "\n\nA senior engineer gave feedback on it. Revise the plan to address the feedback and reply with " +
          `ONLY the full revised plan (not a diff of changes to the plan). ${TELEGRAM_FORMATTING_NOTE}`,
      },
      { role: "user", content: feedback },
    ],
  });
  return completion.choices[0]?.message?.content ?? currentPlan;
}

type MilestoneFilePlan = { canFulfill: true; paths: string[] } | { canFulfill: false; reason: string };

async function planMilestoneFiles(milestone: Milestone, milestonePlanText: string, fileList: string[]): Promise<MilestoneFilePlan> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You decide which files an already-approved milestone plan touches, for milestone "${milestone.name}" ` +
          `(${milestone.goal}), given the repository's current file list below. Reply with ONLY a json object: ` +
          'if it can be done, {"canFulfill": true, "paths": ["relative/file/path.ext", ...]} — reuse existing ' +
          "paths from the list when updating files, sensible new relative paths when creating them. Always " +
          "include the path(s) for the test file(s) that verify this milestone, in the ecosystem's idiomatic " +
          "test location, alongside the source files. If it " +
          'genuinely cannot be done, reply {"canFulfill": false, "reason": "short explanation for the developer"}. ' +
          `The "reason" field is the only part of this response a person ever reads. ${MILESTONE_SIZE_NOTE} ` +
          `${TELEGRAM_FORMATTING_NOTE}\n\n` +
          `Milestone plan:\n${milestonePlanText}\n\n` +
          `Repository files:\n${fileList.join("\n") || "(repository has no files yet)"}`,
      },
    ],
  });

  logCompletion("planMilestoneFiles", completion);
  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    logCompletionReject("planMilestoneFiles", "empty content");
    return { canFulfill: false, reason: "DeepSeek returned an empty response while planning the file changes." };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed.canFulfill === true && Array.isArray(parsed.paths) && parsed.paths.length > 0) {
      if (parsed.paths.length > MAX_FILES_PER_MILESTONE) {
        logCompletionReject("planMilestoneFiles", `too many files: ${parsed.paths.length} > ${MAX_FILES_PER_MILESTONE}`);
        return {
          canFulfill: false,
          reason:
            `This milestone would touch ${parsed.paths.length} files, more than fits in one build cycle ` +
            `(max ${MAX_FILES_PER_MILESTONE}). Reply with feedback to split it into smaller milestones.`,
        };
      }
      if (parsed.paths.every((p: unknown) => typeof p === "string" && isSafeRepoPath(p))) {
        return { canFulfill: true, paths: parsed.paths };
      }
      logCompletionReject("planMilestoneFiles", `paths failed isSafeRepoPath: ${JSON.stringify(parsed.paths)}`);
    }
    if (parsed.canFulfill === false && typeof parsed.reason === "string") {
      return { canFulfill: false, reason: parsed.reason };
    }
    logCompletionReject("planMilestoneFiles", `parsed but unexpected shape (canFulfill=${JSON.stringify(parsed.canFulfill)})`);
  } catch (err) {
    logCompletionReject("planMilestoneFiles", `JSON.parse failed: ${(err as Error).message}`);
  }
  return { canFulfill: false, reason: "Couldn't determine a valid set of file changes from that milestone plan." };
}

// ---------------------------------------------------------------------------
// Stage 3: code + tests, grounded in the approved milestone plan. The agent
// writes test content but never executes it itself - GitHub Actions does that.
// ---------------------------------------------------------------------------

type CodeAndTestDraft = {
  files: FileChange[];
  tests: FileChange[];
  commitMessage: string;
  prTitle: string;
  prBody: string;
};

function isValidFileContent(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Test files are drafted in a second wave, grounded in the just-drafted source, so they match the
// real API instead of drifting from it. This classifies which of a milestone's paths are tests,
// across the 7 supported ecosystems (see SUPPORTED_ECOSYSTEMS).
function isTestPath(p: string): boolean {
  const tp = p.toLowerCase();
  return (
    /(^|\/)(test|tests|spec|__tests__)\//.test(tp) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(tp) ||
    /(^|\/)test_[^/]+\.py$/.test(tp) ||
    /_test\.[a-z0-9]+$/.test(tp) ||
    /_spec\.[a-z0-9]+$/.test(tp)
  );
}

// First non-empty line of the approved plan, stripped of leading markdown heading marks and
// capped - used to derive a commit message / PR title instead of asking the model for one.
function firstPlanLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.replace(/^#+\s*/, "").slice(0, 72);
}

// How many times to re-ask DeepSeek for ONE file's content when it comes back empty or unparseable.
// Separate from the SDK's network-level retries (maxRetries), which cover a dropped connection;
// this covers a completed-but-unusable response. deepseek-v4-flash's hidden reasoning-token burn is
// large and highly variable (measured 13k-29k on identical input, ~60% of runs producing unusable
// output on a logic-heavy milestone), so a couple of content-level retries turn a frequent hard
// failure into a rare one.
const CONTENT_DRAFT_ATTEMPTS = 3;

// Draft ONE file's complete content, retrying on unusable output. Splitting the old single call
// (all files + all tests + metadata in one JSON) into one call per file is the core fix: that
// bundled call drove the reasoning burn to 20k-34k tokens with ~60% unusable output, and any one
// malformed field threw the whole milestone away. One small file per call keeps each generation
// short and lets a failure retry just that file.
async function draftOneFile(args: {
  targetPath: string;
  kind: "source" | "test";
  originalMessage: string;
  planText: string;
  allPaths: string[];
  existingContent: string | null;
  fileList: string[];
  siblingSources: FileChange[];
  logText?: string;
  revisionFeedback?: string;
  ciFailureSummary?: string;
}): Promise<string | null> {
  const { targetPath, kind, originalMessage, planText, allPaths, existingContent, fileList, siblingSources, logText, revisionFeedback, ciFailureSummary } = args;
  const label = `draftOneFile(${targetPath})`;

  const siblingSummary = siblingSources.length
    ? "\n\nThe source file(s) this milestone just produced (match their real API exactly):\n" +
      siblingSources.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")
    : "";

  for (let attempt = 1; attempt <= CONTENT_DRAFT_ATTEMPTS; attempt++) {
    const completion = await deepseek.chat.completions.create({
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `You implement one file of an already-approved milestone plan. Produce the COMPLETE content of ` +
            `exactly this ${kind === "test" ? "test " : ""}file: ${targetPath}. Reply with ONLY a json object ` +
            'shaped like {"content": "full file content"} - the whole file, not a diff. ' +
            (kind === "test"
              ? "Write a real test covering the change's testable logic, using the ecosystem's idiomatic test framework, matching the source file(s) shown below exactly. "
              : "") +
            "Keep any sample/fixture content minimal (a handful of representative rows/fields), never an " +
            `exhaustive dataset. ${STACK_NOTE}\n\n` +
            `Approved milestone plan:\n${planText}\n\n` +
            `All files this milestone touches:\n${allPaths.join("\n")}\n\n` +
            `Repository files:\n${fileList.join("\n") || "(repository has no files yet)"}\n\n` +
            (existingContent !== null
              ? `Current content of ${targetPath} (you are updating it):\n${existingContent}`
              : `${targetPath} does not exist yet - you are creating it.`) +
            siblingSummary +
            (logText ? `\n\nWork already completed in earlier milestones:\n${logText}` : "") +
            (revisionFeedback ? `\n\nThe previous attempt needs revision. Feedback:\n${revisionFeedback}` : "") +
            (ciFailureSummary ? `\n\nThe previous attempt's tests failed in CI:\n${ciFailureSummary}` : ""),
        },
        { role: "user", content: originalMessage },
      ],
    });

    logCompletion(`${label} attempt ${attempt}`, completion);
    const raw = completion.choices[0]?.message?.content;
    if (!raw) {
      logCompletionReject(label, `attempt ${attempt}: empty content`);
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (isValidFileContent(parsed.content)) {
        return parsed.content;
      }
      logCompletionReject(label, `attempt ${attempt}: "content" missing or not a non-empty string`);
    } catch (err) {
      logCompletionReject(label, `attempt ${attempt}: JSON.parse failed: ${(err as Error).message}`);
    }
  }
  return null;
}

async function draftCodeAndTests(
  originalMessage: string,
  planText: string,
  paths: string[],
  existingFiles: { path: string; content: string | null }[],
  fileList: string[],
  logText?: string,
  revisionFeedback?: string,
  ciFailureSummary?: string
): Promise<CodeAndTestDraft | null> {
  const safePaths = paths.filter((p) => isSafeRepoPath(p));
  if (safePaths.length === 0 || safePaths.length > MAX_ARTIFACTS_PER_MILESTONE) {
    logCompletionReject(
      "draftCodeAndTests",
      `unexpected path set (${safePaths.length} of ${paths.length} safe, cap ${MAX_ARTIFACTS_PER_MILESTONE})`
    );
    return null;
  }
  const existingByPath = new Map(existingFiles.map((f) => [f.path, f.content]));
  const sourcePaths = safePaths.filter((p) => !isTestPath(p));
  const testPaths = safePaths.filter((p) => isTestPath(p));

  const common = { originalMessage, planText, allPaths: safePaths, fileList, logText, revisionFeedback, ciFailureSummary };

  // Wave 1: source files, in parallel (each its own small completion).
  const sourceContents = await Promise.all(
    sourcePaths.map((p) =>
      draftOneFile({ ...common, targetPath: p, kind: "source", existingContent: existingByPath.get(p) ?? null, siblingSources: [] })
    )
  );
  if (sourceContents.some((c) => c === null)) {
    logCompletionReject("draftCodeAndTests", `source draft failed for: ${sourcePaths.filter((_, i) => sourceContents[i] === null).join(", ")}`);
    return null;
  }
  const files: FileChange[] = sourcePaths.map((p, i) => ({ path: p, content: sourceContents[i] as string }));

  // Wave 2: test files, grounded in the source just drafted so they can't drift from its real API.
  const testContents = await Promise.all(
    testPaths.map((p) =>
      draftOneFile({ ...common, targetPath: p, kind: "test", existingContent: existingByPath.get(p) ?? null, siblingSources: files })
    )
  );
  if (testContents.some((c) => c === null)) {
    logCompletionReject("draftCodeAndTests", `test draft failed for: ${testPaths.filter((_, i) => testContents[i] === null).join(", ")}`);
    return null;
  }
  const tests: FileChange[] = testPaths.map((p, i) => ({ path: p, content: testContents[i] as string }));

  // Metadata is derived, not model-generated: prTitle was never read anywhere, and deriving
  // commitMessage/summary from the approved plan removes a whole failure surface (the old bundled
  // call could return valid files but one malformed metadata field and be discarded entirely).
  const commitMessage = firstPlanLine(planText) || "Milestone changes";
  return { files, tests, commitMessage, prTitle: commitMessage, prBody: planText };
}

// Shared by every commit onto the persistent playground branch and by the final target
// promotion. Builds ONE atomic commit via the Git Data API (blobs in parallel, one tree, one
// commit, one ref update) instead of N sequential single-file REST calls - a milestone with a
// dozen-plus files used to mean 2N sequential round trips and could blow well past Telegraf's
// (and Vercel's) handler-duration ceiling; this is O(1) sequential round trips regardless of
// file count, since blob creation doesn't touch branch state and can run fully in parallel.
async function commitFilesToBranch(repo: RepoRef, branchName: string, files: FileChange[], commitMessage: string): Promise<void> {
  assertRepoAllowed(repo);
  if (files.length === 0) {
    return;
  }

  const { data: ref } = await octokit.rest.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${branchName}` });
  const headCommitSha = ref.object.sha;
  const { data: headCommit } = await octokit.rest.git.getCommit({ owner: repo.owner, repo: repo.repo, commit_sha: headCommitSha });

  const blobs = await Promise.all(
    files.map(async ({ path, content }) => {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner: repo.owner,
        repo: repo.repo,
        content: Buffer.from(content, "utf-8").toString("base64"),
        encoding: "base64",
      });
      return { path, sha: blob.sha };
    })
  );

  const { data: tree } = await octokit.rest.git.createTree({
    owner: repo.owner,
    repo: repo.repo,
    base_tree: headCommit.tree.sha,
    tree: blobs.map(({ path, sha }) => ({ path, mode: "100644" as const, type: "blob" as const, sha })),
  });

  const { data: commit } = await octokit.rest.git.createCommit({
    owner: repo.owner,
    repo: repo.repo,
    message: commitMessage,
    tree: tree.sha,
    parents: [headCommitSha],
  });

  await octokit.rest.git.updateRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${branchName}`, sha: commit.sha });
}

// Created once per roadmap, at roadmap-approval time - every milestone commits onto this
// SAME branch, so later milestones see everything earlier ones built. A dedicated branch
// (not playground's default) keeps concurrent chats from trampling each other's work.
async function createPlaygroundBranch(branchName: string): Promise<void> {
  assertRepoAllowed(playgroundRepo);
  const defaultBranch = await getDefaultBranch(playgroundRepo);
  const { data: baseRef } = await octokit.rest.git.getRef({
    owner: playgroundRepo.owner,
    repo: playgroundRepo.repo,
    ref: `heads/${defaultBranch}`,
  });
  await octokit.rest.git.createRef({
    owner: playgroundRepo.owner,
    repo: playgroundRepo.repo,
    ref: `refs/heads/${branchName}`,
    sha: baseRef.object.sha,
  });
}

// ---------------------------------------------------------------------------
// Stage 4: CI status, checked on demand (no background polling - a serverless
// webhook can't run one). Whenever the human next messages during this phase,
// we just ask GitHub what the latest run on that branch says.
// ---------------------------------------------------------------------------

type CiStatus =
  | { status: "in_progress"; runUrl?: string }
  | { status: "completed"; conclusion: string; runUrl: string };

async function checkCiStatus(branchName: string): Promise<CiStatus> {
  assertRepoAllowed(playgroundRepo);
  const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner: playgroundRepo.owner,
    repo: playgroundRepo.repo,
    branch: branchName,
    per_page: 1,
  });
  const run = data.workflow_runs[0];
  if (!run || run.status !== "completed") {
    return { status: "in_progress", runUrl: run?.html_url };
  }
  return { status: "completed", conclusion: run.conclusion ?? "unknown", runUrl: run.html_url };
}

// ---------------------------------------------------------------------------
// Stage 5: promotion. Reachable once every milestone in the roadmap has built and passed CI
// in playground. Opens ONE pull request into target with everything the roadmap touched -
// target is never written to before this single, human-reviewed point.
// ---------------------------------------------------------------------------

type VerificationDecision = "promote" | "revise" | "unrelated";

async function classifyVerificationResponse(message: string): Promise<VerificationDecision> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Every milestone of an approved roadmap has been built and tested (CI passing) in playground, and a " +
          "senior engineer was asked whether to open the real pull request into target. Classify their reply. " +
          'Reply with ONLY a json object shaped like {"decision": "promote" | "revise" | "unrelated"}. ' +
          '"promote" = they approve opening the PR now (e.g. "ship it", "looks good", "approve", "go ahead"). ' +
          '"revise" = they want something fixed or added before promoting. ' +
          '"unrelated" = the message is a new, unrelated topic or request. ' +
          'If unsure between "promote" and "revise", choose "revise".',
      },
      { role: "user", content: message },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return "revise";
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.decision === "promote" || parsed.decision === "revise" || parsed.decision === "unrelated") {
      return parsed.decision;
    }
  } catch {
    // falls through
  }
  return "revise";
}

async function handleChat(message: string): Promise<string> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: TELEGRAM_FORMATTING_NOTE },
      { role: "user", content: message },
    ],
  });
  const reply = completion.choices[0]?.message?.content;
  return reply ?? "DeepSeek returned an empty response.";
}

// --- Repo selection ------------------------------------------------------------------------------
// The agent may CHOOSE which allowed repo to act on (CLAUDE.md Section 5 explicitly permits this) -
// the security boundary is that the chosen repo is always validated against the named allow-list and
// anything off-list is refused, never invented. Two layers:
//   1. An explicit "repo: <name> ..." prefix (power users / unambiguous) - exact, no LLM.
//   2. Otherwise DeepSeek picks the intended repo from natural phrasing ("the throwaway one"). If it
//      can't tell, we ASK rather than silently defaulting (the frustrating surprise we're fixing).

// Explicit "repo: <name> ..." selector. Returns null when there's no such prefix (so the caller can
// fall through to the smart pick), an error for an off-list / empty request, or the resolved repo.
function resolveExplicitRepo(message: string): { repo: RepoRef; message: string } | { error: string } | null {
  const m = message.match(/^\s*repo:\s*(\S+)\s*([\s\S]*)$/i);
  if (!m) return null;
  const wanted = m[1].toLowerCase();
  const rest = m[2].trim();
  const match = singlePrRepos.find(
    (r) => `${r.owner}/${r.repo}`.toLowerCase() === wanted || r.repo.toLowerCase() === wanted
  );
  if (!match) {
    const list = singlePrRepos.map((r) => `${r.owner}/${r.repo}`).join(", ");
    return { error: `I can only act on these repos: ${list}. "${m[1]}" isn't one of them.` };
  }
  if (!rest) return { error: `Selected ${match.owner}/${match.repo}, but no change was described. Tell me what to change.` };
  return { repo: match, message: rest };
}

// DeepSeek maps a message to one of the allow-listed repos (matching informal names), or "ambiguous"
// when it can't tell. The returned repo is re-validated against the allow-list here - we never act on
// a repo string the model emits that isn't on the list (CLAUDE.md Section 5).
async function pickRepo(message: string): Promise<RepoRef | "ambiguous"> {
  const options = singlePrRepos.map((r) => `${r.owner}/${r.repo}`).join("\n");
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `The user wants a code change or issue made in ONE of these repositories:\n${options}\n\n` +
          `Decide which one they mean. Match generously on partial or informal names (e.g. ` +
          `"throwaway", "the playground", a bare repo name, or a distinctive word from the name). ` +
          `Reply with ONLY JSON: {"repo": "owner/repo"} using EXACTLY one of the strings above when ` +
          `the message clearly indicates one, otherwise {"ambiguous": true}. Never invent a repo not listed.`,
      },
      { role: "user", content: message },
    ],
  });
  logCompletion("pickRepo", completion);
  const raw = completion.choices[0]?.message?.content;
  if (!raw) return "ambiguous";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.repo === "string") {
      const wanted = parsed.repo.toLowerCase();
      const match = singlePrRepos.find(
        (r) => `${r.owner}/${r.repo}`.toLowerCase() === wanted || r.repo.toLowerCase() === wanted
      );
      if (match) return match; // validated against the allow-list
    }
  } catch {
    // falls through to ambiguous
  }
  return "ambiguous";
}

// The full resolution used by the client-facing (builder-off) flow. `fromExplicit` tells the caller
// whether the message carried its own request text (a "repo: X <request>" prefix) vs. just naming a
// repo - which matters when the message is an answer to an earlier "which repo?" question.
type RepoResolution =
  | { kind: "repo"; repo: RepoRef; message: string; fromExplicit: boolean }
  | { kind: "ask"; text: string }
  | { kind: "error"; text: string };

async function resolveRepoForRequest(message: string): Promise<RepoResolution> {
  const explicit = resolveExplicitRepo(message);
  if (explicit) {
    return "error" in explicit
      ? { kind: "error", text: explicit.error }
      : { kind: "repo", repo: explicit.repo, message: explicit.message, fromExplicit: true };
  }
  // No explicit prefix. With a single allowed repo there's nothing to choose - use it (no LLM call,
  // no change from today's behaviour for a single-target client deployment).
  if (singlePrRepos.length === 1) {
    return { kind: "repo", repo: singlePrRepos[0], message, fromExplicit: false };
  }
  const picked = await pickRepo(message);
  if (picked === "ambiguous") {
    const names = singlePrRepos.map((r) => `\`${r.owner}/${r.repo}\``).join(", ");
    return {
      kind: "ask",
      text:
        `Which repo should I use for this? I can work in: ${names}.\n\n` +
        `Just reply with the one you mean (e.g. "the throwaway one") and I'll go ahead with your request.`,
    };
  }
  return { kind: "repo", repo: picked, message, fromExplicit: false };
}

async function handleIssueRequest(issueMessage: string, repo: RepoRef): Promise<string> {
  assertRepoAllowed(repo);
  const { title, body } = await interpretAsIssue(issueMessage);
  const issue = await octokit.rest.issues.create({ owner: repo.owner, repo: repo.repo, title, body });
  return `Created issue #${issue.data.number} in ${repo.owner}/${repo.repo}: ${issue.data.html_url}`;
}

// Decide which files a single focused change touches. Leaner than the builder's milestone planner:
// no milestone framing, no forced tests, just the smallest sensible set of files (or a decline).
type SinglePrPlan = { canFulfill: true; paths: string[] } | { canFulfill: false; reason: string };
async function planSinglePrFiles(message: string, repo: RepoRef, fileList: string[]): Promise<SinglePrPlan> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You decide which files a single focused change touches in ${repo.owner}/${repo.repo}, given its ` +
          "current file list below. Prefer the smallest sensible set. Reply with ONLY a json object: for a " +
          'concrete code change, {"canFulfill": true, "paths": ["relative/path.ext", ...]} (reuse existing ' +
          "paths when editing, sensible new relative paths when creating). If it isn't a concrete change - a " +
          'question, chit-chat, or too vague - {"canFulfill": false, "reason": "short explanation shown to ' +
          `the user"}. Use at most ${MAX_FILES_PER_MILESTONE} files. ${TELEGRAM_FORMATTING_NOTE}\n\n` +
          `Repository files:\n${fileList.join("\n") || "(repository has no files yet)"}`,
      },
      { role: "user", content: message },
    ],
  });
  logCompletion("planSinglePrFiles", completion);
  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    logCompletionReject("planSinglePrFiles", "empty content");
    return { canFulfill: false, reason: "I couldn't work out a change from that - try describing it more concretely." };
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed.canFulfill === true &&
      Array.isArray(parsed.paths) &&
      parsed.paths.length > 0 &&
      parsed.paths.length <= MAX_FILES_PER_MILESTONE &&
      parsed.paths.every((p: unknown) => typeof p === "string" && isSafeRepoPath(p))
    ) {
      return { canFulfill: true, paths: parsed.paths };
    }
    if (parsed.canFulfill === false && typeof parsed.reason === "string") {
      return { canFulfill: false, reason: parsed.reason };
    }
    logCompletionReject("planSinglePrFiles", "parsed but invalid shape/paths");
  } catch (err) {
    logCompletionReject("planSinglePrFiles", `JSON.parse failed: ${(err as Error).message}`);
  }
  return { canFulfill: false, reason: "I couldn't turn that into a valid file change - try rephrasing it." };
}

// Draft ONE file's complete content for a focused PR change. Separate from the builder's
// draftOneFile on purpose: a focused edit has no plan, no tests, and no CI/ecosystem framing, so it
// gets a lean prompt. Retries on unusable output, same as the builder (same reasoning-model variance).
async function draftPrFile(
  targetPath: string,
  changeMessage: string,
  existingContent: string | null,
  fileList: string[],
  allPaths: string[]
): Promise<string | null> {
  const label = `draftPrFile(${targetPath})`;
  for (let attempt = 1; attempt <= CONTENT_DRAFT_ATTEMPTS; attempt++) {
    const completion = await deepseek.chat.completions.create({
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `You make a single focused change to a repository, producing the COMPLETE new content of ` +
            `exactly this file: ${targetPath}. Reply with ONLY a json object shaped like ` +
            '{"content": "full file content"} - the whole file, not a diff. Match the repo\'s existing ' +
            "language, style and conventions; change only what the request needs and keep the rest of the " +
            "file intact.\n\n" +
            `The change may touch these files together: ${allPaths.join(", ")}\n\n` +
            `Repository files:\n${fileList.join("\n") || "(repository has no files yet)"}\n\n` +
            (existingContent !== null
              ? `Current content of ${targetPath} (you are editing it):\n${existingContent}`
              : `${targetPath} does not exist yet - you are creating it.`),
        },
        { role: "user", content: changeMessage },
      ],
    });
    logCompletion(label, completion);
    const raw = completion.choices[0]?.message?.content;
    if (!raw) {
      logCompletionReject(label, `attempt ${attempt}: empty content`);
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (isValidFileContent(parsed.content)) {
        return parsed.content;
      }
      logCompletionReject(label, `attempt ${attempt}: "content" missing or not a non-empty string`);
    } catch (err) {
      logCompletionReject(label, `attempt ${attempt}: JSON.parse failed: ${(err as Error).message}`);
    }
  }
  return null;
}

// The reliable client-facing path: one message -> a focused change -> one PR into a named repo.
// Reads the repo, drafts the file(s), commits to a fresh branch, opens a PR. Never a direct write
// to the default branch; a human reviews and merges - the same safety boundary as v1.
async function handleSinglePrRequest(changeMessage: string, repo: RepoRef, chatId: number): Promise<string> {
  assertRepoAllowed(repo);

  const defaultBranch = await getDefaultBranch(repo);
  const fileList = await fetchRepoFileList(repo, defaultBranch);

  const plan = await planSinglePrFiles(changeMessage, repo, fileList);
  if (!plan.canFulfill) {
    return plan.reason;
  }

  const existing = await Promise.all(
    plan.paths.map(async (p) => ({ path: p, content: (await fetchFile(repo, p, defaultBranch))?.content ?? null }))
  );
  const contents = await Promise.all(
    plan.paths.map((p, i) => draftPrFile(p, changeMessage, existing[i].content, fileList, plan.paths))
  );
  if (contents.some((c) => c === null)) {
    const failed = plan.paths.filter((_, i) => contents[i] === null).join(", ");
    logCompletionReject("handleSinglePrRequest", `draft failed for: ${failed}`);
    return "Sorry, I couldn't draft that change reliably. Try a smaller or clearer request.";
  }
  const files: FileChange[] = plan.paths.map((p, i) => ({ path: p, content: contents[i] as string }));

  const base = await octokit.rest.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${defaultBranch}` });
  const branchName = `agent/${Date.now()}`;
  await octokit.rest.git.createRef({
    owner: repo.owner,
    repo: repo.repo,
    ref: `refs/heads/${branchName}`,
    sha: base.data.object.sha,
  });
  const title = firstPlanLine(changeMessage) || "Agent change";
  await commitFilesToBranch(repo, branchName, files, title);
  const { data: pr } = await octokit.rest.pulls.create({
    owner: repo.owner,
    repo: repo.repo,
    title: title.slice(0, 250),
    head: branchName,
    base: defaultBranch,
    body: `Requested via Telegram:\n\n> ${changeMessage}\n\nFiles changed: ${files.map((f) => f.path).join(", ")}`,
  });
  // Remember this PR so the next message can promote the same change into another allowed repo.
  await writeState(chatId, {
    phase: "pr_opened",
    sourceRepo: repo,
    branch: branchName,
    paths: files.map((f) => f.path),
    requestMessage: changeMessage,
    prUrl: pr.html_url,
  });
  return `Opened PR #${pr.number} in ${repo.owner}/${repo.repo}: ${pr.html_url}`;
}

// A fresh "pr"-style request with no pipeline state yet: propose a milestone roadmap, no code.
async function handleRoadmapRequest(chatId: number, message: string): Promise<string> {
  assertRepoAllowed(targetRepo);
  const defaultBranch = await getDefaultBranch(targetRepo);
  const fileList = await fetchRepoFileList(targetRepo, defaultBranch);

  const { roadmapText, milestones } = await draftRoadmap(message, fileList);
  await writeState(chatId, { phase: "roadmap_pending", originalMessage: message, roadmapText, milestones });

  return `*Proposed roadmap:*\n\n${roadmapText}\n\nReply to approve, or give feedback to revise it.`;
}

async function handleRoadmapRevision(
  chatId: number,
  state: Extract<PipelineState, { phase: "roadmap_pending" }>,
  feedback: string
): Promise<string> {
  const revised = await reviseRoadmap(state.originalMessage, state.roadmapText, state.milestones, feedback);
  await writeState(chatId, {
    phase: "roadmap_pending",
    originalMessage: state.originalMessage,
    roadmapText: revised.roadmapText,
    milestones: revised.milestones,
  });
  return `*Revised roadmap:*\n\n${revised.roadmapText}\n\nReply to approve, or give more feedback to revise it further.`;
}

// Roadmap approved: create the one playground branch every milestone will build on, and
// draft the first milestone's detailed plan.
async function handleRoadmapApproval(chatId: number, state: Extract<PipelineState, { phase: "roadmap_pending" }>): Promise<string> {
  assertRepoAllowed(playgroundRepo);
  const branchName = `agent/${chatId}/${Date.now()}`;
  await createPlaygroundBranch(branchName);

  const roadmapCtx: RoadmapFields = {
    originalMessage: state.originalMessage,
    roadmapText: state.roadmapText,
    milestones: state.milestones,
    branchName,
    logPath: projectLogPath(chatId),
    touchedPaths: [],
  };

  return startMilestonePlan(chatId, roadmapCtx, 0);
}

// Drafts and stores the detailed plan for milestone `milestoneIndex`, grounded in the
// playground branch's current files and the running log of what earlier milestones built.
async function startMilestonePlan(chatId: number, ctx: RoadmapFields, milestoneIndex: number): Promise<string> {
  const milestone = ctx.milestones[milestoneIndex];
  const fileList = await fetchRepoFileList(playgroundRepo, ctx.branchName);
  const logText = await readProjectLog(chatId, ctx.branchName);

  const milestonePlanText = await draftMilestonePlan(ctx.originalMessage, ctx.roadmapText, milestone, fileList, logText);

  await writeState(chatId, { phase: "milestone_plan_pending", milestoneIndex, milestonePlanText, ...ctx });

  const progress = `Milestone ${milestoneIndex + 1}/${ctx.milestones.length}: *${milestone.name}*`;
  return `${progress}\n\n${milestonePlanText}\n\nReply to approve, or give feedback to revise it.`;
}

async function handleMilestonePlanRevision(
  chatId: number,
  state: Extract<PipelineState, { phase: "milestone_plan_pending" }>,
  feedback: string
): Promise<string> {
  const revised = await revisePlan(state.originalMessage, state.milestonePlanText, feedback);
  await writeState(chatId, { ...state, milestonePlanText: revised });
  const milestone = state.milestones[state.milestoneIndex];
  const progress = `Milestone ${state.milestoneIndex + 1}/${state.milestones.length}: *${milestone.name}*`;
  return `${progress}\n\n*Revised plan:*\n\n${revised}\n\nReply to approve, or give more feedback.`;
}

// Milestone plan approved: draft code+tests for just this milestone, commit onto the shared
// playground branch, start CI.
async function handleMilestonePlanApproval(
  chatId: number,
  state: Extract<PipelineState, { phase: "milestone_plan_pending" }>
): Promise<string> {
  const milestone = state.milestones[state.milestoneIndex];
  const fileList = await fetchRepoFileList(playgroundRepo, state.branchName);

  const plan = await planMilestoneFiles(milestone, state.milestonePlanText, fileList);
  if (!plan.canFulfill) {
    return `Couldn't turn this milestone into file changes: ${plan.reason}\n\nReply with adjusted scope or feedback.`;
  }

  const existingFiles = await Promise.all(
    plan.paths.map(async (path) => ({ path, content: (await fetchFile(playgroundRepo, path, state.branchName))?.content ?? null }))
  );
  const logText = await readProjectLog(chatId, state.branchName);

  const draft = await draftCodeAndTests(state.originalMessage, state.milestonePlanText, plan.paths, existingFiles, fileList, logText);
  if (!draft) {
    return "Sorry, I couldn't turn this milestone's plan into code and tests. Try describing it again.";
  }

  return commitMilestoneAndStartCi(chatId, state, draft);
}

// Shared context every "committed, waiting on CI" state needs - satisfied by milestone_plan_pending,
// milestone_pending_ci and milestone_ci_failed alike, so this is reused across all three call sites.
type MilestoneContext = RoadmapFields & { milestoneIndex: number; milestonePlanText: string };

async function commitMilestoneAndStartCi(chatId: number, ctx: MilestoneContext, draft: CodeAndTestDraft): Promise<string> {
  await commitFilesToBranch(
    playgroundRepo,
    ctx.branchName,
    [...draft.files, ...draft.tests],
    `[milestone ${ctx.milestoneIndex + 1}] ${draft.commitMessage}`
  );

  const touchedPaths = Array.from(
    new Set([...ctx.touchedPaths, ...draft.files.map((f) => f.path), ...draft.tests.map((f) => f.path)])
  );

  await writeState(chatId, {
    phase: "milestone_pending_ci",
    originalMessage: ctx.originalMessage,
    roadmapText: ctx.roadmapText,
    milestones: ctx.milestones,
    branchName: ctx.branchName,
    logPath: ctx.logPath,
    touchedPaths,
    milestoneIndex: ctx.milestoneIndex,
    milestonePlanText: ctx.milestonePlanText,
    filePaths: draft.files.map((f) => f.path),
    testPaths: draft.tests.map((f) => f.path),
    commitMessage: draft.commitMessage,
    milestoneSummary: draft.prBody,
  });

  const milestone = ctx.milestones[ctx.milestoneIndex];
  const fileNames = [...draft.files, ...draft.tests].map((f) => f.path).join(", ");
  return (
    `Milestone ${ctx.milestoneIndex + 1}/${ctx.milestones.length} ("${milestone.name}") drafted in playground ` +
    `(${fileNames}).\nTests are running - message me again shortly to check.`
  );
}

async function handleMilestoneCiCheck(chatId: number, state: Extract<PipelineState, { phase: "milestone_pending_ci" }>): Promise<string> {
  const ci = await checkCiStatus(state.branchName);
  const milestone = state.milestones[state.milestoneIndex];

  if (ci.status === "in_progress") {
    return "Tests are still running in playground - message me again shortly to check.";
  }

  if (ci.conclusion !== "success") {
    const summary = `Workflow run concluded "${ci.conclusion}"`;
    await writeState(chatId, { ...state, phase: "milestone_ci_failed", ciFailureSummary: summary });
    return `Milestone ${state.milestoneIndex + 1} ("${milestone.name}") tests failed: ${ci.runUrl}\n\nReply with what to fix and I'll redraft this milestone.`;
  }

  await appendMilestoneToLog(chatId, state.branchName, milestone, state.milestoneSummary);

  const roadmapCtx: RoadmapFields = {
    originalMessage: state.originalMessage,
    roadmapText: state.roadmapText,
    milestones: state.milestones,
    branchName: state.branchName,
    logPath: state.logPath,
    touchedPaths: state.touchedPaths,
  };

  const nextIndex = state.milestoneIndex + 1;
  if (nextIndex >= state.milestones.length) {
    await writeState(chatId, { phase: "roadmap_awaiting_promote", ...roadmapCtx });
    return (
      `Milestone ${state.milestoneIndex + 1} ("${milestone.name}") passed: ${ci.runUrl}\n\n` +
      `All milestones are built and passing in playground. Reply to open the pull request into target, or ` +
      `give feedback if something needs changing first.`
    );
  }

  const nextPlanMessage = await startMilestonePlan(chatId, roadmapCtx, nextIndex);
  return `Milestone ${state.milestoneIndex + 1} ("${milestone.name}") passed: ${ci.runUrl}\n\n${nextPlanMessage}`;
}

async function handleMilestoneCiFailureRevision(
  chatId: number,
  state: Extract<PipelineState, { phase: "milestone_ci_failed" }>,
  feedback: string
): Promise<string> {
  const fileList = await fetchRepoFileList(playgroundRepo, state.branchName);
  // Re-draft both source and test files on a CI failure: a failing test often needs the source
  // fixed AND the test adjusted, and the new source-then-test drafting keeps them consistent.
  const milestonePaths = [...state.filePaths, ...state.testPaths];
  const existingFiles = await Promise.all(
    milestonePaths.map(async (path) => ({ path, content: (await fetchFile(playgroundRepo, path, state.branchName))?.content ?? null }))
  );
  const logText = await readProjectLog(chatId, state.branchName);

  const draft = await draftCodeAndTests(
    state.originalMessage,
    state.milestonePlanText,
    milestonePaths,
    existingFiles,
    fileList,
    logText,
    feedback,
    state.ciFailureSummary
  );
  if (!draft) {
    return "Sorry, I couldn't turn that feedback into an updated change. Try rephrasing it.";
  }

  return commitMilestoneAndStartCi(chatId, state, draft);
}

// Only reachable once every milestone has passed CI in playground. Copies the final content
// of every touched path straight from the playground branch (the source of truth - nothing
// is re-asked of the LLM) into a fresh target branch and opens the one real pull request.
async function handleRoadmapPromote(chatId: number, state: Extract<PipelineState, { phase: "roadmap_awaiting_promote" }>): Promise<string> {
  assertRepoAllowed(targetRepo);
  const defaultBranch = await getDefaultBranch(targetRepo);

  const files = await Promise.all(
    state.touchedPaths.map(async (path) => {
      const file = await fetchFile(playgroundRepo, path, state.branchName);
      if (!file) {
        throw new Error(`Expected ${path} to exist on playground branch ${state.branchName} but it was missing.`);
      }
      return { path, content: file.content };
    })
  );

  const { data: baseRef } = await octokit.rest.git.getRef({
    owner: targetRepo.owner,
    repo: targetRepo.repo,
    ref: `heads/${defaultBranch}`,
  });
  const branchName = `agent/${Date.now()}`;
  await octokit.rest.git.createRef({
    owner: targetRepo.owner,
    repo: targetRepo.repo,
    ref: `refs/heads/${branchName}`,
    sha: baseRef.object.sha,
  });

  const milestoneNames = state.milestones.map((m) => m.name).join(", ");
  await commitFilesToBranch(targetRepo, branchName, files, `Implements roadmap: ${milestoneNames}`);

  const { data: pr } = await octokit.rest.pulls.create({
    owner: targetRepo.owner,
    repo: targetRepo.repo,
    title: `Roadmap: ${milestoneNames}`.slice(0, 250),
    head: branchName,
    base: defaultBranch,
    body: `${state.roadmapText}\n\n---\nBuilt and tested milestone-by-milestone in playground before this PR.`,
  });

  await clearState(chatId);
  return `Opened PR #${pr.number} into target: ${pr.html_url}`;
}

// Feedback at the "ready to promote" gate becomes one more ad-hoc milestone, reusing the same
// plan -> approve -> build -> CI loop as every other milestone rather than a separate code path.
async function handleRoadmapPromoteRevision(
  chatId: number,
  state: Extract<PipelineState, { phase: "roadmap_awaiting_promote" }>,
  feedback: string
): Promise<string> {
  const milestones = [...state.milestones, { name: `Fix: ${feedback.slice(0, 40)}`, goal: feedback }];
  const roadmapCtx: RoadmapFields = { ...state, milestones };
  return startMilestonePlan(chatId, roadmapCtx, milestones.length - 1);
}

// Builder-ON only: the pipeline dispatch falls through here for messages unrelated to a pending
// roadmap. Repo resolution stays simple (explicit prefix, else default) - the smart-pick/ask
// continuity below is scoped to the client-facing builder-off flow.
async function handleStandardIntent(chatId: number, message: string): Promise<string> {
  const intent = await classifyIntent(message);
  if (intent === "issue") {
    const sel = resolveExplicitRepo(message) ?? { repo: defaultPrRepo, message };
    if ("error" in sel) return sel.error;
    return handleIssueRequest(sel.message, sel.repo);
  }
  if (intent === "pr") {
    return handleRoadmapRequest(chatId, message);
  }
  return handleChat(message);
}

async function runStandardIntent(chatId: number, intent: "issue" | "pr", message: string, repo: RepoRef): Promise<string> {
  return intent === "issue" ? handleIssueRequest(message, repo) : handleSinglePrRequest(message, repo, chatId);
}

// Client-facing (builder-off) entry for a fresh message: classify, then for an issue/PR resolve the
// repo. If the repo is unclear, remember the request and ASK - so the follow-up answer can complete it.
async function handleFreshStandard(chatId: number, message: string): Promise<string> {
  const intent = await classifyIntent(message);
  if (intent === "chat") {
    return handleChat(message);
  }
  const resolution = await resolveRepoForRequest(message);
  if (resolution.kind === "error") {
    return resolution.text;
  }
  if (resolution.kind === "ask") {
    await writeState(chatId, { phase: "awaiting_repo_choice", pendingMessage: message, pendingIntent: intent });
    return resolution.text;
  }
  return runStandardIntent(chatId, intent, resolution.message, resolution.repo);
}

// The user is answering an earlier "which repo?" question. Resolve the repo from their reply and run
// the ORIGINAL remembered request against it - unless they re-typed a full "repo: X <request>", in
// which case honour the new request text. An off-list repo keeps us waiting; anything that names no
// repo at all is treated as a brand-new message rather than looping forever.
async function handleRepoChoiceAnswer(
  chatId: number,
  state: Extract<PipelineState, { phase: "awaiting_repo_choice" }>,
  message: string
): Promise<string> {
  const resolution = await resolveRepoForRequest(message);
  if (resolution.kind === "error") {
    return resolution.text; // off-list repo named - report and keep the pending request alive
  }
  if (resolution.kind === "repo") {
    await clearState(chatId);
    const request = resolution.fromExplicit && resolution.message.trim() ? resolution.message : state.pendingMessage;
    return runStandardIntent(chatId, state.pendingIntent, request, resolution.repo);
  }
  // Still can't tell which repo - the reply wasn't a repo answer. Drop the pending request and treat
  // this as a new message so we don't ask the same question forever.
  await clearState(chatId);
  return handleFreshStandard(chatId, message);
}

// --- Promote a just-opened PR into another repo (the playground -> target bridge) -----------------

function lastPrFields(s: LastPrFields): LastPrFields {
  return { sourceRepo: s.sourceRepo, branch: s.branch, paths: s.paths, requestMessage: s.requestMessage, prUrl: s.prUrl };
}

// After a PR is open, does the next message ask to open the SAME change in ANOTHER repo (vs. a new
// change or chit-chat)? Kept separate from classifyIntent because it's only meaningful in this state.
async function classifyPromoteIntent(message: string): Promise<boolean> {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-v4-flash",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You just opened a pull request with a change for the user. Classify their NEXT message. ` +
          `Reply ONLY JSON {"promote": true} if they want that SAME change opened/copied/raised in ANOTHER ` +
          `repository (e.g. "raise the same PR in the target repo", "now do this in X too", "promote it to X"). ` +
          `Reply {"promote": false} for anything else - a brand-new or different change, a tweak, or chit-chat.`,
      },
      { role: "user", content: message },
    ],
  });
  logCompletion("classifyPromoteIntent", completion);
  const raw = completion.choices[0]?.message?.content;
  if (!raw) return false;
  try {
    return JSON.parse(raw).promote === true;
  } catch {
    return false;
  }
}

// Copies the exact files from the source PR's branch into a fresh branch on `dest` and opens a PR
// there - the same PR-not-direct-write boundary as everything else. No re-planning, so it works
// regardless of what dest already contains. Never a clone-and-push; a human still merges.
async function promotePr(chatId: number, ctx: LastPrFields, dest: RepoRef): Promise<string> {
  assertRepoAllowed(ctx.sourceRepo);
  assertRepoAllowed(dest);

  const files = await Promise.all(
    ctx.paths.map(async (path) => {
      const file = await fetchFile(ctx.sourceRepo, path, ctx.branch);
      if (!file) {
        throw new Error(`Expected ${path} on ${ctx.sourceRepo.owner}/${ctx.sourceRepo.repo}@${ctx.branch} but it was missing.`);
      }
      return { path, content: file.content };
    })
  );

  const destDefault = await getDefaultBranch(dest);
  const base = await octokit.rest.git.getRef({ owner: dest.owner, repo: dest.repo, ref: `heads/${destDefault}` });
  const branchName = `agent/${Date.now()}`;
  await octokit.rest.git.createRef({ owner: dest.owner, repo: dest.repo, ref: `refs/heads/${branchName}`, sha: base.data.object.sha });

  const title = firstPlanLine(ctx.requestMessage) || "Agent change";
  await commitFilesToBranch(dest, branchName, files, title);
  const { data: pr } = await octokit.rest.pulls.create({
    owner: dest.owner,
    repo: dest.repo,
    title: title.slice(0, 250),
    head: branchName,
    base: destDefault,
    body:
      `Promoted from ${ctx.sourceRepo.owner}/${ctx.sourceRepo.repo} (${ctx.prUrl}).\n\n` +
      `Original request:\n\n> ${ctx.requestMessage}\n\nFiles: ${files.map((f) => f.path).join(", ")}`,
  });

  // Point the "last PR" at the new one, so the user can chain-promote to a further repo.
  await writeState(chatId, {
    phase: "pr_opened",
    sourceRepo: dest,
    branch: branchName,
    paths: ctx.paths,
    requestMessage: ctx.requestMessage,
    prUrl: pr.html_url,
  });
  return `Opened PR #${pr.number} in ${dest.owner}/${dest.repo}: ${pr.html_url}`;
}

async function promoteToResolved(chatId: number, ctx: LastPrFields, dest: RepoRef): Promise<string> {
  if (dest.owner === ctx.sourceRepo.owner && dest.repo === ctx.sourceRepo.repo) {
    await writeState(chatId, { phase: "pr_opened", ...lastPrFields(ctx) });
    return `That change is already in ${dest.owner}/${dest.repo} (${ctx.prUrl}). Name a different repo to copy it into.`;
  }
  return promotePr(chatId, lastPrFields(ctx), dest);
}

// A single PR is open. If the user wants the same change elsewhere, promote it; otherwise treat the
// message as new (without clearing - a chat reply leaves the promote option available, and a new
// PR/issue/ask overwrites the state itself).
async function handlePrOpenedFollowup(
  chatId: number,
  state: Extract<PipelineState, { phase: "pr_opened" }>,
  message: string
): Promise<string> {
  if (await classifyPromoteIntent(message)) {
    const resolution = await resolveRepoForRequest(message);
    if (resolution.kind === "error") {
      return resolution.text;
    }
    if (resolution.kind === "ask") {
      await writeState(chatId, { phase: "awaiting_promote_target", ...lastPrFields(state) });
      const names = singlePrRepos.map((r) => `\`${r.owner}/${r.repo}\``).join(", ");
      return (
        `Which repo should I open the same change in? I can use: ${names}. ` +
        `(It's currently in \`${state.sourceRepo.owner}/${state.sourceRepo.repo}\`.)`
      );
    }
    return promoteToResolved(chatId, state, resolution.repo);
  }
  return handleFreshStandard(chatId, message);
}

// The user is naming which repo to promote the remembered change into.
async function handlePromoteTargetAnswer(
  chatId: number,
  state: Extract<PipelineState, { phase: "awaiting_promote_target" }>,
  message: string
): Promise<string> {
  const resolution = await resolveRepoForRequest(message);
  if (resolution.kind === "error") {
    return resolution.text;
  }
  if (resolution.kind === "repo") {
    return promoteToResolved(chatId, state, resolution.repo);
  }
  // The reply didn't name a repo - treat it as a new message rather than looping on the question.
  await clearState(chatId);
  return handleFreshStandard(chatId, message);
}

bot.on("text", async (ctx) => {
  const message = ctx.message.text;
  const chatId = ctx.chat.id;
  const placeholder = await ctx.reply("Thinking...");

  let resultText: string;
  try {
    // State is read in both modes now: the builder needs its pipeline state, and the client-facing
    // (builder-off) flow needs to know whether we're waiting on an answer to a "which repo?" question.
    const state = await readState(chatId);

    if (!builderEnabled) {
      if (state?.phase === "awaiting_repo_choice") {
        resultText = await handleRepoChoiceAnswer(chatId, state, message);
      } else if (state?.phase === "pr_opened") {
        resultText = await handlePrOpenedFollowup(chatId, state, message);
      } else if (state?.phase === "awaiting_promote_target") {
        resultText = await handlePromoteTargetAnswer(chatId, state, message);
      } else {
        resultText = await handleFreshStandard(chatId, message);
      }
    } else if (state?.phase === "roadmap_pending") {
      const decision = await classifyPlanResponse(state.roadmapText, message);
      if (decision === "approve") {
        resultText = await handleRoadmapApproval(chatId, state);
      } else if (decision === "revise") {
        resultText = await handleRoadmapRevision(chatId, state, message);
      } else {
        resultText = await handleStandardIntent(chatId, message);
      }
    } else if (state?.phase === "milestone_plan_pending") {
      const decision = await classifyPlanResponse(state.milestonePlanText, message);
      if (decision === "approve") {
        resultText = await handleMilestonePlanApproval(chatId, state);
      } else if (decision === "revise") {
        resultText = await handleMilestonePlanRevision(chatId, state, message);
      } else {
        resultText = await handleStandardIntent(chatId, message);
      }
    } else if (state?.phase === "milestone_pending_ci") {
      resultText = await handleMilestoneCiCheck(chatId, state);
    } else if (state?.phase === "milestone_ci_failed") {
      resultText = await handleMilestoneCiFailureRevision(chatId, state, message);
    } else if (state?.phase === "roadmap_awaiting_promote") {
      const decision = await classifyVerificationResponse(message);
      if (decision === "promote") {
        resultText = await handleRoadmapPromote(chatId, state);
      } else if (decision === "revise") {
        resultText = await handleRoadmapPromoteRevision(chatId, state, message);
      } else {
        resultText = await handleStandardIntent(chatId, message);
      }
    } else {
      resultText = await handleStandardIntent(chatId, message);
    }
  } catch (err) {
    console.error("Failed to handle message:", err);
    resultText = "Sorry, something went wrong handling that message.";
  }

  const chunks = splitForTelegram(resultText);

  // Operational messages (PR/issue links, repo names) contain underscores that Telegram's Markdown
  // silently mangles - "Target_Repo_For_AgentOps" becomes italicised and the link breaks. Telegram
  // auto-links bare URLs anyway, so send anything containing a URL as plain text; only the
  // conversational/DeepSeek replies (which use *bold*/_italic_ intentionally) go through Markdown.
  const useMarkdown = (text: string): boolean => !/https?:\/\//.test(text);

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      placeholder.message_id,
      undefined,
      chunks[0],
      useMarkdown(chunks[0]) ? { parse_mode: "Markdown" } : {}
    );
  } catch (err) {
    console.error("Formatted reply failed, falling back to plain text:", err);
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, chunks[0]);
    } catch (fallbackErr) {
      // Both attempts failed for reasons other than length (already handled by chunking above) -
      // log and move on rather than letting an unhandled rejection take down the whole process.
      console.error("Plain-text fallback also failed:", fallbackErr);
    }
  }

  for (const chunk of chunks.slice(1)) {
    try {
      await ctx.reply(chunk, useMarkdown(chunk) ? { parse_mode: "Markdown" } : {});
    } catch (err) {
      console.error("Formatted follow-up failed, falling back to plain text:", err);
      try {
        await ctx.reply(chunk);
      } catch (fallbackErr) {
        console.error("Plain-text follow-up also failed:", fallbackErr);
      }
    }
  }
});
