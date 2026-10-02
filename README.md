# Sponsor Auction Backend

Live bidding engine for the **Sponsor My Body** page. One Node.js service does
everything: it **serves the public site** (static files from `./public/`) and
exposes the **bidding API** at `/api/*` — same origin, one public URL.

## How it works

- **5 spots**, seeded at starting prices: Left chest $150, Right chest $150,
  Belly $100, Left thigh $60, Right thigh $60.
- `POST /api/bid` validates a bid (must beat the current price by **≥ $10**),
  then mints a **one-time Whop checkout for the exact bid amount** via
  `checkoutConfigurations.create` with an inline `one_time` plan, and returns
  its `purchase_url`. The frontend sends the bidder straight there.
- `POST /api/webhooks/whop` receives Whop payment events (signature-verified).
  On `payment.succeeded` the bid becomes the spot's leader; the **previous
  leader is automatically fully refunded** via `payments.refund` — an outbid
  brand is never left charged. Late/duplicate/failed payments are handled
  (refunded or ignored, never double-counted).
- **Rounds end daily at 00:00 UTC.** When a round closes, each spot's top paid
  bidder is locked in as the round winner, all other paid bids are refunded,
  and a fresh round starts at starting prices. The frontend's `roundEndsAt`
  comes from here, so every visitor sees the same countdown.

## API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/spots` | `{ spots: [{ id, name, price, leader: { brandName, website, logoDataUrl } \| null, bidCount, roundEndsAt }] }` |
| `POST` | `/api/bid` | Body `{ spotId, amount, brandName, website, logoDataUrl }` → `{ checkoutUrl }`, or `400 { error }` with a human message |
| `POST` | `/api/webhooks/whop` | Whop webhook receiver (raw body, signature-verified) |
| `GET` | `/api/health` | `{ ok: true, roundEndsAt }` |

`spotId` values: `left-chest`, `right-chest`, `belly`, `left-thigh`, `right-thigh`.
The frontend calls these same-origin (`/api/*`) — no frontend env config needed.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in:
   - `WHOP_API_KEY` — Whop dashboard → **Developer → API keys** → create key.
   - `WHOP_ACCOUNT_ID` — your Whop company account ID (starts with `biz_`;
     visible in the Whop dashboard business settings). This is the account the
     one-time checkouts charge.
   - `WHOP_WEBHOOK_SECRET` — after registering the webhook below, reveal the
     signing secret (starts with `ws_`).
   - `BASE_URL` — the public https URL of this deployment (no trailing slash).
3. `npm start` (defaults to port 3000; respects `PORT`).

## Registering the webhook in Whop

1. Whop dashboard → **Developer → Webhooks** → Add endpoint.
2. URL: `POST {BASE_URL}/api/webhooks/whop`
   (the server prints this exact URL at boot once `BASE_URL` is set).
3. Enable events: **`payment.succeeded`** and **`payment.failed`**.
4. Copy the endpoint's signing secret into `WHOP_WEBHOOK_SECRET` and restart.
5. Use the dashboard's "send test event" to confirm a 200.

Without `WHOP_WEBHOOK_SECRET` the server logs a loud warning and accepts
events unverified — fine for local dev, **never ship that way**.

## Deploying on Railway

1. Push this folder to a Git repo (or use the Railway CLI).
2. Railway → **New Project → Deploy from repo**, select the repo.
   (If the repo root isn't this folder, set the service's root directory to it.)
3. **Variables** tab → add `WHOP_API_KEY`, `WHOP_ACCOUNT_ID`,
   `WHOP_WEBHOOK_SECRET`, and `BASE_URL` (use the public domain Railway gives
   you, e.g. `https://sponsor-auction.up.railway.app`). `PORT` is set by
   Railway automatically.
4. Deploy. The same URL serves the page **and** the API.
5. Register the webhook URL in Whop (see above) using that public domain.
6. Drop the built frontend files into `./public/` (the page builder does this)
   and redeploy — the server picks them up with no code changes.

Local dev note: Whop rejects `localhost` webhook URLs — use
[ngrok](https://ngrok.com) or Cloudflare Tunnel for a public URL and register
that as `BASE_URL` while testing.

## Data

- SQLite file `db.sqlite` (WAL mode) lives next to `server.js` — bids, rounds,
  spots. Zero config; survives restarts on persistent volumes.
- ⚠️ On Railway, the filesystem is **ephemeral** unless you attach a volume:
  add a **Volume** mounted at the app directory (or set the DB path) or bid
  history resets on each redeploy. For launch scale this is fine; attach a
  volume before going live.

## Known limitations

- **Single-instance SQLite.** Bid validation + insert runs inside a
  better-sqlite3 transaction, which is atomic *within one process*. Two
  near-simultaneous bids on one server are serialized correctly, but if you
  ever scale to multiple instances/containers, move to Postgres and use a
  row-level lock (`SELECT … FOR UPDATE`) around the price check. For launch
  traffic, SQLite is plenty.
- **Refunds are best-effort with loud logging.** If a Whop refund API call
  fails (network, dashboard state), the bid is flagged `refund_failed` and the
  error is logged — refund it manually in the Whop dashboard. Money paths never
  fail silently here.
- **No auth on `/api/bid`.** Anyone can place bids — that's the point of a
  public auction — but consider rate-limiting (e.g. `express-rate-limit`) if
  you get spammed.
- Webhook handler returns `200` for all verified events (even ones it can't
  match to a bid) so Whop doesn't retry poison messages forever; unmatched
  events are logged.
