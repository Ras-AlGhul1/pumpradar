// ─── PumpRadar Proxy Routes ───────────────────────────────────────────────────
// Add this file to your Verifi backend and require/import it in your main server.
// These routes proxy all Helius and Jupiter calls server-side, bypassing CORS.
//
// Usage in your main server file:
//   const pumpradar = require('./pumpradar-proxy');
//   app.use('/api/pumpradar', pumpradar);
//
// Set HELIUS_API_KEY in your Render environment variables.

const express = require('express');
const router  = express.Router();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC     = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_API     = `https://api.helius.xyz/v0`;

if (!HELIUS_API_KEY) {
  console.warn('[PumpRadar] WARNING: HELIUS_API_KEY env var not set. Proxy routes will fail.');
}

// Helper: forward a JSON POST to an upstream URL
async function proxyPost(upstreamUrl, body, res) {
  try {
    const upstream = await fetch(upstreamUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream ${upstream.status}`, detail: data });
    }
    res.json(data);
  } catch (err) {
    console.error('[PumpRadar proxy]', err.message);
    res.status(502).json({ error: 'Proxy fetch failed', detail: err.message });
  }
}

// POST /api/pumpradar/rpc
// Proxies Helius JSON-RPC calls (getSignaturesForAddress etc.)
router.post('/rpc', async (req, res) => {
  await proxyPost(HELIUS_RPC, req.body, res);
});

// POST /api/pumpradar/transactions
// Proxies Helius Enhanced Transaction parsing
router.post('/transactions', async (req, res) => {
  await proxyPost(`${HELIUS_API}/transactions/?api-key=${HELIUS_API_KEY}`, req.body, res);
});

// POST /api/pumpradar/metadata
// Proxies Helius token metadata
router.post('/metadata', async (req, res) => {
  await proxyPost(`${HELIUS_API}/token-metadata?api-key=${HELIUS_API_KEY}`, req.body, res);
});

// GET /api/pumpradar/price?ids=mint1,mint2,...
// Proxies Jupiter price API
router.get('/price', async (req, res) => {
  const ids = req.query.ids;
  if (!ids) return res.status(400).json({ error: 'ids query param required' });
  try {
    const upstream = await fetch(`https://price.jup.ag/v6/price?ids=${ids}`);
    const data     = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error('[PumpRadar price proxy]', err.message);
    res.status(502).json({ error: 'Jupiter price fetch failed', detail: err.message });
  }
});

module.exports = router;
