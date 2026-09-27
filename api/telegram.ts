import { waitUntil } from "@vercel/functions";
import { bot } from "../src/bot.js";

const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!webhookSecret) {
  throw new Error("TELEGRAM_WEBHOOK_SECRET is not set. Add it to your Vercel project's environment variables.");
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
    if (secretHeader !== webhookSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const update = await request.json();

    // Ack Telegram immediately instead of waiting for the full pipeline to finish. Telegram's
    // own webhook patience is much shorter than our internal processing budget, so awaiting the
    // whole thing here meant slow updates (milestone builds) got retried mid-flight, causing two
    // overlapping invocations to race on the same work (and burn LLM/API calls twice). waitUntil
    // keeps this invocation alive to actually finish the work in the background, after the
    // response below has already been sent - Telegraf's own replies (ctx.reply/editMessageText)
    // are separate outbound calls to Telegram's Bot API, unrelated to this response, so they
    // still arrive normally once the background work completes.
    waitUntil(
      bot.handleUpdate(update).catch((err) => {
        console.error("Background update handling failed:", err);
      })
    );

    return new Response("OK", { status: 200 });
  },
};
