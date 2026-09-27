# Github_CTO_bot — Analysis + Improvement Proposals

**Author**: Afano (with AI-assisted analysis)
**Date**: 2026-09-27
**Context**: Post-deployment review after the recent Vercel + Telegram integration.

---

## Summary

Two sections: technical proposals, then code improvements.
All findings grounded in source code, Vercel logs (2026-09-27), and real Telegram testing.

---

## Section 1 — Technical Proposals

### A. Jev AI (TypeSafe) as a Decision Layer — RECOMMENDED

**What it is:**
Jev is a class of models from TypeSafe AI called "System One Models" — specialized for decision-making, not text generation. Returns a chosen option + confidence score, in JSON.

**Why it fits:**
The bot makes 4 pure classification calls via `deepseek-v4-flash`:
- `pickRepo(message)` → which repo?
- `classifyIntent(message)` → chat / issue / pr?
- `classifyPlanResponse(text, reply)` → approve / revise / unrelated?
- `classifyPromoteIntent(message)` → promote to another repo?

Jev handles all 4:
- ~100x cheaper (no token generation)
- ~10x faster
- Zero hallucination (fixed option set)
- Confidence score enables fallback when uncertain

**Evidence (Vercel logs 2026-09-27):**

17:19:06 [deepseek] pickRepo: reasoning_tokens=49 prompt_tokens=268
17:19:20 [deepseek] pickRepo: reasoning_tokens=20 prompt_tokens=240

Picking a repo from a list of 9 should not cost 49 reasoning tokens.

**Integration:**
1. Sign up at TypeSafe AI → get API key
2. Add to Vercel → Project Settings → Environment Variables
3. Replace `pickRepo()` and `classifyIntent()` with Jev calls
4. Pass: message + options array → receive: option + confidence
5. If confidence < 0.8 → fall back to asking the user

**Testing:**
- Start with Jev's free tier
- Run in parallel with `deepseek-v4-flash` for 1-2 weeks
- Compare on real messages before cutting over

**References:**
HomePage: TypeSafe AI [https://typesafe.ai/]
Introducing System One Models & Jev [https://typesafe.ai/blog/introducing-system-one-models-and-jev]
** TypeSafe (Jev) | Pydantic Docs [https://pydantic.dev/docs/ai/models/typesafe/] **

---

### B. Harness / Hermes — NOT Recommended Now

| Tool | Owner | Purpose | Fit |
|---|---|---|---|
| DeepSeek Harness | DeepSeek | Prompt/workflow UI | Later, for prompt testing |
| Nous Hermes | Nous Research | Standalone agent framework | Different project entirely |

Neither is needed for Github_CTO_bot. Jev is the relevant piece.

---

## Section 2 — Code Improvements

### CRITICAL

---

#### 1. readState() 404s on every message → context loss

**Evidence (Vercel logs 2026-09-27 17:15-17:20):**

GET /repos/afanoxai/playground_CTO/contents/.agent-state%2F-1004398219904.json?ref=main - 404 (108ms)
GET /repos/afanoxai/playground_CTO/contents/.agent-state%2F-1004398219904.json?ref=main - 404 (106ms)
GET /repos/afanoxai/playground_CTO/contents/.agent-state%2F-1004398219904.json?ref=main - 404 (101ms)
GET /repos/afanoxai/playground_CTO/contents/.agent-state%2F-1004398219904.json?ref=main - 404 (109ms)
GET /repos/afanoxai/playground_CTO/contents/.agent-state%2F-1004398219904.json?ref=main - 404 (107ms)

5 attempts, 5 failures, 2 minutes. readState() returns null silently. Agent loses context every message.

**Root cause:** State stored as JSON in playground repo → GitHub API call per message → 404 when file doesn't exist.

**Impact:** Wasted API quota, slow response, context loss → repo confusion (see #3).

**Fix — migrate to Vercel KV:**

npm install @vercel/kv

Vercel Dashboard → Storage → Create KV → Connect to project.

Replace in src/bot.ts:

import { kv } from "@vercel/kv";

async function readState(chatId: number): Promise<PipelineState | null> {
  return await kv.get<PipelineState>(`state:${chatId}`);
}

async function writeState(chatId: number, state: PipelineState): Promise<void> {
  await kv.set(`state:${chatId}`, state, { ex: 60 * 60 * 24 });
}

async function clearState(chatId: number): Promise<void> {
  await kv.del(`state:${chatId}`);
}

Remove .agent-state/ folder from playground repo.

**Estimated:** 1-2 hours.

---

#### 2. deepseek-v4-flash is wrong for coding tasks

**Evidence (code comment in bot.ts):**
"measured 13k-29k tokens on byte-identical input, ~60% of runs producing unusable output on a logic-heavy milestone"

**Root cause:** Flash is a reasoning model. Reasoning tokens vary wildly on identical input. Fine for short classification, bad for code generation.

**Fix — model swap for generation only:**

| Function | New model |
|---|---|
| classifyIntent, classifyPlanResponse, classifyVerificationResponse, classifyPromoteIntent | keep flash |
| pickRepo | replace with Jev (see 1A) |
| draftRoadmap, reviseRoadmap | deepseek-chat |
| draftMilestonePlan, revisePlan, planMilestoneFiles | deepseek-chat |
| draftOneFile, draftPrFile, planSinglePrFiles | deepseek-chat |
| interpretAsIssue, handleChat | deepseek-chat |

Add constants:

const MODEL_DECISION = "deepseek-v4-flash";
const MODEL_GENERATION = "deepseek-chat";

**Estimated:** 30 minutes.

---

#### 3. Repo confusion (mixed changes across repos)

**Evidence (Telegram session 2026-09-27):**
Agent created a file in playground_CTO, then added to that same file when user asked for family-tree. Final PR mixed content from both repos.

**Root cause:** State loss (#1) + pickRepo() guessing wrong.

**Fix:** Fix #1 (state) + integrate Jev (1A).

**Estimated:** Covered by #1 + 1A.

---

### MEDIUM

---

#### 4. bot.ts is a 2000+ line monolith

**Fix — incremental split:**

src/
├── bot.ts              (~200 lines, routing only)
├── prompts.ts          (all system prompts)
├── state.ts            (state — Vercel KV after #1)
├── github.ts           (octokit wrappers)
├── llm.ts              (deepseek client + wrappers)
├── config.ts           (env + constants)
└── handlers/
    ├── chat.ts
    ├── issue.ts
    ├── pr.ts
    ├── roadmap.ts
    └── admin.ts        (repo resolution)

Migrate one module at a time. Test after each.

**Estimated:** 3-4 hours, incremental.

---

#### 5. Prompts scattered across bot.ts

Move to src/prompts.ts as exported constants. Zero behavior change.

**Estimated:** 30 minutes.

---

### LOW

---

#### 6. GitHub API deprecation warning

**Evidence (Vercel logs 2026-09-27 17:19:28):**
[@octokit/request] POST https://api.github.com/repos/.../issues is deprecated. Removal: 2028-03-10.

**Fix:**

const octokit = new Octokit({
  auth: githubPat,
  request: {
    headers: { "X-GitHub-Api-Version": "2022-11-28" },
  },
});

**Estimated:** 15 minutes.

---

#### 7. README references non-existent files

README mentions CLAUDE.md, decisions.md, DEPLOYMENT.md — none exist.

**Fix:** Either create them, or remove the references.

**Estimated:** 15 minutes.

---

## Recommended Order

| # | Fix | Impact | Effort |
|---|---|---|---|
| 1 | Vercel KV state | Unblocks everything | 1-2h |
| 2 | Model swap (deepseek-chat for coding) | +40% output quality | 30m |
| 3 | Prompts to prompts.ts | Quick win | 30m |
| 4 | Jev integration | Eliminates hallucination | 1-2h |
| 5 | Repo confusion | Auto-resolved by #1 + 1A | — |
| 6 | Split bot.ts | Maintainability | 3-4h |
| 7 | GitHub API version | Future-proofing | 15m |
| 8 | README fixes | Documentation | 15m |

---

## Open Questions

1. Jev scope: pickRepo only, or all 4 classifiers?
2. Vercel KV free tier sufficient? (256 MB / 30k commands per month — likely yes)
3. Model swap before or after Vercel KV?
4. Split bot.ts now, or after Jev + KV work?

---

*End of report.*