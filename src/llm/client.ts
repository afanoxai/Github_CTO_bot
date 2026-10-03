// The single LLM boundary (CLAUDE_agent_v3.md Section 12: "all model calls through llm/ ...
// nothing else calls the model directly"). DeepSeek is OpenAI-compatible, so we use the OpenAI
// SDK pointed at DeepSeek's base URL. Timeouts/retries preserved from v1's tuned values.

import OpenAI from "openai";
import { config } from "../config/env.js";

// DeepSeek's reasoning-token burn is large and variable, so a single completion (especially one
// generating file content) needs real headroom, not a "detect a dead socket" budget. maxRetries
// raised for unstable links (a real v1 failure mode: repeated ECONNRESET over a flaky VPN).
const LLM_TIMEOUT_MS = 180_000;

export const llm = new OpenAI({
  apiKey: config.llm.apiKey,
  baseURL: config.llm.baseUrl,
  timeout: LLM_TIMEOUT_MS,
  maxRetries: 5,
});
