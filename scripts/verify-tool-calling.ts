// Linchpin check (run: `npm run verify:tools`). CLAUDE_agent_v3.md Section 3:
// "Verify DeepSeek's tool-calling support at build time ... this is the linchpin of the
// whole design." Before building the agent loop (Layer B), this confirms the exact API
// shape the loop depends on, live:
//   1. Given a tool, the model returns a tool CALL (finish_reason "tool_calls") rather
//      than making up an answer.
//   2. We can feed the tool's result back and get a grounded final text answer.
//
// This is the whole agent loop in miniature, with one throwaway tool. If it fails on the
// network (Telegram/DeepSeek can be ISP-blocked locally - see the VPN memory), run it
// again with a system-wide VPN connected; a network error here is not an API-shape failure.

import OpenAI from "openai";
import { config } from "../src/config/env.js";

const client = new OpenAI({
  apiKey: config.llm.apiKey,
  baseURL: config.llm.baseUrl,
  timeout: 60_000,
  maxRetries: 2,
});

// One trivial, self-contained tool. The model can't answer correctly without calling it,
// so a correct final answer proves the round trip actually happened.
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add_numbers",
      description: "Add two integers and return their sum. Use this for any addition.",
      parameters: {
        type: "object",
        properties: {
          a: { type: "integer", description: "first addend" },
          b: { type: "integer", description: "second addend" },
        },
        required: ["a", "b"],
      },
    },
  },
];

function runAddTool(args: string): string {
  const { a, b } = JSON.parse(args) as { a: number; b: number };
  return JSON.stringify({ sum: a + b });
}

async function main(): Promise<void> {
  console.log(`Verifying tool-calling against ${config.llm.baseUrl} with model "${config.llm.model}"...\n`);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: "You are a calculator. Always use the add_numbers tool for addition." },
    { role: "user", content: "What is 4242 + 1337? Use your tool." },
  ];

  // --- Step 1: does the model ASK to call the tool? ---
  const first = await client.chat.completions.create({
    model: config.llm.model,
    messages,
    tools,
    tool_choice: "auto",
  });

  const choice = first.choices[0];
  const toolCalls = choice?.message?.tool_calls;
  console.log(`Step 1: finish_reason=${choice?.finish_reason}, tool_calls=${toolCalls?.length ?? 0}`);

  if (!toolCalls || toolCalls.length === 0) {
    console.error(
      "\nFAIL: the model did not return a tool call. finish_reason was " +
        `"${choice?.finish_reason}". This model/endpoint may not support function calling as expected - ` +
        "the Layer B design needs to be reconsidered before building on it."
    );
    process.exit(1);
  }

  const call = toolCalls[0];
  console.log(`        -> model wants: ${call.function.name}(${call.function.arguments})`);

  // --- Step 2: feed the tool result back and get a grounded final answer ---
  const result = runAddTool(call.function.arguments);
  messages.push(choice.message);
  messages.push({ role: "tool", tool_call_id: call.id, content: result });

  const second = await client.chat.completions.create({ model: config.llm.model, messages, tools });
  const finalText = second.choices[0]?.message?.content ?? "";
  console.log(`\nStep 2: final answer -> ${finalText}`);

  if (finalText.includes("5579")) {
    console.log("\nPASS: the model called the tool, used the result, and answered correctly (4242+1337=5579).");
    console.log("Linchpin confirmed - the agent loop can be built on this.");
  } else {
    console.log(
      "\nPARTIAL: tool-calling works (Step 1 passed) but the final answer didn't contain the expected sum. " +
        "The loop shape is fine; note the model's answer above."
    );
  }
}

main().catch((err) => {
  console.error("\nERROR running the verification:", err?.message ?? err);
  console.error(
    "If this is a connection/timeout error, it's almost certainly the local ISP block, not the API - " +
      "reconnect a system-wide VPN and re-run `npm run verify:tools`."
  );
  process.exit(1);
});
