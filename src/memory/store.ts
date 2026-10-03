// The single memory boundary (CLAUDE_agent_v3.md Section 12: "all DB through memory/"). It stores
// a short running conversation history per Telegram chat, so the agent can hold context across
// turns AND across serverless cold starts (Section 4). Deliberately simple: recent turns per chat,
// load the last K - no summarization, embeddings or RAG (those are deferred).
//
// Two implementations behind one interface:
//   - UpstashMemory : persistent, over Upstash Redis's REST API (works anywhere over HTTPS).
//   - InMemoryMemory: a Map, for local dev when no creds are set. Does NOT survive a restart -
//                     it only exists so the app runs locally without provisioning a store.

import { config } from "../config/env.js";

/** One stored message. Only clean user/assistant text is kept (never tool-call plumbing), so a
 *  loaded history is always valid to replay as prior turns. */
export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationMemory {
  /** The most recent turns for a chat (oldest first), capped at the retention limit. */
  load(chatId: number): Promise<StoredTurn[]>;
  /** Append new turns (e.g. the user message then the agent reply), trimming to the limit. */
  append(chatId: number, turns: StoredTurn[]): Promise<void>;
}

// Keep ~10 turns (20 messages). Enough to hold a conversation; small enough to stay cheap and well
// under the model's context. "K" from the doc's "load the last K on each request".
const MAX_MESSAGES = 20;

const REDIS_TIMEOUT_MS = 10_000;

function historyKey(chatId: number): string {
  return `agentops:chat:${chatId}:history`;
}

// --- Upstash (persistent) -------------------------------------------------------

class UpstashMemory implements ConversationMemory {
  constructor(private readonly url: string, private readonly token: string) {}

  // One Redis command over Upstash's REST API. Body is the command as a JSON array, e.g.
  // ["SET", key, value]; the response is { result: ... }. Fresh AbortSignal per call.
  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Upstash ${args[0]} failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { result?: unknown; error?: string };
    if (data.error) throw new Error(`Upstash ${args[0]} error: ${data.error}`);
    return data.result;
  }

  async load(chatId: number): Promise<StoredTurn[]> {
    const raw = await this.command(["GET", historyKey(chatId)]);
    if (typeof raw !== "string" || raw.length === 0) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoredTurn[]).slice(-MAX_MESSAGES) : [];
    } catch {
      // Corrupt value shouldn't break the conversation - start fresh rather than throw.
      return [];
    }
  }

  async append(chatId: number, turns: StoredTurn[]): Promise<void> {
    // Read-modify-write. A single user chats sequentially, so the small race window is acceptable
    // at this scale; if it ever matters, switch to RPUSH + LTRIM.
    const existing = await this.load(chatId);
    const next = [...existing, ...turns].slice(-MAX_MESSAGES);
    await this.command(["SET", historyKey(chatId), JSON.stringify(next)]);
  }
}

// --- In-memory fallback (local dev only) ----------------------------------------

class InMemoryMemory implements ConversationMemory {
  private readonly store = new Map<number, StoredTurn[]>();

  async load(chatId: number): Promise<StoredTurn[]> {
    return (this.store.get(chatId) ?? []).slice(-MAX_MESSAGES);
  }

  async append(chatId: number, turns: StoredTurn[]): Promise<void> {
    const next = [...(this.store.get(chatId) ?? []), ...turns].slice(-MAX_MESSAGES);
    this.store.set(chatId, next);
  }
}

// --- selection ------------------------------------------------------------------

function createMemory(): ConversationMemory {
  const { upstashUrl, upstashToken } = config.memory;
  if (upstashUrl && upstashToken) {
    return new UpstashMemory(upstashUrl, upstashToken);
  }
  console.warn(
    "[memory] UPSTASH_REDIS_REST_URL/TOKEN not set - using in-memory store. Conversation history " +
      "will NOT persist across restarts/cold starts. Set the Upstash creds for real persistence."
  );
  return new InMemoryMemory();
}

/** The process-wide conversation memory, chosen from config at import time. */
export const memory: ConversationMemory = createMemory();
