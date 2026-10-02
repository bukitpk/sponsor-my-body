/**
 * Sponsor My Body — auction backend
 * =================================
 * Express + SQLite server that powers live bidding on sponsor spots.
 *
 *  - Serves the public site itself from ./public/ (same-origin, no CORS needed)
 *  - API under /api/*:
 *      GET  /api/spots            -> current spots, prices, leaders, views, roundEndsAt
 *      POST /api/bid              -> validate bid, mint a one-time Whop checkout, return its URL
 *      POST /api/spots/:id/view   -> record a popup view, return { views }
 *      POST /api/webhooks/whop    -> Whop payment webhook (payment.succeeded / payment.failed)
 *      GET  /api/health           -> liveness check
 *  - Rounds end daily at 00:00 UTC. On rollover, each spot's top paid bidder is
 *    locked in as the round winner; every other paid bid is refunded; a fresh
 *    round starts at starting prices.
 *  - Outbids: when a higher bid is PAID, the previous leader is automatically
 *    fully refunded via the Whop API. An outbid brand is never left charged.
 *
 * Env (see .env.example):
 *  WHOP_API_KEY, WHOP_ACCOUNT_ID (biz_...), WHOP_WEBHOOK_SECRET (ws_...),
 *  BASE_URL (public https URL), PORT (default 3000)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------- config

const PORT = parseInt(process.env.PORT || '3000', 10);
const WHOP_API_KEY = process.env.WHOP_API_KEY || '';
const WHOP_ACCOUNT_ID = process.env.WHOP_ACCOUNT_ID || ''; // biz_... company account that receives the charges
const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET || ''; // ws_... from Whop dashboard -> Webhooks
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');

const MIN_INCREMENT = 10; // bids must beat the current price by at least $10
const MAX_AMOUNT = 1_000_000;
const LOGO_MAX_CHARS = 2_000_000; // ~1.5MB base64 image cap

// Starting prices. IDs are part of the public API contract — do not change.
const SPOTS_SEED = [
  { id: 'left-chest',  name: 'Left chest',  starting_price: 70 },
  { id: 'right-chest', name: 'Right chest', starting_price: 70 },
  { id: 'belly',       name: 'Belly',       starting_price: 100 },
  { id: 'left-thigh',  name: 'Left thigh',  starting_price: 40 },
  { id: 'right-thigh', name: 'Right thigh', starting_price: 40 },
];

// ---------------------------------------------------------------- whop client (lazy)

let _whop = null;
function whop() {
  if (!_whop) {
    if (!WHOP_API_KEY) throw new Error('WHOP_API_KEY is not configured');
    const { WhopClient } = require('@whop/sdk');
    _whop = new WhopClient({ token: WHOP_API_KEY });
  }
  return _whop;
}

// ---------------------------------------------------------------- database

const db = new Database(path.join(__dirname, 'db.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS spots (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    starting_price REAL NOT NULL,
    views          INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rounds (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ends_at   TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bids (
    id                 TEXT PRIMARY KEY,
    spot_id            TEXT NOT NULL REFERENCES spots(id),
    round_id           INTEGER NOT NULL REFERENCES rounds(id),
    amount             REAL NOT NULL,
    brand_name         TEXT NOT NULL,
    website            TEXT NOT NULL,
    logo_data_url      TEXT,
    status             TEXT NOT NULL DEFAULT 'pending',
    checkout_config_id TEXT,
    payment_id         TEXT,
    created_at         TEXT NOT NULL,
    paid_at            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bids_spot_round ON bids (spot_id, round_id, status);
`);

// Lightweight migration: per-spot view counter for the popup header
// (for databases created before the views column existed).
try {
  db.prepare('ALTER TABLE spots ADD COLUMN views INTEGER NOT NULL DEFAULT 0').run();
} catch (e) { /* column already exists */ }

{
  const seed = db.prepare('INSERT OR IGNORE INTO spots (id, name, starting_price) VALUES (?, ?, ?)');
  const tx = db.transaction(() => { for (const s of SPOTS_SEED) seed.run(s.id, s.name, s.starting_price); });
  tx();
}

// ---------------------------------------------------------------- rounds

/** Next 00:00 UTC as a Date. */
function nextMidnightUTC(from = new Date()) {
  const d = new Date(from);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

/**
 * Close a finished round: lock in each spot's top paid bidder as the round
 * winner; refund every other paid bid; expire unpaid pending bids.
 * Refunds are best-effort and logged — a failed refund is flagged for manual
 * handling rather than silently dropped.
 */
async function closeRound(round) {
  console.log(`[round] closing round ${round.id} (ended ${round.ends_at})`);
  const spots = db.prepare('SELECT * FROM spots').all();

  const markTx = db.transaction((updates) => {
    const stmt = db.prepare('UPDATE bids SET status = ? WHERE id = ?');
    for (const [id, status] of updates) stmt.run(status, id);
  });

  const refunds = []; // { paymentId, bidId }
  const statusUpdates = [];

  for (const spot of spots) {
    const paid = db.prepare(
      `SELECT * FROM bids WHERE spot_id = ? AND round_id = ? AND status = 'paid'
       ORDER BY amount DESC, paid_at ASC`
    ).all(spot.id, round.id);
    paid.forEach((b, i) => {
      if (i === 0) statusUpdates.push([b.id, 'won_round']);
      else { statusUpdates.push([b.id, 'refunded']); refunds.push({ paymentId: b.payment_id, bidId: b.id }); }
    });
    const pending = db.prepare(
      `SELECT id FROM bids WHERE spot_id = ? AND round_id = ? AND status = 'pending'`
    ).all(spot.id, round.id);
    for (const p of pending) statusUpdates.push([p.id, 'expired']);
  }

  markTx(statusUpdates);
  db.prepare('UPDATE rounds SET closed_at = ? WHERE id = ?').run(new Date().toISOString(), round.id);

  for (const r of refunds) {
    try {
      await whop().payments.refund({ id: r.paymentId });
      console.log(`[round] refunded non-winning bid ${r.bidId} (${r.paymentId})`);
    } catch (err) {
      console.error(`[round] REFUND FAILED for bid ${r.bidId} (${r.paymentId}): ${err.message} — refund manually in Whop dashboard`);
    }
  }
  console.log(`[round] round ${round.id} closed`);
}

/** Return the open round, rolling over to a fresh one if the old one ended. */
async function ensureOpenRound() {
  let round = db.prepare('SELECT * FROM rounds WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get();
  const now = new Date();
  if (!round) {
    const ends = nextMidnightUTC(now).toISOString();
    const info = db.prepare('INSERT INTO rounds (ends_at) VALUES (?)').run(ends);
    round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(info.lastInsertRowid);
    console.log(`[round] started round ${round.id}, ends ${round.ends_at}`);
  } else if (new Date(round.ends_at) <= now) {
    await closeRound(round);
    const ends = nextMidnightUTC(now).toISOString();
    const info = db.prepare('INSERT INTO rounds (ends_at) VALUES (?)').run(ends);
    round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(info.lastInsertRowid);
    console.log(`[round] started round ${round.id}, ends ${round.ends_at}`);
  }
  return round;
}

/** Current top paid bid for a spot in a round (the leader), or undefined. */
function currentLeader(spotId, roundId) {
  return db.prepare(
    `SELECT * FROM bids WHERE spot_id = ? AND round_id = ? AND status = 'paid'
     ORDER BY amount DESC, paid_at ASC LIMIT 1`
  ).get(spotId, roundId);
}

// ---------------------------------------------------------------- app

const app = express();

/**
 * Whop webhook receiver. Registered BEFORE express.json() because signature
 * verification needs the RAW request body bytes.
 *
 * Verification follows Whop's documented scheme ("Verify without an SDK"):
 *   signed = "{webhook-id}.{webhook-timestamp}.{raw body}"
 *   HMAC-SHA256 with the ws_... webhook secret as the key, base64-encoded,
 *   compared (constant-time) against the "v1,<sig>" entries in the
 *   webhook-signature header. Timestamps older than 5 minutes are rejected.
 * Doc: https://github.com/distilled-mirror/spec-mirror-whop -> developer/guides/webhooks.md
 */
app.post('/api/webhooks/whop', express.raw({ type: 'application/json' }), async (req, res) => {
  const raw = req.body; // Buffer
  if (!verifyWhopWebhook(raw, req.headers)) {
    console.warn('[webhook] invalid signature — rejected');
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }

  const { type, data } = event || {};
  console.log(`[webhook] received event: ${type}`);
  try {
    if (type === 'payment.succeeded') await handlePaymentSucceeded(data);
    else if (type === 'payment.failed') handlePaymentFailed(data);
    else console.log(`[webhook] ignoring event type: ${type}`);
  } catch (err) {
    // Always 200 for verified events so Whop doesn't retry a poison message
    // forever; the failure is logged for manual follow-up.
    console.error(`[webhook] handler error for ${type}:`, err.message);
  }
  res.json({ ok: true });
});

app.use(express.json({ limit: '8mb' })); // logo uploads ride along as data URLs

// ---------------------------------------------------------------- helpers

function verifyWhopWebhook(rawBody, headers) {
  if (!WHOP_WEBHOOK_SECRET) {
    console.warn('[webhook] WHOP_WEBHOOK_SECRET not set — accepting unverified (dev only, do not ship like this)');
    return true;
  }
  const id = headers['webhook-id'] || headers['svix-id'];
  const ts = headers['webhook-timestamp'] || headers['svix-timestamp'];
  const sigHeader = headers['webhook-signature'] || headers['svix-signature'];
  if (!id || !ts || !sigHeader) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parseInt(ts, 10)) > 5 * 60) return false; // replay protection

  const signed = `${id}.${ts}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', WHOP_WEBHOOK_SECRET).update(signed).digest('base64');

  return String(sigHeader).split(' ').some((entry) => {
    const sig = entry.startsWith('v1,') ? entry.slice(3) : entry;
    if (sig.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  });
}

function handlePaymentFailed(payment) {
  const bidId = payment && payment.metadata && payment.metadata.bidId;
  if (!bidId) { console.log('[webhook] payment.failed without bidId metadata — ignored'); return; }
  const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(bidId);
  if (bid && bid.status === 'pending') {
    db.prepare("UPDATE bids SET status = 'failed' WHERE id = ?").run(bidId);
    console.log(`[webhook] bid ${bidId} marked failed`);
  }
}

/**
 * A bid was paid. Highest paid amount wins the spot; everyone else paid gets
 * refunded automatically. Late payments (round already closed, or a higher bid
 * already paid) are refunded immediately.
 */
async function handlePaymentSucceeded(payment) {
  const bidId = payment && payment.metadata && payment.metadata.bidId;
  const paymentId = payment && payment.id;
  if (!bidId || !paymentId) { console.log('[webhook] payment.succeeded without bidId/payment id — ignored'); return; }

  const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(bidId);
  if (!bid) { console.log(`[webhook] unknown bid ${bidId} — ignored`); return; }
  if (bid.status === 'paid') { console.log(`[webhook] duplicate delivery for bid ${bidId} — ignored`); return; }
  if (bid.status !== 'pending') { console.log(`[webhook] bid ${bidId} already ${bid.status} — ignored`); return; }

  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(bid.round_id);
  if (!round || round.closed_at) {
    // Paid after the round closed: refund right away, it can't win.
    await refundOrFlag(paymentId, bidId, 'paid into closed round');
    db.prepare("UPDATE bids SET status = 'expired', payment_id = ? WHERE id = ?").run(paymentId, bidId);
    return;
  }

  const leader = currentLeader(bid.spot_id, bid.round_id);
  if (leader && leader.amount >= bid.amount) {
    // Someone already paid more (or equal, earlier). Refund this late payment.
    await refundOrFlag(paymentId, bidId, 'outbid before payment completed');
    db.prepare("UPDATE bids SET status = 'refunded', payment_id = ?, paid_at = ? WHERE id = ?")
      .run(paymentId, new Date().toISOString(), bidId);
    console.log(`[webhook] bid ${bidId} ($${bid.amount}) lost to existing leader ($${leader.amount}) — refunded`);
    return;
  }

  // This bid is the new leader.
  db.prepare("UPDATE bids SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ?")
    .run(paymentId, new Date().toISOString(), bidId);
  console.log(`[webhook] bid ${bidId} paid ($${bid.amount}) — new leader for ${bid.spot_id}`);

  // Refund the previous leader, if any. An outbid brand must never stay charged.
  if (leader) {
    await refundOrFlag(leader.payment_id, leader.id, 'outbid');
    db.prepare("UPDATE bids SET status = 'refunded' WHERE id = ?").run(leader.id);
  }
}

async function refundOrFlag(paymentId, bidId, reason) {
  try {
    await whop().payments.refund({ id: paymentId });
    console.log(`[refund] bid ${bidId} (${paymentId}) refunded — ${reason}`);
  } catch (err) {
    // Flag loudly: money is involved, never fail silently.
    db.prepare("UPDATE bids SET status = 'refund_failed' WHERE id = ?").run(bidId);
    console.error(`[refund] FAILED for bid ${bidId} (${paymentId}) — ${reason}. Refund MANUALLY in Whop dashboard. Error: ${err.message}`);
  }
}

// ---------------------------------------------------------------- api routes

app.get('/api/health', async (req, res) => {
  const round = await ensureOpenRound();
  res.json({ ok: true, roundEndsAt: round.ends_at });
});

app.get('/api/spots', async (req, res) => {
  const round = await ensureOpenRound();
  const spots = db.prepare('SELECT * FROM spots ORDER BY starting_price DESC, id ASC').all();
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM bids
     WHERE spot_id = ? AND round_id = ? AND status IN ('paid', 'refunded', 'won_round')`
  );
  res.json({
    spots: spots.map((s) => {
      const leader = currentLeader(s.id, round.id);
      return {
        id: s.id,
        name: s.name,
        price: leader ? leader.amount : s.starting_price,
        leader: leader
          ? { brandName: leader.brand_name, website: leader.website, logoDataUrl: leader.logo_data_url }
          : null,
        bidCount: countStmt.get(s.id, round.id).c,
        views: s.views || 0,
        roundEndsAt: round.ends_at,
      };
    }),
  });
});

/**
 * Record a view of a spot's popup (fire-and-forget from the page).
 * Returns the new total so the header can show "Spot name (X views)".
 */
app.post('/api/spots/:id/view', (req, res) => {
  const spot = db.prepare('SELECT id FROM spots WHERE id = ?').get(req.params.id);
  if (!spot) return res.status(404).json({ error: 'Unknown spot.' });
  db.prepare('UPDATE spots SET views = views + 1 WHERE id = ?').run(req.params.id);
  const row = db.prepare('SELECT views FROM spots WHERE id = ?').get(req.params.id);
  res.json({ views: row.views });
});

/**
 * Live presence: the page pings every 30s with a random visitor id stored in
 * localStorage; anyone seen in the last 75s counts as online. In-memory on
 * purpose — "live" data is ephemeral by nature (a restart just rebuilds it).
 */
const presence = new Map();
const PRESENCE_TTL_MS = 75000;
app.post('/api/presence', (req, res) => {
  const vid = String((req.body && req.body.vid) || '').slice(0, 64);
  const now = Date.now();
  if (vid) presence.set(vid, now);
  for (const [id, ts] of presence) if (now - ts > PRESENCE_TTL_MS) presence.delete(id);
  if (presence.size > 20000) presence.clear();
  res.json({ online: presence.size });
});

/**
 * Validate a bid's fields. Returns a human-readable error string, or null if OK.
 * Amount rules: positive number, max 2 decimals.
 * First bid on a spot: at least the starting price (as shown).
 * Outbids: at least current price + MIN_INCREMENT.
 */
function validateBidInput({ spotId, amount, brandName, website, logoDataUrl }, currentPrice, hasLeader) {
  const spot = SPOTS_SEED.find((s) => s.id === spotId);
  if (!spot) return 'Unknown spot. Please pick a valid placement.';
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 'Bid amount must be a number.';
  if (amount <= 0) return 'Bid amount must be greater than $0.';
  if (amount > MAX_AMOUNT) return `Bid amount looks too large (max $${MAX_AMOUNT.toLocaleString()}).`;
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return 'Bid amount can have at most 2 decimals.';
  const minimum = hasLeader ? currentPrice + MIN_INCREMENT : currentPrice;
  if (amount < minimum) {
    return hasLeader
      ? `Bid must be at least $${minimum} (current $${currentPrice} + $${MIN_INCREMENT} minimum increment).`
      : `Bid must be at least $${minimum} (the starting price).`;
  }
  if (typeof brandName !== 'string' || !brandName.trim()) return 'Brand name is required.';
  if (brandName.trim().length > 80) return 'Brand name is too long (max 80 characters).';
  if (typeof website !== 'string' || !website.trim()) return 'Website is required.';
  if (website.trim().length > 200) return 'Website is too long.';
  if (logoDataUrl != null && typeof logoDataUrl !== 'string') return 'Logo must be a data URL string.';
  if (typeof logoDataUrl === 'string' && logoDataUrl.length > LOGO_MAX_CHARS) {
    return 'Logo image is too large — please use a smaller file.';
  }
  return null;
}

app.post('/api/bid', async (req, res) => {
  try {
    const round = await ensureOpenRound();
    const { spotId, amount, brandName, website, logoDataUrl } = req.body || {};

    const spot = db.prepare('SELECT * FROM spots WHERE id = ?').get(spotId);
    if (!spot) return res.status(400).json({ error: 'Unknown spot. Please pick a valid placement.' });

    const leader = currentLeader(spotId, round.id);
    const currentPrice = leader ? leader.amount : spot.starting_price;

    const err = validateBidInput({ spotId, amount, brandName, website, logoDataUrl }, currentPrice, !!leader);
    if (err) return res.status(400).json({ error: err });

    if (!WHOP_API_KEY || !WHOP_ACCOUNT_ID) {
      console.error('[bid] WHOP_API_KEY / WHOP_ACCOUNT_ID not configured');
      return res.status(500).json({ error: 'Payments are not configured yet. Please try again later.' });
    }

    // Insert the pending bid. better-sqlite3 runs each statement synchronously and
    // serializes them, so the read-price + insert pair below is atomic within this
    // single process (see README "known limitations" for multi-instance notes).
    const bidId = randomUUID();
    const createdAt = new Date().toISOString();
    const insertTx = db.transaction(() => {
      const liveLeader = currentLeader(spotId, round.id);
      const livePrice = liveLeader ? liveLeader.amount : spot.starting_price;
      const liveMinimum = liveLeader ? livePrice + MIN_INCREMENT : livePrice;
      if (amount < liveMinimum) {
        throw Object.assign(new Error(
          liveLeader
            ? `Someone just bid — the minimum is now $${livePrice + MIN_INCREMENT}.`
            : `Someone just bid — the minimum is now $${livePrice}.`
        ), { statusCode: 400 });
      }
      db.prepare(
        `INSERT INTO bids (id, spot_id, round_id, amount, brand_name, website, logo_data_url, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(bidId, spotId, round.id, amount, brandName.trim(), website.trim(), logoDataUrl || null, createdAt);
    });

    try {
      insertTx();
    } catch (e) {
      return res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Could not place bid.' });
    }

    // Mint a ONE-TIME Whop checkout for the EXACT bid amount.
    // Verified pattern from Whop docs (developer guide "example-integration"):
    // POST /api/v1/checkout_configurations with an inline one_time plan.
    // Response carries purchase_url — the URL the bidder is sent to.
    let checkout;
    try {
      checkout = await whop().checkoutConfigurations.create({
        account_id: WHOP_ACCOUNT_ID,
        plan: {
          plan_type: 'one_time',
          currency: 'usd',
          initial_price: amount,
          release_method: 'buy_now',
          visibility: 'visible',
          title: `Sponsor bid — ${spot.name} ($${amount})`,
        },
        metadata: { bidId, spotId, roundId: round.id, type: 'sponsor_bid' },
        redirect_url: BASE_URL || undefined,
      });
    } catch (e) {
      db.prepare("UPDATE bids SET status = 'failed' WHERE id = ?").run(bidId);
      console.error(`[bid] Whop checkout creation failed for bid ${bidId}: ${e.message}`);
      return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
    }

    if (!checkout || !checkout.purchase_url) {
      db.prepare("UPDATE bids SET status = 'failed' WHERE id = ?").run(bidId);
      console.error(`[bid] Whop returned no purchase_url for bid ${bidId}`);
      return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
    }

    db.prepare('UPDATE bids SET checkout_config_id = ? WHERE id = ?').run(checkout.id || null, bidId);
    console.log(`[bid] ${bidId}: ${brandName.trim()} bid $${amount} on ${spotId} -> ${checkout.id}`);
    return res.json({ checkoutUrl: checkout.purchase_url });
  } catch (e) {
    console.error('[bid] unexpected error:', e.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Unknown /api/* routes -> JSON 404 (must come after real API routes, before static).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------------------------------------------------------------- static frontend (same-origin)

const publicDir = path.join(__dirname, 'public');
{
  const missing = !fs.existsSync(publicDir);
  const empty = !missing && fs.readdirSync(publicDir).length === 0;
  if (missing || empty) {
    console.warn('[static] ./public is missing or empty — API still running. The page builder will place the built frontend in ./public/');
  } else {
    console.log(`[static] serving frontend from ${publicDir}`);
  }
}
app.use(express.static(publicDir));

// SPA fallback: unknown non-/api routes serve the frontend (or a plain 404 if absent).
app.get(/^(?!\/api).*/, (req, res) => {
  const index = path.join(publicDir, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send('Not found. API is running — place the built frontend in ./public/ to serve the site.');
});

// ---------------------------------------------------------------- boot

ensureOpenRound()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[boot] auction backend listening on :${PORT}`);
      if (BASE_URL) console.log(`[boot] public URL: ${BASE_URL} — register webhook: POST ${BASE_URL}/api/webhooks/whop`);
      if (!WHOP_API_KEY) console.warn('[boot] WHOP_API_KEY not set — /api/bid will fail until configured');
      if (!WHOP_ACCOUNT_ID) console.warn('[boot] WHOP_ACCOUNT_ID not set — /api/bid will fail until configured');
      if (!WHOP_WEBHOOK_SECRET) console.warn('[boot] WHOP_WEBHOOK_SECRET not set — webhook signatures will NOT be verified');
    });
  })
  .catch((err) => {
    console.error('[boot] failed to start:', err.message);
    process.exit(1);
  });
