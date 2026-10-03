// The reasoning loop - orchestration only (CLAUDE_agent_v3.md Section 3 & 12). It does NOT know
// about GitHub, Telegram, or any specific tool: it just runs the "ask the model -> it may call a
// tool -> feed the result back -> repeat" cycle, bounded so a bad reasoning chain can't run away
// (Section 5: "Cap the agent loop").
//
// Analogy: a phone conversation with an assistant who can put you on hold to look something up.
// You ask; they either answer, or say "one sec" and look it up (a tool call); you read them what
// they found; they continue - until they give a final answer or you run out of patience (maxSteps).

import type OpenAI from "openai";
import type { AgentTool } from "./tools/types.js";

export interface AgentLoopOptions {
  client: OpenAI;
  model: string;
  systemPrompt: string;
  tools: AgentTool[];
  /** Hard ceiling on model round-trips per message, so the loop always terminates. */
  maxSteps: number;
}

export async function runAgentLoop(
  opts: AgentLoopOptions,
  conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): Promise<string> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.systemPrompt },
    ...conversation,
  ];
  const toolDefs = opts.tools.map((t) => t.definition);
  const toolsByName = new Map(opts.tools.map((t) => [t.definition.function.name, t]));

  for (let step = 0; step < opts.maxSteps; step++) {
    const completion = await opts.client.chat.completions.create({
      model: opts.model,
      messages,
      ...(toolDefs.length > 0 ? { tools: toolDefs, tool_choice: "auto" as const } : {}),
    });

    const message = completion.choices[0]?.message;
    if (!message) return "The model returned an empty response.";
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // A final text answer - we're done.
      return message.content ?? "";
    }

    // Run each requested tool and feed the result back for the next step.
    for (const call of toolCalls) {
      // We only define function tools; ignore any other kind the SDK's union allows.
      if (call.type !== "function") {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "unsupported tool call type" }) });
        continue;
      }
      const tool = toolsByName.get(call.function.name);
      let result: string;
      if (!tool) {
        console.warn(`[agent] model called unknown tool "${call.function.name}"`);
        result = JSON.stringify({ error: `unknown tool: ${call.function.name}` });
      } else {
        console.log(`[agent] step ${step + 1}: ${call.function.name}(${call.function.arguments})`);
        try {
          result = await tool.execute(call.function.arguments);
        } catch (err) {
          // A tool boundary failure is reported back to the model as data, so it can recover or
          // explain, rather than crashing the whole turn.
          console.error(`[agent] tool "${call.function.name}" threw:`, err);
          result = JSON.stringify({ error: `tool ${call.function.name} failed: ${(err as Error).message}` });
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // Ran out of steps while still calling tools. Make one final tool-less request so the model must
  // answer in words with what it has, instead of leaving the user with nothing.
  console.warn(`[agent] hit maxSteps (${opts.maxSteps}); forcing a final answer.`);
  const forced = await opts.client.chat.completions.create({ model: opts.model, messages });
  return (
    forced.choices[0]?.message?.content ??
    "I couldn't finish that within my tool-call budget. Try narrowing the request."
  );
}
