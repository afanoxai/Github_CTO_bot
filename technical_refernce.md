# Technical Reference — Telegram GitHub Agent (v1)

A plain-language overview of what powers the agent, the exact instructions it runs on, and how to change the model later. Written as a reference — no action needed, just for understanding.

---

## 1. The LLM model

- **Provider:** DeepSeek
- **Model:** `deepseek-v4-flash`
- **How it's accessed:** through an OpenAI-compatible API. DeepSeek's API speaks the same format as OpenAI's, so the standard OpenAI client library works by simply pointing it at DeepSeek's address — no DeepSeek-specific SDK needed.
- **Endpoint (base URL):** `https://api.deepseek.com`

The API key lives only as an environment variable (`DEEPSEEK_API_KEY`), never in the code or the repository.

> Note: model names on any provider can change over time (DeepSeek retired the older `deepseek-chat` alias in mid-2026). Worth a quick check of their docs before any swap.

---

## 2. How the agent uses the model

Every message from an approved user is first **classified** into one of three intents, then routed to the matching flow. The model is called separately at each step, each with its own focused instruction rather than one big catch-all prompt:

1. **Intent classification** — labels the message `chat`, `issue`, or `pr`. Defaults to `chat` whenever it's not confident, so an ambiguous message never accidentally triggers a GitHub action.
2. **Chat** — answers conversationally.
3. **Issue** — turns the message into a GitHub issue (title + body) and files it.
4. **PR** — checks the repository's real files first, decides whether the change is possible, then writes the file and opens a pull request for review.

A safety detail worth noting: the PR flow reads the repository's actual file list (and the current contents of any file being edited) *before* asking the model to write anything — so changes are grounded in what's really in the repo, not guessed. And the agent only ever opens a pull request; it never writes to the main branch directly.

---

## 3. System instructions (exact text injected into the model)

These are the verbatim instructions from the code (`src/bot.ts`), one per step.

**Shared formatting note** (appended wherever the model writes text shown in Telegram):
> This text is shown directly in Telegram, not GitHub, so format it for Telegram's Markdown: use *word* (single asterisks) for bold, _word_ for italic, no ## headers, no markdown tables, plain paragraphs.

**Intent classification:**
> Classify the developer's Telegram message into exactly one intent for a GitHub agent. Reply with ONLY a json object shaped like {"intent": "chat" | "issue" | "pr"}. "issue" = they want a bug/task tracked as a GitHub issue (reporting a problem, asking to file/log something). "pr" = they want an actual file/code change made and submitted as a pull request. "chat" = anything else: greetings, questions, general conversation, or anything unclear. If you are not confident it is "issue" or "pr", choose "chat".

**Chat reply:**
> *(uses the shared formatting note above as its full system instruction)*

**Issue drafting:**
> You turn a developer's message into a GitHub issue. Reply with ONLY a json object shaped like {"title": "short summary", "body": "fuller description"} and nothing else.

**PR planning** (decides *whether* and *which file*):
> You decide whether a developer's message can be turned into a single small file change for a GitHub pull request, given the repository's current file list below. Reply with ONLY a json object: if it can be done, {"canFulfill": true, "path": "relative/file/path.ext"} — reuse an existing path from the list when updating a file, or give a sensible new relative path when creating one. If it genuinely cannot be done, reply {"canFulfill": false, "reason": "short explanation for the developer"}. The "reason" field is the only part of this response a person ever reads. *(+ the shared formatting note, + the live repository file list)*

**PR drafting** (writes the actual file):
> You write the complete new content for one file in a GitHub pull request, grounded in the repository's current file list and (if the file already exists) its current content below. Reply with ONLY a json object shaped like {"content": "full new file content", "commitMessage": "short commit message", "prTitle": "short PR title", "prBody": "PR description"}. "content" must be the COMPLETE new content of the file, not a diff. *(+ the target file path, the repository file list, and the file's current content if it exists)*

---

## 4. Can we change the model easily?

**Yes — the agent was built so this is straightforward.** How much work depends on what you switch to:

| Switching to... | What changes | Effort |
|---|---|---|
| A different **DeepSeek** model | Just the model name string (it appears in each call in `src/bot.ts`) | Trivial |
| A different **OpenAI-compatible** provider | The base URL + API key (config) + model name | Small — config only, no logic rewrite |
| A **structurally different** provider (e.g. Anthropic's own format) | A bit of the client-setup code, since the request/response shape differs | Moderate, but contained |

Why it's easy: the code uses the standard OpenAI-compatible client and keeps the provider address and key as configuration (environment variables). The model name currently appears in each call, so a DeepSeek-to-DeepSeek swap is a handful of identical edits in one file — easy to centralize into a single constant later if we swap often.

> One caveat: models vary in how reliably they return valid JSON. The agent already guards against bad or empty responses — it defaults to safe behavior (treats an unclear message as chat, declines a PR rather than guessing). Still, after any model switch it's worth a quick test through all three flows (chat / issue / PR) to confirm the new model formats its responses as expected.

---

## 5. Where everything lives in the code

- `src/bot.ts` — all model calls, the system instructions above, the allow-list check, and the three handlers (chat / issue / PR). This one file is where anything model-related is changed.
- `src/index.ts` — local run entry point (long-polling).
- `api/telegram.ts` — production entry point on Vercel (webhook).
- Environment variables (`.env` locally / Vercel settings in production) — hold the API keys, the target repo, the allowed user IDs, and (if you switch providers) the base URL.

---

## 6. Built-in safety behaviors (for reference)

- **Approved users only** — messages from any Telegram ID not on the allow-list are ignored silently.
- **Pull requests, never direct writes** — code changes always land as a PR for human review; nothing is committed to the main branch automatically.
- **Grounded changes** — the PR flow reads the real repo contents before drafting, so it edits what's actually there.
- **Safe path check** — file paths proposed by the model are validated (no absolute paths, no `..`) before any file is written.
- **Fails safe** — empty or malformed model output defaults to the harmless path (chat, or declining the PR), never a wrong action.
- **Secrets stay in the environment** — API keys and tokens are never in the code or the repository.

---

*This reference covers v1. As the agent grows toward the fuller "CTO-agent" vision — multiple repositories, a knowledge/reference library — this file should grow with it.*