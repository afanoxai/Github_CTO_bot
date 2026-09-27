# Deployment Guide — AgentOps on Vercel

This is the step-by-step procedure to deploy the bot to production on Vercel, pointed at the real `afanoxai` repo. It's derived from an actual end-to-end deployment we ran and debugged against a throwaway repo/bot before writing this — every step below has been proven to work.

## 1. Prerequisites

- A Vercel account (Hobby plan is fine) with this repo imported/connected.
- A Telegram bot token for **production** — you can reuse the existing bot from development, but note: a single bot token can only be in one receive mode (long-polling *or* webhook) at a time. If the same token is ever run locally with `npm run dev` while its webhook is registered, local polling will fail with a "Conflict" error. Using a separate bot for production avoids this entirely; it's not required, just simpler.
- A **fine-grained GitHub PAT** scoped to only the `afanoxai` repo, with **Issues: Read & write**, **Contents: Read & write**, and **Pull requests: Read & write** permissions, and a short expiry (see `CLAUDE.md` Section 6 for the security rationale).
- Your own DeepSeek API key.

## 2. Set environment variables in Vercel

In the Vercel project → **Settings → Environment Variables**, add all six variables from `.env.example`:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your production bot's token |
| `ALLOWED_TELEGRAM_USER_IDS` | Comma-separated Telegram user IDs allowed to use the bot |
| `DEEPSEEK_API_KEY` | Your DeepSeek API key |
| `GITHUB_PAT` | The fine-grained PAT scoped to `afanoxai` (step 1) |
| `GITHUB_REPO` | `<owner>/afanoxai` |
| `TELEGRAM_WEBHOOK_SECRET` | A new random secret, e.g. `openssl rand -hex 32` — don't reuse one from another environment |

## 3. Deploy

Trigger a deploy (push to the connected branch, or **Deployments → Redeploy** in the dashboard). No build-step configuration is needed — `vercel.json` in this repo already tells Vercel to skip the build command, since this project has no frontend, only the `/api/telegram` function. (Without that, Vercel's zero-config detection runs `package.json`'s `build` script — meant only for local dev — and then fails looking for a `public/` output directory that will never exist here.)

## 4. Find the production domain

Once deployed, use the **production domain** shown on the project's Vercel dashboard — it looks like `https://your-project.vercel.app`, without a long random string in the middle.

Don't use a per-deployment "preview" URL (the ones with a hash like `your-project-a1b2c3d4-team.vercel.app`) for the webhook — on Vercel's Hobby plan, Standard Deployment Protection blocks those by default and Telegram's requests would get a `401 Protected deployment` before ever reaching the bot's code. The production domain is public by default and doesn't need any protection setting changed.

## 5. Register the webhook

Run this once (replace the placeholders):

```
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" -H "Content-Type: application/json" -d "{\"url\": \"https://<your-production-domain>/api/telegram\", \"secret_token\": \"<TELEGRAM_WEBHOOK_SECRET>\"}"
```

A successful response looks like `{"ok":true,"result":true,"description":"Webhook was set"}`. Paste the whole command in as one piece — splitting it across multiple lines can get mangled by some terminals when pasted.

You only need to re-run this if the production domain changes or you rotate the webhook secret.

## 6. Test

Message the bot on Telegram from an allowed account. Try all three paths:
- A greeting ("hi") → should get a conversational reply, no GitHub action.
- A bug report → should create a GitHub issue in `afanoxai` and reply with a link.
- A file/code change request → should open a pull request in `afanoxai` and reply with a link. Nothing lands on the default branch without a human merging it.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Deploy fails: "No Output Directory named public found" | `vercel.json`'s build-skip config is missing or was removed | Confirm `vercel.json` exists in the repo with `"buildCommand": ""` |
| Webhook returns `401 Protected deployment` | Registered against a preview/generated URL, not the production domain | Re-register using the production domain (step 4–5) |
| Bot never replies, function crashes with `TelegramError: 404` on `getMe` | `TELEGRAM_BOT_TOKEN` in Vercel's env vars is wrong/mistyped | Double-check it against the real token, fix, redeploy (env var changes need a redeploy) |
| Bot never replies, no crash, nothing in logs | Sender's Telegram user ID isn't in `ALLOWED_TELEGRAM_USER_IDS` | This is by design (Layer 1's allow-list) — add the ID and redeploy |
| Local `npm run dev` fails with "Conflict: can't use getUpdates while webhook is active" | Same bot token is running local polling while its webhook is registered elsewhere | Expected — use a separate token for local dev, or `deleteWebhook` before running local dev |

## Rolling back to local development

To go back to testing locally with a token that has a webhook registered, delete the webhook first:

```
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"
```

Then `npm run dev` will work again for that token.
