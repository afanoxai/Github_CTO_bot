// The ONE place environment variables are read and validated (CLAUDE_agent_v3.md
// Section 12: "Config/env loaded and validated once, not read via process.env
// scattered across files. Fail fast at startup with a clear message if something's
// missing.").
//
// Analogy: this is the building's front desk. Every other module asks the front
// desk for what it needs (`config.llm.model`) instead of each wandering off to
// rummage in `process.env`. When a key is wrong or missing, there's exactly one
// place it's caught, and the error names the fix.
//
// Nothing here talks to the network - it only reads and shapes configuration.

import "dotenv/config";
import type { RepoRef } from "../types/index.js";

// --- small parsing helpers (pure, so they're trivial to reason about) -----------

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in ` +
        `(or set it in your Vercel project's environment variables and redeploy).`
    );
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** LLM_MODEL is swappable by config alone (Layer A). Falls back to the model v1/v2 ran on. */
const DEFAULT_LLM_MODEL = "deepseek-v4-flash";

function parseRepoRef(full: string, sourceName: string): RepoRef {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) {
    throw new Error(`${sourceName} entry "${full}" must be in "owner/repo" format.`);
  }
  return { owner: owner.trim(), repo: repo.trim() };
}

/** Comma-separated "owner/repo,owner/repo" -> RepoRef[]. Empty/unset -> []. */
function parseRepoList(name: string): RepoRef[] {
  const raw = optional(name);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((full) => parseRepoRef(full, name));
}

/** Comma-separated numeric Telegram IDs -> Set<number>. Non-numeric entries are rejected loudly. */
function parseUserIds(name: string): Set<number> {
  // Allowed to be empty at first-run (the bootstrap trick: message the bot, read the rejected ID
  // from the logs, then add it) - so we require the var to EXIST but tolerate an empty value.
  const raw = process.env[name];
  if (raw === undefined) {
    throw new Error(
      `Missing required environment variable ${name}. It may be empty at first - run the bot, message ` +
        `it, and your rejected user ID will be logged so you can add it.`
    );
  }
  const ids = new Set<number>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n)) {
      throw new Error(`${name} contains a non-numeric Telegram ID: "${part}". Use comma-separated numbers.`);
    }
    ids.add(n);
  }
  return ids;
}

// --- the shape every other module consumes --------------------------------------

export interface AppConfig {
  telegram: {
    botToken: string;
    allowedUserIds: Set<number>;
    /** Only needed by the Vercel webhook entry; undefined for local polling. */
    webhookSecret: string | undefined;
  };
  llm: {
    apiKey: string;
    /** Swappable via LLM_MODEL (Layer A). */
    model: string;
    baseUrl: string;
  };
  github: {
    pat: string;
    /** Free-write scratch space for the agent (CLAUDE_agent_v3.md Section 5). */
    playgroundRepo: RepoRef;
    /** Named allow-list of repos the agent may open PRs/issues into. Never org-wide. */
    targetRepos: RepoRef[];
    /**
     * Explicit, human-curated list of repos that MAY be permanently DELETED. Deliberately separate
     * from targetRepos: only repos a human lists here can ever be deleted, and a repo that is also
     * on the work allow-list (or the playground) is refused. Empty/unset -> deletion is disabled.
     * Mirrors the allow-list principle: the model naming a repo is not the same as it being safe.
     */
    deletableRepos: RepoRef[];
  };
  memory: {
    // Upstash Redis REST credentials (Layer D). Both absent -> the in-memory fallback is used
    // (fine for local dev, but does NOT persist across serverless cold starts).
    upstashUrl: string | undefined;
    upstashToken: string | undefined;
  };
}

function buildConfig(): AppConfig {
  // Repo config migrates from the v2 var names toward the v3 ones without breaking an existing
  // deployment: prefer v3's names, fall back to v2's. (CLAUDE_agent_v3.md Section 7 supersedes
  // the single GITHUB_REPO with playground + an allow-list.)
  const playgroundRaw = required("GITHUB_PLAYGROUND_REPO");
  const v3Targets = parseRepoList("ALLOWED_TARGET_REPOS");
  const targetRepos = v3Targets.length > 0 ? v3Targets : parseRepoList("GITHUB_PR_REPOS");

  return {
    telegram: {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      allowedUserIds: parseUserIds("ALLOWED_TELEGRAM_USER_IDS"),
      webhookSecret: optional("TELEGRAM_WEBHOOK_SECRET"),
    },
    llm: {
      apiKey: required("DEEPSEEK_API_KEY"),
      model: optional("LLM_MODEL") ?? DEFAULT_LLM_MODEL,
      baseUrl: optional("LLM_BASE_URL") ?? "https://api.deepseek.com",
    },
    github: {
      pat: required("GITHUB_PAT"),
      playgroundRepo: parseRepoRef(playgroundRaw, "GITHUB_PLAYGROUND_REPO"),
      targetRepos,
      // Separate opt-in list. Unset/empty means the agent simply cannot delete anything.
      deletableRepos: parseRepoList("ALLOWED_DELETABLE_REPOS"),
    },
    memory: {
      upstashUrl: optional("UPSTASH_REDIS_REST_URL"),
      upstashToken: optional("UPSTASH_REDIS_REST_TOKEN"),
    },
  };
}

// Built once at module load and shared. Importing this module validates the environment - a
// missing/malformed core var throws here, at startup, with a message that names the fix, rather
// than surfacing as a confusing failure deep in a request later.
export const config: AppConfig = buildConfig();
