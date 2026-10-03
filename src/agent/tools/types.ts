// What every agent tool looks like: a JSON-schema definition the model sees, plus an executor
// the loop runs when the model calls it. One file per tool implements this (read-repo.ts, and
// in Layer C create-issue.ts / open-pr.ts). The loop only ever depends on this shape.

import type OpenAI from "openai";

export interface AgentTool {
  /** The definition passed to the model (name, description, JSON-schema parameters). */
  definition: OpenAI.Chat.Completions.ChatCompletionFunctionTool;
  /**
   * Run the tool. `argsJson` is the raw JSON-string of arguments the model produced. Returns a
   * string (usually JSON) that is fed back to the model as the tool result. A tool validates its
   * own inputs and should return an error-shaped result rather than throwing for expected bad input.
   */
  execute(argsJson: string): Promise<string>;
}
