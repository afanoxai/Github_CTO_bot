// Local entry (long-polling) - wiring only, no logic. Uses the v3 agent-backed Telegram bot.
import { bot } from "./telegram/bot.js";

bot.launch();
console.log("Bot is running (long-polling). Press Ctrl+C to stop.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
