// The Telegram boundary: receive a message, gate it on the sender allow-list, hand it to the agent
// (via the memory-backed conversation seam), and send the reply back. It contains no agent/GitHub
// logic itself - just Telegram wiring. The Telegraf timeout/error-handling and the send-with-
// Markdown-fallback flow are preserved from v1/v2, which earned them against real failures.

import { Telegraf } from "telegraf";
import { config } from "../config/env.js";
import { handleMessage } from "../agent/conversation.js";
import { splitForTelegram, shouldUseMarkdown, toTelegramMarkdown } from "./format.js";

// Telegraf wraps each update in its own timeout and, on firing, its default handler re-throws and
// crashes the process. Raise the ceiling to just under Vercel's 300s function limit and register a
// real handler, so a slow/failed update reports a friendly message and the process survives.
export const bot = new Telegraf(config.telegram.botToken, { handlerTimeout: 280_000 });

bot.catch((err, ctx) => {
  console.error("Unhandled error while processing update:", err);
  ctx
    .reply("Sorry, something went wrong (or took too long) handling that. Try again, or with a smaller request.")
    .catch((replyErr) => console.error("Couldn't even send the error reply:", replyErr));
});

// Sender allow-list (CLAUDE_agent_v3.md Section 5). The rejection log wording is kept exact: it's the
// bootstrap trick for finding a new user's numeric ID (message the bot, read the ID from the logs).
bot.use((ctx, next) => {
  const senderId = ctx.from?.id;
  if (senderId === undefined || !config.telegram.allowedUserIds.has(senderId)) {
    console.log(`Ignored message from unauthorized user ID: ${senderId}`);
    return;
  }
  return next();
});

bot.on("text", async (ctx) => {
  const message = ctx.message.text;
  const chatId = ctx.chat.id;
  const placeholder = await ctx.reply("Thinking...");

  let resultText: string;
  try {
    resultText = await handleMessage(chatId, message);
  } catch (err) {
    console.error("Failed to handle message:", err);
    resultText = "Sorry, something went wrong handling that message.";
  }

  const chunks = splitForTelegram(toTelegramMarkdown(resultText));

  // Replace the "Thinking..." placeholder with the first chunk; fall back to plain text if Markdown
  // parsing is rejected (an unbalanced * or _ in a conversational reply shouldn't drop the message).
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      placeholder.message_id,
      undefined,
      chunks[0],
      shouldUseMarkdown(chunks[0]) ? { parse_mode: "Markdown" } : {}
    );
  } catch (err) {
    console.error("Formatted reply failed, falling back to plain text:", err);
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, chunks[0]);
    } catch (fallbackErr) {
      console.error("Plain-text fallback also failed:", fallbackErr);
    }
  }

  for (const chunk of chunks.slice(1)) {
    try {
      await ctx.reply(chunk, shouldUseMarkdown(chunk) ? { parse_mode: "Markdown" } : {});
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
