// Ties memory to the agent for one incoming message: load the chat's recent history, let the agent
// reason with it as context, then save the new turn. This is the seam the Telegram layer calls -
// it holds the load/reason/save shape in one place so that flow is testable without Telegram.

import type OpenAI from "openai";
import { Agent } from "./agent.js";
import { memory, type StoredTurn } from "../memory/store.js";

/** Stored turns -> the message-param shape the agent loop replays as prior context. */
function toPriorTurns(turns: StoredTurn[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return turns.map((t) => ({ role: t.role, content: t.content }));
}

/**
 * Handle one user message for `chatId`: reason with the chat's remembered history (the agent picks
 * which allowed repo to act on itself), then persist this turn. Returns the agent's reply text.
 */
export async function handleMessage(chatId: number, userMessage: string): Promise<string> {
  const history = await memory.load(chatId);

  const agent = new Agent();
  const reply = await agent.reply(userMessage, toPriorTurns(history));

  await memory.append(chatId, [
    { role: "user", content: userMessage },
    { role: "assistant", content: reply },
  ]);

  return reply;
}
