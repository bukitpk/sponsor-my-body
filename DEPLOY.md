# Sponsor My Body — Deploy Package

Everything needed to run the live auction site. One service: the Node backend
serves the landing page AND the auction API from a single URL.

## What's inside
- `server.js` — auction backend (Express + SQLite + Whop). Bids, one-time Whop
  checkouts per bid amount, webhooks, automatic outbid refunds, daily 00:00 UTC rounds.
- `public/` — the landing page (index.html + assets). Served by server.js.
- `package.json` / `package-lock.json` — dependencies. `npm start` runs it.
- `.env.example` — copy to `.env` and fill in.
- `README.md` — full technical docs.

## Deploy (Railway)
1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub → pick the repo.
3. Variables → add:
   - WHOP_API_KEY — from Whop dashboard → API keys
   - WHOP_ACCOUNT_ID — your Whop company id (biz_...)
   - WHOP_WEBHOOK_SECRET — from Whop dashboard → Webhooks (ws_...)
   - BASE_URL — your Railway public URL, e.g. https://xxx.up.railway.app
4. In Whop dashboard → Webhooks, add: {BASE_URL}/api/webhooks/whop
   Events: payment.succeeded, payment.failed
5. Open your Railway URL — the site is live.
