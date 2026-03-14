import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// All Helius calls go through your backend proxy to avoid CORS.
// Set this to your Render service URL in production, or "" for same-origin dev.
const PROXY_BASE    = "";  // e.g. "https://your-verifi-app.onrender.com"
const PROXY_RPC     = `${PROXY_BASE}/api/pumpradar/rpc`;
const PROXY_TX      = `${PROXY_BASE}/api/pumpradar/transactions`;
const PROXY_META    = `${PROXY_BASE}/api/pumpradar/metadata`;
const PROXY_PRICE   = `${PROXY_BASE}/api/pumpradar/price`;

const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzoperd53oBV7GkS3CJFeMxhj3E5b",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

// ─── PROFITABILITY HARD FILTERS (clean tab — fresh launches) ─────────────────
const CLEAN_FILTERS = {
  MAX_BUNDLE_SCORE:    0.55,
  MAX_INSIDERS:        6,
  MAX_TOP_HOLDER_CONC: 0.55,
  MAX_AGE_MINUTES:     45,
  MIN_UNIQUE_BUYERS:   2,
  MIN_OPP_SCORE:       35,
  MIN_MCAP_USD:        15_000,   // $15K minimum
  MAX_MCAP_USD:        300_000,  // $300K maximum
};

// ─── GEMS TAB FILTERS (older coins, $50K–$1M MC, stricter safety) ─────────────
const GEMS_FILTERS = {
  MAX_BUNDLE_SCORE:    0.40,  // stricter
  MAX_INSIDERS:        4,     // stricter
  MAX_TOP_HOLDER_CONC: 0.55,
  MAX_AGE_MINUTES:     1440,  // up to 24 hours
  MIN_UNIQUE_BUYERS:   3,
  MIN_OPP_SCORE:       35,
  MIN_MCAP_USD:        50_000,    // $50K minimum
  MAX_MCAP_USD:        1_000_000, // $1M maximum
};

// ─── FRONTRUN TAB FILTERS ─────────────────────────────────────────────────────
// Catches coins where bundle is confirmed but price hasn't pumped yet
const FRONTRUN_FILTERS = {
  MIN_BUNDLE_SCORE:  0.40,
  MAX_AGE_MINUTES:   30,
  MAX_PRICE_CHANGE:  40,
  MIN_UNIQUE_BUYERS: 2,
};

// ─── NARRATIVES ───────────────────────────────────────────────────────────────
const NARRATIVES = [
  { tag: "AI",     keywords: ["ai","gpt","agent","neural","bot","llm","openai","claude","artificial","agi","mind","brain"] },
  { tag: "MEME",   keywords: ["pepe","doge","cat","dog","frog","ape","moon","based","wojak","chad","bonk","popcat","shib"] },
  { tag: "TRUMP",  keywords: ["trump","maga","america","usa","patriot","gop","melania"] },
  { tag: "DEPIN",  keywords: ["depin","network","node","infra","mesh","relay","compute","gpu","bandwidth"] },
  { tag: "GAMING", keywords: ["game","play","nft","pixel","quest","rpg","arena","guild","loot"] },
  { tag: "RWA",    keywords: ["rwa","real","estate","gold","asset","commodity","tokenized","property"] },
];

function detectNarrative(name = "", symbol = "") {
  const text = `${name} ${symbol}`.toLowerCase();
  for (const n of NARRATIVES) {
    if (n.keywords.some(k => text.includes(k))) return n.tag;
  }
  return null;
}

// ─── SLOT CLUSTER SCORE ───────────────────────────────────────────────────────
function computeSlotClusterScore(txSlots = []) {
  if (!txSlots.length) return 0;
  const counts = {};
  for (const s of txSlots) counts[s] = (counts[s] || 0) + 1;
  const maxInSlot = Math.max(...Object.values(counts));
  return Math.min(1, (maxInSlot / txSlots.length) * 1.6);
}

// ─── NORMALIZED BUNDLE SCORE ──────────────────────────────────────────────────
function computeBundleScore(txCount, uniqueBuyerCount, slotClusterScore) {
  if (uniqueBuyerCount === 0) return 1;
  const ratio      = txCount / uniqueBuyerCount;
  const rawRatio   = Math.min(1, Math.max(0, (ratio - 1) / 4));
  const buyerScale = Math.max(0.2, 1 - Math.log10(Math.max(1, uniqueBuyerCount)) / 3);
  return Math.min(1, (rawRatio * buyerScale) * 0.6 + slotClusterScore * 0.4);
}

// ─── RISK SCORE ───────────────────────────────────────────────────────────────
function computeRisk(token) {
  let s = 0;
  if (token.insiderCount > 5)                    s += 35;
  else if (token.insiderCount > 3)               s += 22;
  else if (token.insiderCount > 1)               s += 12;
  if (token.bundleScore > 0.65)                  s += 35;
  else if (token.bundleScore > 0.4)              s += 20;
  else if (token.bundleScore > 0.2)              s += 10;
  if (token.topHolderConc > 0.6)                 s += 20;
  else if (token.topHolderConc > 0.4)            s += 12;
  else if (token.topHolderConc > 0.25)           s += 5;
  if (token.ageMinutes < 3)                      s += 8;
  else if (token.ageMinutes < 10)                s += 4;
  if (token.jitoDetected)                        s += 40;
  if ((token.slotClusterScore || 0) > 0.7)       s += 15;
  else if ((token.slotClusterScore || 0) > 0.4)  s += 8;
  return Math.min(s, 100);
}

// ─── OPPORTUNITY SCORE ────────────────────────────────────────────────────────
// Weights sum to exactly 1.0: safety 0.50 + fresh 0.30 + demand 0.20
function opportunityScore(token) {
  const risk        = computeRisk(token);
  const safetyPct   = (100 - risk) / 100;
  const freshPct    = Math.max(0, 1 - (token.ageMinutes || 30) / 30);
  const demandPct   = Math.min(1, (token.uniqueBuyers || 0) / 20);
  const raw = safetyPct * 0.50 + freshPct * 0.30 + demandPct * 0.20;
  return Math.min(100, Math.round(raw * 100));
}

// ─── FILTER FUNCTIONS ─────────────────────────────────────────────────────────
const PUMP_SUPPLY = 1_000_000_000;

// Pump.fun bonding curve: estimate price from SOL volume and token volume
// Real virtual reserves: 30 SOL initial, 1.073B tokens initial
const PUMP_VIRTUAL_SOL   = 30;
const PUMP_VIRTUAL_TOKENS = 1_073_000_000;
const SOL_PRICE_USD = 150; // approximate

function estimatePriceFromVolume(totalVolume, totalSolVolume) {
  if (!totalVolume || totalVolume <= 0) return null;
  // Use virtual AMM formula: price = (virtual_sol + sol_in) / (virtual_tokens - tokens_out)
  const solIn     = totalSolVolume || 0;
  const tokensOut = totalVolume;
  const price = ((PUMP_VIRTUAL_SOL + solIn) * SOL_PRICE_USD) /
                ((PUMP_VIRTUAL_TOKENS - tokensOut) * SOL_PRICE_USD / SOL_PRICE_USD);
  return price > 0 ? price : null;
}

function getMcap(token) {
  // Prefer Jupiter price, fall back to bonding curve estimate
  const price = token.jupPrice ?? token.estimatedPrice ?? null;
  return price != null ? price * PUMP_SUPPLY : null;
}

function passesClean(token) {
  if (token.bundleScore      >  CLEAN_FILTERS.MAX_BUNDLE_SCORE)    return false;
  if (token.insiderCount     >  CLEAN_FILTERS.MAX_INSIDERS)        return false;
  if (token.topHolderConc    >  CLEAN_FILTERS.MAX_TOP_HOLDER_CONC) return false;
  if (token.ageMinutes       >  CLEAN_FILTERS.MAX_AGE_MINUTES)     return false;
  if (token.uniqueBuyers     <  CLEAN_FILTERS.MIN_UNIQUE_BUYERS)   return false;
  if (token.jitoDetected)                                          return false;
  if (opportunityScore(token) < CLEAN_FILTERS.MIN_OPP_SCORE)       return false;
  const mcap = getMcap(token);
  if (mcap != null && mcap < CLEAN_FILTERS.MIN_MCAP_USD)           return false;
  if (mcap != null && mcap > CLEAN_FILTERS.MAX_MCAP_USD)           return false;
  return true;
}

function passesGems(token) {
  const mcap = getMcap(token);
  if (mcap == null)                                               return false;
  if (mcap < GEMS_FILTERS.MIN_MCAP_USD)                          return false;
  if (mcap > GEMS_FILTERS.MAX_MCAP_USD)                          return false;
  if (token.ageMinutes       >  GEMS_FILTERS.MAX_AGE_MINUTES)    return false;
  if (opportunityScore(token) < GEMS_FILTERS.MIN_OPP_SCORE)      return false;
  return true;
}

function passesFrontrun(token) {
  if (token.bundleScore      <  FRONTRUN_FILTERS.MIN_BUNDLE_SCORE)  return false;
  if (token.ageMinutes       >  FRONTRUN_FILTERS.MAX_AGE_MINUTES)   return false;
  if ((token.priceChange||0) >  FRONTRUN_FILTERS.MAX_PRICE_CHANGE)  return false; // price not yet pumped
  if (token.uniqueBuyers     <  FRONTRUN_FILTERS.MIN_UNIQUE_BUYERS)  return false;
  if (frontrunWindowSecs(token) <= 0)                                return false;
  return true;
}

// ─── FRONTRUN WINDOW ─────────────────────────────────────────────────────────
function frontrunWindowSecs(token) {
  const baseWindow  = token.jitoDetected ? 300 : 600; // extended windows
  const birthMs     = token.firstSeen || (Date.now() - (token.ageMinutes || 0) * 60000);
  const elapsedSecs = (Date.now() - birthMs) / 1000;
  return Math.max(0, baseWindow - elapsedSecs);
}

// ─── KNOWN NON-PUMP MINTS TO EXCLUDE ─────────────────────────────────────────
const EXCLUDED_MINTS = new Set([
  "So11111111111111111111111111111111111111112",  // Wrapped SOL
  "So11111111111111111111111111111111111111111",  // Native SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
]);

const MIN_BUNDLE_VOLUME_USD = 1000; // minimum $1000 in bundle volume

// ─── PRICE HISTORY STORE ─────────────────────────────────────────────────────
// Stores { price, timestamp } per mint across scans to compute real % change
const priceHistory = {};

function recordPrice(mint, price) {
  if (price == null) return;
  if (!priceHistory[mint]) {
    priceHistory[mint] = { firstPrice: price, firstSeen: Date.now(), lastPrice: price };
  } else {
    priceHistory[mint].lastPrice = price;
  }
}

function getRealPriceChange(mint, currentPrice) {
  if (currentPrice == null) return null;
  const h = priceHistory[mint];
  if (!h || h.firstPrice == null || h.firstPrice === 0) return null;
  return +((( currentPrice - h.firstPrice) / h.firstPrice) * 100).toFixed(1);
}

// ─── LIVE FETCH (via backend proxy — no CORS issues) ─────────────────────────
async function fetchLiveTokens() {
  // 1. Recent Pump.fun signatures via proxy
  const rpcController = new AbortController();
  const rpcTimeout = setTimeout(() => rpcController.abort(), 8000);
  let txRes;
  try {
    txRes = await fetch(PROXY_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [PUMP_FUN_PROGRAM, { limit: 100 }],
      }),
      signal: rpcController.signal,
    });
  } catch (e) {
    throw new Error("RPC timed out — server may be waking up, try again in 10 seconds");
  } finally {
    clearTimeout(rpcTimeout);
  }
  if (!txRes.ok) throw new Error(`RPC failed (${txRes.status}) — is the proxy running?`);
  const txData = await txRes.json();
  const sigs = Array.isArray(txData.result) ? txData.result.map(s => s.signature) : [];
  if (!sigs.length) throw new Error("No signatures returned from RPC");

  // 2. Parse enhanced transactions via proxy
  const parseRes = await fetch(PROXY_TX, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions: sigs.slice(0, 25) }),
  });
  if (!parseRes.ok) throw new Error(`Enhanced TX failed (${parseRes.status})`);
  const parsed = await parseRes.json();
  if (!Array.isArray(parsed)) throw new Error("Unexpected response from transaction parser");
  const validTxs = parsed.filter(tx => tx && tx.signature && !tx.error);

  // 3. Build tokenMap from parsed transactions
  const tokenMap = {};
  for (const tx of validTxs) {
    const nativeTransfers = tx.nativeTransfers || [];
    const isJito = nativeTransfers.some(t => JITO_TIP_ACCOUNTS.has(t.toUserAccount));
    // Sum SOL moved in native transfers as proxy for bundle volume
    const solMoved = nativeTransfers.reduce((sum, t) => sum + (t.amount || 0), 0) / 1e9;

    for (const swap of (tx.tokenTransfers || [])) {
      const mint = swap.mint;
      if (!mint) continue;
      if (EXCLUDED_MINTS.has(mint)) continue; // skip SOL, USDC, USDT etc
      if (!tokenMap[mint]) {
        tokenMap[mint] = {
          mint, buyerSet: new Set(), txSlots: [],
          txCount: 0, firstSeen: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
          totalVolume: 0, totalSolVolume: 0, bundleVolumeSol: 0,
          jitoDetected: false, jitoTxCount: 0,
          jitoSigsSeen: new Set(),
          slotSigsSeen: new Set(),
          bundleVolSigsSeen: new Set(),
          rawTxs: [],
        };
      }
      const buyer = swap.toUserAccount;
      if (buyer && buyer !== "unknown") tokenMap[mint].buyerSet.add(buyer);
      if (tx.slot && !tokenMap[mint].slotSigsSeen.has(tx.signature)) {
        tokenMap[mint].slotSigsSeen.add(tx.signature);
        tokenMap[mint].txSlots.push(tx.slot);
      }
      tokenMap[mint].txCount++;
      tokenMap[mint].totalVolume += swap.tokenAmount || 0;
      // Track SOL spent (native transfers to non-Jito accounts = buys)
      tokenMap[mint].totalSolVolume += nativeTransfers
        .filter(t => !JITO_TIP_ACCOUNTS.has(t.toUserAccount))
        .reduce((s, t) => s + (t.amount || 0), 0) / 1e9;
      if (isJito) {
        tokenMap[mint].jitoDetected = true;
        // Only add bundle volume once per tx to avoid multiplying by swap count
        if (!tokenMap[mint].bundleVolSigsSeen.has(tx.signature)) {
          tokenMap[mint].bundleVolSigsSeen.add(tx.signature);
          tokenMap[mint].bundleVolumeSol += solMoved;
        }
        if (!tokenMap[mint].jitoSigsSeen.has(tx.signature)) {
          tokenMap[mint].jitoSigsSeen.add(tx.signature);
          tokenMap[mint].jitoTxCount++;
        }
      }
      tokenMap[mint].rawTxs.push({
        sig: tx.signature, slot: tx.slot, buyer, isJito,
        amount: swap.tokenAmount || 0, timestamp: tx.timestamp,
      });
    }
  }

  // Filter out mints with insufficient bundle volume (approx $1000 at ~$150/SOL)
  const SOL_PRICE_APPROX = 150;
  const minBundleSol = MIN_BUNDLE_VOLUME_USD / SOL_PRICE_APPROX;
  const mints = Object.keys(tokenMap)
    .filter(mint => {
      const t = tokenMap[mint];
      // If bundled, must meet min volume; if not bundled, always include
      if (t.jitoDetected && t.bundleVolumeSol < minBundleSol) return false;
      return true;
    })
    .slice(0, 25);
  if (!mints.length) throw new Error("No token mints found in parsed transactions");

  // 4. Enrich with metadata via proxy
  const metaRes = await fetch(PROXY_META, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mintAccounts: mints, includeOffChain: true }),
  });
  if (!metaRes.ok) throw new Error(`Metadata fetch failed (${metaRes.status})`);
  const metaArr = await metaRes.json().then(r => Array.isArray(r) ? r : []);

  // 5. Jupiter price via proxy (best-effort)
  let prices = {};
  try {
    const j = await fetch(`${PROXY_PRICE}?ids=${mints.join(",")}`);
    if (j.ok) prices = (await j.json()).data || {};
  } catch (_) {}

  // Fix metadata index mismatch — build a map by mint address instead of relying on array index
  const metaByMint = {};
  for (let i = 0; i < mints.length; i++) {
    const meta = metaArr[i];
    if (meta && meta.account) {
      metaByMint[meta.account] = meta;
    } else if (meta) {
      // fallback: assign by position if no account field
      metaByMint[mints[i]] = meta;
    }
  }

  // 6. Build enriched token objects
  return mints.map((mint) => {
    const m            = metaByMint[mint] || {};
    const name         = m.onChainMetadata?.metadata?.data?.name   || "Unknown";
    const symbol       = m.onChainMetadata?.metadata?.data?.symbol || "???";
    const token        = tokenMap[mint];
    const uniqueBuyers = [...token.buyerSet];
    const ageMinutes   = Math.max(1, Math.floor((Date.now() - token.firstSeen) / 60000));
    const slotCluster  = computeSlotClusterScore(token.txSlots);
    const bundleScore  = computeBundleScore(token.txCount, uniqueBuyers.length, slotCluster);
    const jupPrice      = prices[mint]?.price ?? null;
    const estimatedPrice = jupPrice ?? estimatePriceFromVolume(token.totalVolume, token.totalSolVolume);
    // Record price for future scans and compute real % change
    recordPrice(mint, jupPrice ?? estimatedPrice);
    const realChange   = getRealPriceChange(mint, jupPrice ?? estimatedPrice);
    const priceChange  = realChange != null ? realChange : 0;

    // Sort timestamped txs for early buyer detection; exclude null-timestamp txs
    const sortedTxs = [...token.rawTxs]
      .filter(t => t.timestamp != null)
      .sort((a, b) => a.timestamp - b.timestamp);
    const allTxs = [...token.rawTxs];

    const labeledTxs = sortedTxs.map((t, originalIdx) => ({
      ...t,
      originalIdx,
      label: t.isJito ? "jito bundle" : originalIdx === 0 ? "dev/deployer" : "early snipe",
    }));
    const suspiciousWallets = labeledTxs
      .filter(t => t.isJito || t.originalIdx < 3)
      .slice(0, 6)
      .map(t => ({
        address: t.buyer || "unknown",
        action:  t.label,
        slot:    t.slot,
        percent: +((t.amount / (token.totalVolume || 1)) * 100).toFixed(1),
      }))
      .filter((w, wi, arr) => arr.findIndex(x => x.address === w.address) === wi);

    const earlyBuyers = new Set(sortedTxs.slice(0, 3).map(t => t.buyer).filter(Boolean));
    const jitoSenders = new Set(allTxs.filter(t => t.isJito).map(t => t.buyer).filter(Boolean));
    const insiderSet  = new Set([...earlyBuyers, ...jitoSenders]);

    // ─── DAUMEN FOUR METRICS ──────────────────────────────────────────────────
    // 1. Fresh Wallet Score — what % of buyers have wallets active < 24hrs
    //    We estimate freshness by how early they appeared vs token launch
    const freshBuyerCount = sortedTxs.filter((t, idx) => idx < 5 && t.buyer).length;
    const freshWalletScore = Math.min(1, freshBuyerCount / Math.max(1, uniqueBuyers.length));
    const hasFreshWallets  = freshWalletScore > 0.4 && uniqueBuyers.length >= 2;

    // 2. Balance Threshold — estimate from SOL volume per buyer
    //    Average SOL per buyer; anything above 0.5 SOL avg = quality buyers
    const avgSolPerBuyer = token.totalSolVolume / Math.max(1, uniqueBuyers.length);
    const meetsBalanceThreshold = avgSolPerBuyer >= 0.3; // 0.3 SOL minimum avg

    // 3. Entry / Exit targets based on current MC
    const currentMcap = estimatedPrice != null ? estimatedPrice * PUMP_SUPPLY : null;
    const entryMcap   = currentMcap;
    const targetMcap  = currentMcap != null ? currentMcap * 2.5  : null; // 2.5x target
    const stopMcap    = currentMcap != null ? currentMcap * 0.75 : null; // 25% stop loss

    // 4. Hold Time Window — optimal hold based on token age and momentum
    const holdMinMinutes = 3;   // never exit before 3 min
    const holdMaxMinutes = ageMinutes < 10 ? 20 : ageMinutes < 30 ? 15 : 10;
    const holdWindowOpen = ageMinutes < holdMaxMinutes;

    // Daumen composite — passes all 4 checks
    const passesDaumen = hasFreshWallets && meetsBalanceThreshold &&
                         currentMcap != null && holdWindowOpen;

    return {
      mint, name, symbol,
      narrative:        detectNarrative(name, symbol),
      uniqueBuyers:     uniqueBuyers.length,
      insiderCount:     Math.min(insiderSet.size, 8),
      bundleScore:      +bundleScore.toFixed(3),
      slotClusterScore: +slotCluster.toFixed(3),
      topHolderConc:    0.30,
      ageMinutes,
      firstSeen:        token.firstSeen,
      jitoDetected:     token.jitoDetected,
      jitoTxCount:      token.jitoTxCount,
      isBundled:        bundleScore > 0.4,
      priceChange,
      hasPriceHistory:  realChange !== null,
      jupPrice,
      estimatedPrice,
      volume:           token.totalVolume,
      txCount:          token.txCount,
      suspiciousWallets,
      // Daumen four metrics
      hasFreshWallets,
      freshWalletScore: +freshWalletScore.toFixed(2),
      meetsBalanceThreshold,
      avgSolPerBuyer:   +avgSolPerBuyer.toFixed(3),
      entryMcap,
      targetMcap,
      stopMcap,
      holdMinMinutes,
      holdMaxMinutes,
      holdWindowOpen,
      passesDaumen,
    };
  });
}

// ─── MARKETCAP HELPER ────────────────────────────────────────────────────────
function fmtMcap(token) {
  const price = token?.jupPrice ?? token?.estimatedPrice ?? null;
  if (price == null) return null;
  const mcap = price * PUMP_SUPPLY;
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(1)}M`;
  if (mcap >= 1_000)     return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}

// ─── AI SIGNAL ────────────────────────────────────────────────────────────────
async function getAISignal(token, mode) {
  const isClean = mode === "clean";
  const mcap = fmtMcap(token) || "unknown";
  const prompt = isClean
    ? `You are an aggressive pump.fun trader. Give a decisive signal — do NOT default to WATCH unless truly uncertain.

Token: ${token.name} ($${token.symbol})
Narrative: ${token.narrative || "none"} | Age: ${token.ageMinutes}m | Mcap: ${mcap}
Price change: ${token.priceChange.toFixed(1)}% | Buyers: ${token.uniqueBuyers}
Bundle score: ${(token.bundleScore*100).toFixed(0)}% | Insiders: ${token.insiderCount} | Jito: NO
Opportunity score: ${opportunityScore(token)}/100 | Risk score: ${computeRisk(token)}/100

Rules:
- If opp > 60 and risk < 40 and buyers >= 5: STRONG BUY
- If opp > 45 and risk < 55: BUY
- If risk > 55 or insiders > 4: WATCH
- Be specific about entry price/mcap and exit targets

Respond ONLY in this exact format:
SIGNAL: [STRONG BUY / BUY / WATCH]
ENTRY: [one sentence with specific mcap entry point]
EXIT: [one sentence with specific % target and stop loss]`
    : `You are a pump.fun bundle frontrunner. Be decisive — money is on the line.

Token: ${token.name} ($${token.symbol}) | Mcap: ${mcap}
Age: ${token.ageMinutes}m | Price change so far: ${token.priceChange.toFixed(1)}%
Jito: ${token.jitoDetected?"YES":"NO"} | Bundle: ${(token.bundleScore*100).toFixed(0)}% | Cluster: ${(token.slotClusterScore*100).toFixed(0)}%
Window remaining: ~${Math.round(frontrunWindowSecs(token)/60)}min | Buyers: ${token.uniqueBuyers}

Rules:
- If bundle > 60% and price < 20% and window > 3min: FRONTRUN NOW
- If bundle > 40% and window > 2min: RISKY FRONTRUN
- If window < 2min or price already > 35%: AVOID

Respond ONLY in this exact format:
SIGNAL: [FRONTRUN NOW / RISKY FRONTRUN / AVOID]
WINDOW: [one sentence on how long you have and urgency]
STRATEGY: [one sentence — exact action: buy X% position, target Y% gain, exit if Z]`;

  const res = await fetch("/api/pumpradar/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`AI API ${res.status}: ${errText.slice(0, 100)}`);
  }
  const data = await res.json();
  const text = data.content?.find(b => b.type === "text")?.text || "";
  const get  = key => text.match(new RegExp(`${key}:\\s*(.+)`, "i"))?.[1]?.trim() || "";
  return isClean
    ? { signal: get("SIGNAL"), entry: get("ENTRY"), exit: get("EXIT") }
    : { signal: get("SIGNAL"), window: get("WINDOW"), strategy: get("STRATEGY") };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const RC      = s => s > 65 ? "#ff3b3b" : s > 35 ? "#ffaa00" : "#00ff88";
const OC      = s => s > 70 ? "#00ff88" : s > 50 ? "#44ffaa" : "#ffaa00";
const fmtJup  = v => v != null ? `$${v < 0.000001 ? v.toExponential(2) : v.toPrecision(4)}` : null;
const fmtSecs = s => { const n = Math.floor(s); return n <= 0 ? "CLOSED" : n < 60 ? `${n}s` : `~${Math.round(n/60)}m`; };

// ─── SHARED UI ATOMS ─────────────────────────────────────────────────────────
function Bar({ value, color, label, lm = false }) {
  return (
    <div>
      {label && <div style={{ color: lm ? "#888" : "#2a2a3a", fontSize:8, letterSpacing:1, marginBottom:3 }}>{label}</div>}
      <div style={{ display:"flex", alignItems:"center", gap:7 }}>
        <div style={{ flex:1, height:4, background: lm ? "#e0e0d8" : "#0c0c1a", borderRadius:2, overflow:"hidden" }}>
          <div style={{ width:`${Math.min(value,100)}%`, height:"100%", background:`linear-gradient(90deg,${color}44,${color})`, borderRadius:2, transition:"width 0.8s ease" }} />
        </div>
        <span style={{ color, fontSize:9, fontWeight:700, minWidth:22, fontFamily:"'Space Mono',monospace" }}>{value}</span>
      </div>
    </div>
  );
}

function Tag({ children, bg, color, border }) {
  return (
    <span style={{ background:bg, color, border:`1px solid ${border||color+"33"}`, fontSize:8, fontWeight:900, letterSpacing:1.5, padding:"2px 7px", borderRadius:3, textTransform:"uppercase", fontFamily:"'Space Mono',monospace", whiteSpace:"nowrap" }}>
      {children}
    </span>
  );
}

function NarrativeTag({ tag }) {
  const map = { AI:["#0d2240","#5bc0ff"], MEME:["#2a0d40","#cc88ff"], TRUMP:["#3a2200","#ffcc00"], DEPIN:["#0d2a1a","#44ffaa"], GAMING:["#2a0d1a","#ff88cc"], RWA:["#2a1a0d","#ffaa44"] };
  const [bg, c] = map[tag] || ["#1a1a2a","#aaa"];
  return <Tag bg={bg} color={c}>{tag}</Tag>;
}

function AIPanel({ signal, mode, lm = false }) {
  if (!signal) return null;
  const isClean = mode === "clean";
  const key     = signal.signal?.toUpperCase() || "";

  // Show error state
  if (key === "ERROR") {
    const msg = isClean ? signal.entry : signal.window;
    return (
      <div style={{ background: lm ? "#fff0f0" : "#1a0000", border:"1px solid #ff444433", borderRadius:8, padding:"10px 12px", marginTop:10 }}>
        <div style={{ color:"#ff4444", fontSize:10, fontWeight:900, letterSpacing:1.5, marginBottom:6 }}>⚠ AI ERROR</div>
        <div style={{ color: lm ? "#cc2200" : "#ff8888", fontSize:9, lineHeight:1.5 }}>{msg}</div>
      </div>
    );
  }

  const cfg = isClean
    ? { "STRONG BUY":["#001a0d","#00aa66","⚡"], "BUY":["#001510","#44bb88","✓"], "WATCH":["#1a0d00","#ffaa00","👁"] }
    : { "FRONTRUN NOW":["#001a0d","#00aa66","🎯"], "RISKY FRONTRUN":["#1a0d00","#ffaa00","⚠"], "AVOID":["#1a0000","#ff4444","✕"] };
  const lmCfg = isClean
    ? { "STRONG BUY":["#e8fff4","#00aa66","⚡"], "BUY":["#e8fff4","#009955","✓"], "WATCH":["#fff8e8","#cc8800","👁"] }
    : { "FRONTRUN NOW":["#e8fff4","#00aa66","🎯"], "RISKY FRONTRUN":["#fff8e8","#cc8800","⚠"], "AVOID":["#fff0f0","#ff4444","✕"] };
  const cfgMap  = lm ? lmCfg : cfg;
  const match   = Object.keys(cfgMap).find(k => key.includes(k)) || (isClean ? "WATCH" : "AVOID");
  const [bg, color, icon] = cfgMap[match];
  const lines = isClean
    ? [{ k:"ENTRY", v:signal.entry }, { k:"EXIT", v:signal.exit }]
    : [{ k:"WINDOW", v:signal.window }, { k:"STRATEGY", v:signal.strategy }];
  return (
    <div style={{ background:bg, border:`1px solid ${color}33`, borderRadius:8, padding:"10px 12px", marginTop:10 }}>
      <div style={{ color, fontSize:10, fontWeight:900, letterSpacing:1.5, marginBottom:6 }}>{icon} AI: {match}</div>
      {lines.map(l => l.v ? (
        <div key={l.k} style={{ marginBottom:4 }}>
          <span style={{ color: lm ? "#888" : "#333", fontSize:8, letterSpacing:1 }}>{l.k}: </span>
          <span style={{ color: lm ? "#333" : "#aaa", fontSize:10, lineHeight:1.5 }}>{l.v}</span>
        </div>
      ) : null)}
    </div>
  );
}

function CountdownTimer({ initialSeconds }) {
  const [rem, setRem] = useState(initialSeconds);
  const timerRef = useRef(null);
  useEffect(() => {
    setRem(initialSeconds);
    clearInterval(timerRef.current);
    if (initialSeconds <= 0) return;
    timerRef.current = setInterval(() => setRem(r => Math.max(0, r - 1)), 1000);
    return () => clearInterval(timerRef.current);
  }, [initialSeconds]);
  const color = rem <= 60 ? "#ff3b3b" : rem <= 120 ? "#ffaa00" : "#00ff88";
  return <span style={{ color, fontWeight:900, fontFamily:"'Space Mono',monospace", fontSize:13 }}>{fmtSecs(rem)}</span>;
}

function CopyCA({ mint, lm = false }) {
  const [copied, setCopied] = useState(false);
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(mint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div
      onClick={copy}
      style={{ display:"flex", alignItems:"center", justifyContent:"space-between", background: lm ? "#f5f5f0" : "#08080f", border:`1px solid ${copied ? "#00aa6644" : (lm ? "#e0e0d8" : "#1a1a2a")}`, borderRadius:6, padding:"7px 10px", marginBottom:8, cursor:"pointer", transition:"border 0.2s" }}
    >
      <span style={{ color: lm ? "#888" : "#2a2a3a", fontSize:8, letterSpacing:1, fontFamily:"'Space Mono',monospace", flexShrink:0, marginRight:8 }}>CA</span>
      <span style={{ color: lm ? "#aaa" : "#444", fontSize:8, fontFamily:"'Space Mono',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{mint}</span>
      <span style={{ color: copied ? "#00aa66" : (lm ? "#aaa" : "#333"), fontSize:8, fontWeight:900, letterSpacing:1, flexShrink:0, marginLeft:8, fontFamily:"'Space Mono',monospace" }}>
        {copied ? "✓ COPIED" : "COPY"}
      </span>
    </div>
  );
}

function ExtLinks({ mint, lm = false }) {
  const links = [
    { href:`https://pump.fun/coin/${mint}`,          label:"PUMP.FUN", bg: lm ? "#e8fff4" : "#0d1f0d", color:"#00aa66" },
    { href:`https://dexscreener.com/solana/${mint}`, label:"DEXSCR",   bg: lm ? "#f4e8ff" : "#1a0d1a", color:"#cc88ff" },
    { href:`https://solscan.io/token/${mint}`,        label:"SOLSCAN",  bg: lm ? "#e8f4ff" : "#0d0d2a", color:"#5bc0ff" },
  ];
  return (
    <div style={{ marginBottom:10 }}>
      <CopyCA mint={mint} lm={lm} />
      <div style={{ display:"flex", gap:8 }}>
        {links.map(l => (
          <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ flex:1, textAlign:"center", background:l.bg, color:l.color, border:`1px solid ${l.color}33`, borderRadius:6, padding:"7px 0", fontSize:8, fontWeight:900, textDecoration:"none", letterSpacing:0.5, fontFamily:"'Space Mono',monospace" }}>
            {l.label} ↗
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── DAUMEN PANEL ─────────────────────────────────────────────────────────────
function DaumenPanel({ token, lm = false }) {
  const bg      = lm ? "#f8f8f0" : "#08080e";
  const border  = lm ? "#e0e0d0" : "#1a1a28";
  const checks = [
    {
      key:   "balance",
      icon:  token.meetsBalanceThreshold ? "✓" : "✗",
      label: "BALANCE",
      value: `${token.avgSolPerBuyer.toFixed(2)} SOL avg`,
      pass:  token.meetsBalanceThreshold,
      tip:   token.meetsBalanceThreshold ? "Quality buyers" : "Low SOL per buyer",
    },
    {
      key:   "fresh",
      icon:  token.hasFreshWallets ? "🌿" : "✗",
      label: "FRESH WALLETS",
      value: `${Math.round(token.freshWalletScore * 100)}% fresh`,
      pass:  token.hasFreshWallets,
      tip:   token.hasFreshWallets ? "New wallet activity" : "Aged wallets",
    },
    {
      key:   "entry",
      icon:  token.entryMcap != null ? "✓" : "✗",
      label: "ENTRY / EXIT",
      value: token.entryMcap != null
        ? `→ ${fmtMcap(token)} · TP ${fmtMcap({estimatedPrice: token.targetMcap / PUMP_SUPPLY})} · SL ${fmtMcap({estimatedPrice: token.stopMcap / PUMP_SUPPLY})}`
        : "No price data",
      pass:  token.entryMcap != null,
      tip:   "Entry now · 2.5x target · 25% stop",
    },
    {
      key:   "hold",
      icon:  token.holdWindowOpen ? "✓" : "✗",
      label: "HOLD WINDOW",
      value: token.holdWindowOpen
        ? `${token.holdMinMinutes}–${token.holdMaxMinutes}min window`
        : "Window closed",
      pass:  token.holdWindowOpen,
      tip:   token.holdWindowOpen ? "Still within entry window" : "Too late to enter",
    },
  ];

  return (
    <div style={{ background:bg, border:`1px solid ${border}`, borderRadius:8, padding:"10px 12px", marginTop:10 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <span style={{ color: lm ? "#555" : "#888", fontSize:8, letterSpacing:2, fontWeight:900 }}>DAUMEN CHECKS</span>
        <span style={{ background: token.passesDaumen ? "#00aa6622" : "#ff444422", color: token.passesDaumen ? "#00aa66" : "#ff4444", fontSize:8, fontWeight:900, padding:"2px 8px", borderRadius:10, letterSpacing:1 }}>
          {token.passesDaumen ? "✓ ALL PASS" : "✗ INCOMPLETE"}
        </span>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5 }}>
        {checks.map(c => (
          <div key={c.key} style={{ background: lm ? (c.pass ? "#f0fff8" : "#fff4f4") : (c.pass ? "#001a0d" : "#1a0000"), border:`1px solid ${c.pass ? "#00aa6622" : "#ff444422"}`, borderRadius:6, padding:"6px 8px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:2 }}>
              <span style={{ fontSize:10 }}>{c.icon}</span>
              <span style={{ color: lm ? "#666" : "#555", fontSize:7, letterSpacing:1, fontWeight:900 }}>{c.label}</span>
            </div>
            <div style={{ color: c.pass ? "#00aa66" : "#ff6666", fontSize:8, fontWeight:700, fontFamily:"'Space Mono',monospace", lineHeight:1.4 }}>{c.value}</div>
            <div style={{ color: lm ? "#aaa" : "#333", fontSize:7, marginTop:2 }}>{c.tip}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CLEAN CARD ───────────────────────────────────────────────────────────────
function CleanCard({ token, rank, lm = false }) {
  const [expanded, setExpanded] = useState(false);
  const [aiSig, setAiSig]       = useState(null);
  const [aiLoad, setAiLoad]     = useState(false);
  const risk = useMemo(() => computeRisk(token), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.insiderCount, token.bundleScore, token.topHolderConc, token.ageMinutes, token.jitoDetected, token.slotClusterScore]);
  const opp  = useMemo(() => opportunityScore(token), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.priceChange, token.uniqueBuyers, token.ageMinutes, risk]);
  const ac   = OC(opp);
  const cardBg   = lm ? "#ffffff" : "linear-gradient(135deg,#070712,#0b0b1e)";
  const cardBorder = lm ? "#e0e0d8" : "#00ff8812";
  const statBg   = lm ? "#f5f5f0" : "#050510";
  const statBorder = lm ? "#e0e0d8" : "#0f0f20";
  const textMain = lm ? "#111" : "#fff";
  const textDim  = lm ? "#666" : "#333";
  const textMuted = lm ? "#999" : "#2a2a3a";
  const dividerColor = lm ? "#e8e8e0" : "#0f0f20";
  const aiBtnBg  = lm ? "linear-gradient(135deg,#e8f0ff,#e8fff4)" : "linear-gradient(135deg,#0d1f3a,#0d2a1a)";
  const aiBtnBorder = lm ? "#5bc0ff44" : "#5bc0ff18";
  const aiBtnColor = lm ? "#0077aa" : "#5bc0ff";

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      style={{ background:cardBg, border:`1px solid ${cardBorder}`, borderLeft:`3px solid ${ac}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", position:"relative", overflow:"hidden", transition:"box-shadow 0.2s" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = lm ? "0 2px 16px #00000018" : "0 0 24px #00ff8810"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
    >
      <div style={{ position:"absolute", top:0, left:0, right:0, height:1, background:`linear-gradient(90deg,transparent,${ac}22,transparent)`, pointerEvents:"none" }} />

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:`conic-gradient(${ac} 0deg,${lm?"#e8e8e0":"#0d0d1e"} 360deg)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:900, color:ac, flexShrink:0 }}>#{rank}</div>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
              <span style={{ color:textMain, fontWeight:900, fontSize:14, fontFamily:"'Space Mono',monospace" }}>{token.symbol}</span>
              {token.narrative && <NarrativeTag tag={token.narrative} />}
              <Tag bg={lm?"#e8fff4":"#001a0d"} color="#00aa66">✓ CLEAN</Tag>
              {token.passesDaumen && <Tag bg={lm?"#f0fff8":"#001a08"} color="#00dd88">🌿 DAUMEN</Tag>}
            </div>
            <div style={{ color:textDim, fontSize:10, marginTop:2 }}>{token.name}</div>
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ color:"#00aa66", fontWeight:900, fontSize:14, fontFamily:"'Space Mono',monospace" }}>+{token.priceChange.toFixed(1)}%</div>
          <div style={{ color:textMuted, fontSize:9, marginTop:1 }}>{token.ageMinutes}m old</div>
          {token.jupPrice != null && (
            <div style={{ color:"#5bc0ff", fontSize:9, marginTop:1 }}>{fmtJup(token.jupPrice)}</div>
          )}
          {fmtMcap(token) && (
            <div style={{ color:"#ffaa00", fontSize:9, marginTop:1, fontWeight:900 }}>MC {fmtMcap(token)}</div>
          )}
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:5, marginTop:10 }}>
        {[
          { l:"INSIDERS", v:token.insiderCount,                         c:token.insiderCount > 2 ? "#ffaa00" : "#00aa66" },
          { l:"BUNDLE",   v:`${(token.bundleScore*100).toFixed(0)}%`,   c:"#00aa66" },
          { l:"TOP10",    v:`${(token.topHolderConc*100).toFixed(0)}%`, c:token.topHolderConc > 0.35 ? "#ffaa00" : "#00aa66" },
          { l:"BUYERS",   v:token.uniqueBuyers,                         c:"#5bc0ff" },
        ].map(s => (
          <div key={s.l} style={{ background:statBg, borderRadius:6, padding:"6px 8px", border:`1px solid ${statBorder}` }}>
            <div style={{ color:textMuted, fontSize:8, letterSpacing:1 }}>{s.l}</div>
            <div style={{ color:s.c, fontWeight:700, fontSize:12, fontFamily:"'Space Mono',monospace" }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
        <Bar value={risk} color={RC(risk)} label="RISK" lm={lm} />
        <Bar value={opp}  color={OC(opp)}  label="OPPORTUNITY" lm={lm} />
      </div>

      {expanded && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${dividerColor}`, animation:"fadeIn 0.2s ease" }}>
          <DaumenPanel token={token} lm={lm} />
          <ExtLinks mint={token.mint} lm={lm} />
          {!aiSig && (
            <button
              onClick={async e => { e.stopPropagation(); setAiLoad(true); try { setAiSig(await getAISignal(token,"clean")); } catch(err) { setAiSig({ signal:"ERROR", entry: err.message || "API call failed — check console.", exit:"" }); } setAiLoad(false); }}
              disabled={aiLoad}
              style={{ width:"100%", padding:"9px 0", background:aiLoad?(lm?"#e8e8e0":"#0f0f20"):aiBtnBg, border:`1px solid ${aiBtnBorder}`, borderRadius:8, color:aiLoad?(lm?"#aaa":"#2a2a3a"):aiBtnColor, fontSize:9, fontWeight:900, letterSpacing:1.5, cursor:aiLoad?"default":"pointer", fontFamily:"'Space Mono',monospace" }}>
              {aiLoad ? "⏳ ANALYZING..." : "🤖 AI ENTRY SIGNAL"}
            </button>
          )}
          {aiSig && <AIPanel signal={aiSig} mode="clean" lm={lm} />}
        </div>
      )}
    </div>
  );
}

// ─── GEM CARD (same as CleanCard but with gem branding) ──────────────────────
function GemCard({ token, rank, lm = false }) {
  const [expanded, setExpanded] = useState(false);
  const [aiSig, setAiSig]       = useState(null);
  const [aiLoad, setAiLoad]     = useState(false);
  const risk = useMemo(() => computeRisk(token), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.insiderCount, token.bundleScore, token.topHolderConc, token.ageMinutes, token.jitoDetected, token.slotClusterScore]);
  const opp  = useMemo(() => opportunityScore(token), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.priceChange, token.uniqueBuyers, token.ageMinutes, risk]);
  const ac   = "#ffaa00";
  const cardBg   = lm ? "#ffffff" : "linear-gradient(135deg,#12100a,#1a1408)";
  const cardBorder = lm ? "#e8e0d0" : "#ffaa0012";
  const statBg   = lm ? "#f5f5f0" : "#0e0c06";
  const statBorder = lm ? "#e0e0d8" : "#1a1408";
  const textMain = lm ? "#111" : "#fff";
  const textDim  = lm ? "#666" : "#333";
  const textMuted = lm ? "#999" : "#2a2a3a";
  const dividerColor = lm ? "#e8e8e0" : "#1a1408";

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      style={{ background:cardBg, border:`1px solid ${cardBorder}`, borderLeft:`3px solid ${ac}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", position:"relative", overflow:"hidden", transition:"box-shadow 0.2s" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = lm ? "0 2px 16px #00000018" : "0 0 24px #ffaa0014"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
    >
      <div style={{ position:"absolute", top:0, left:0, right:0, height:1, background:`linear-gradient(90deg,transparent,${ac}22,transparent)`, pointerEvents:"none" }} />
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:`conic-gradient(${ac} 0deg,${lm?"#e8e8e0":"#0d0d1e"} 360deg)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:900, color:ac, flexShrink:0 }}>#{rank}</div>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
              <span style={{ color:textMain, fontWeight:900, fontSize:14, fontFamily:"'Space Mono',monospace" }}>{token.symbol}</span>
              {token.narrative && <NarrativeTag tag={token.narrative} />}
              <Tag bg={lm?"#fff8e8":"#1a1000"} color="#ffaa00">💎 GEM</Tag>
              {token.jitoDetected && <Tag bg={lm?"#fff0f0":"#1a0000"} color="#ff4444">⚡ JITO</Tag>}
            </div>
            <div style={{ color:textDim, fontSize:10, marginTop:2 }}>{token.name}</div>
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ color:ac, fontWeight:900, fontSize:14, fontFamily:"'Space Mono',monospace" }}>+{token.priceChange.toFixed(1)}%</div>
          <div style={{ color:textMuted, fontSize:9, marginTop:1 }}>{token.ageMinutes}m old</div>
          {token.jupPrice != null && <div style={{ color:"#5bc0ff", fontSize:9, marginTop:1 }}>{fmtJup(token.jupPrice)}</div>}
          {fmtMcap(token) && <div style={{ color:ac, fontSize:9, marginTop:1, fontWeight:900 }}>MC {fmtMcap(token)}</div>}
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:5, marginTop:10 }}>
        {[
          { l:"INSIDERS", v:token.insiderCount,                         c:token.insiderCount > 3 ? "#ff4444" : token.insiderCount > 1 ? "#ffaa00" : "#00aa66" },
          { l:"BUNDLE",   v:`${(token.bundleScore*100).toFixed(0)}%`,   c:token.bundleScore > 0.4 ? "#ffaa00" : "#00aa66" },
          { l:"AGE",      v:`${token.ageMinutes}m`,                     c:token.ageMinutes > 60 ? "#ffaa00" : "#00aa66" },
          { l:"BUYERS",   v:token.uniqueBuyers,                         c:"#5bc0ff" },
        ].map(s => (
          <div key={s.l} style={{ background:statBg, borderRadius:6, padding:"6px 8px", border:`1px solid ${statBorder}` }}>
            <div style={{ color:textMuted, fontSize:8, letterSpacing:1 }}>{s.l}</div>
            <div style={{ color:s.c, fontWeight:700, fontSize:12, fontFamily:"'Space Mono',monospace" }}>{s.v}</div>
          </div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
        <Bar value={risk} color={RC(risk)} label="RISK" lm={lm} />
        <Bar value={opp}  color={OC(opp)}  label="OPPORTUNITY" lm={lm} />
      </div>
      {expanded && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${dividerColor}`, animation:"fadeIn 0.2s ease" }}>
          <DaumenPanel token={token} lm={lm} />
          <ExtLinks mint={token.mint} lm={lm} />
          {!aiSig && (
            <button
              onClick={async e => { e.stopPropagation(); setAiLoad(true); try { setAiSig(await getAISignal(token,"clean")); } catch(err) { setAiSig({ signal:"ERROR", entry: err.message || "API call failed.", exit:"" }); } setAiLoad(false); }}
              disabled={aiLoad}
              style={{ width:"100%", padding:"9px 0", background:aiLoad?(lm?"#e8e8e0":"#0f0f20"):(lm?"linear-gradient(135deg,#fff8e8,#fff0d8)":"linear-gradient(135deg,#1a1000,#2a1800)"), border:`1px solid ${lm?"#ffaa0044":"#ffaa0018"}`, borderRadius:8, color:aiLoad?(lm?"#aaa":"#2a2a3a"):(lm?"#aa6600":"#ffaa00"), fontSize:9, fontWeight:900, letterSpacing:1.5, cursor:aiLoad?"default":"pointer", fontFamily:"'Space Mono',monospace" }}>
              {aiLoad ? "⏳ ANALYZING..." : "💎 AI GEM SIGNAL"}
            </button>
          )}
          {aiSig && <AIPanel signal={aiSig} mode="clean" lm={lm} />}
        </div>
      )}
    </div>
  );
}

// ─── FRONTRUN CARD ────────────────────────────────────────────────────────────
function FrontrunCard({ token, rank, lm = false }) {
  const [expanded, setExpanded] = useState(false);
  const [aiSig, setAiSig]       = useState(null);
  const [aiLoad, setAiLoad]     = useState(false);
  const risk    = useMemo(() => computeRisk(token), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.insiderCount, token.bundleScore, token.topHolderConc, token.ageMinutes, token.jitoDetected, token.slotClusterScore]);
  const winSecs = useMemo(() => Math.floor(frontrunWindowSecs(token)), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.ageMinutes, token.jitoDetected, token.firstSeen]);
  const uc = winSecs <= 60 ? "#ff3b3b" : winSecs <= 180 ? "#ffaa00" : "#5bc0ff";
  const cardBg    = lm ? "#ffffff" : "linear-gradient(135deg,#0e0707,#160b0b)";
  const statBg    = lm ? "#f5f5f0" : "#050510";
  const statBorder = lm ? "#e0e0d8" : "#0f0f20";
  const windowBg  = lm ? "#fff8f8" : "#08030a";
  const textMain  = lm ? "#111" : "#fff";
  const textDim   = lm ? "#666" : "#333";
  const textMuted = lm ? "#999" : "#2a2a3a";
  const divider   = lm ? "#e8e0e0" : "#150808";
  const walletBg  = lm ? "#fff0f0" : "#060610";

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      style={{ background:cardBg, border:`1px solid ${uc}18`, borderLeft:`3px solid ${uc}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", position:"relative", overflow:"hidden", transition:"box-shadow 0.2s" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = lm ? "0 2px 16px #00000018" : `0 0 24px ${uc}14`}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
    >
      <div style={{ position:"absolute", top:0, left:0, right:0, height:1, background:`linear-gradient(90deg,transparent,${uc}28,transparent)`, pointerEvents:"none" }} />

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:`conic-gradient(${uc} 0deg,${lm?"#e8e8e0":"#0d0d1e"} 360deg)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:900, color:uc, flexShrink:0 }}>#{rank}</div>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
              <span style={{ color:textMain, fontWeight:900, fontSize:14, fontFamily:"'Space Mono',monospace" }}>{token.symbol}</span>
              {token.narrative && <NarrativeTag tag={token.narrative} />}
              {token.jitoDetected && <Tag bg={lm?"#fff0f0":"#1a0000"} color="#ff4444">⚡ JITO</Tag>}
              {token.isBundled    && <Tag bg={lm?"#fff8e8":"#2a1400"} color="#ffaa00">BUNDLE</Tag>}
            </div>
            <div style={{ color:textDim, fontSize:10, marginTop:2 }}>{token.name}</div>
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ color:"#ffaa00", fontWeight:900, fontSize:13, fontFamily:"'Space Mono',monospace" }}>+{token.priceChange.toFixed(1)}%</div>
          <div style={{ color:textMuted, fontSize:9, marginTop:1 }}>{token.ageMinutes}m old</div>
          {fmtMcap(token) && (
            <div style={{ color:"#ffaa00", fontSize:9, marginTop:1, fontWeight:900 }}>MC {fmtMcap(token)}</div>
          )}
        </div>
      </div>

      <div style={{ marginTop:10, background:windowBg, border:`1px solid ${uc}28`, borderRadius:8, padding:"9px 12px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ color:textMuted, fontSize:8, letterSpacing:1, marginBottom:2 }}>WINDOW LEFT</div>
          <CountdownTimer initialSeconds={winSecs} />
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ color:textMuted, fontSize:8, letterSpacing:1 }}>BUNDLE</div>
          <div style={{ color:"#ff6666", fontWeight:900, fontSize:13, fontFamily:"'Space Mono',monospace" }}>{(token.bundleScore*100).toFixed(0)}%</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ color:textMuted, fontSize:8, letterSpacing:1 }}>SLOT CLUSTER</div>
          <div style={{ color:"#ffaa00", fontWeight:900, fontSize:13, fontFamily:"'Space Mono',monospace" }}>{(token.slotClusterScore*100).toFixed(0)}%</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ color:textMuted, fontSize:8, letterSpacing:1 }}>JITO TXS</div>
          <div style={{ color:"#ff4444", fontWeight:900, fontSize:13, fontFamily:"'Space Mono',monospace" }}>{token.jitoTxCount}</div>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:5, marginTop:8 }}>
        {[
          { l:"INSIDERS", v:token.insiderCount,                         c:"#ffaa00" },
          { l:"TOP10",    v:`${(token.topHolderConc*100).toFixed(0)}%`, c:"#ffaa00" },
          { l:"BUYERS",   v:token.uniqueBuyers,                         c:"#5bc0ff" },
        ].map(s => (
          <div key={s.l} style={{ background:statBg, borderRadius:6, padding:"6px 8px", border:`1px solid ${statBorder}` }}>
            <div style={{ color:textMuted, fontSize:8, letterSpacing:1 }}>{s.l}</div>
            <div style={{ color:s.c, fontWeight:700, fontSize:12, fontFamily:"'Space Mono',monospace" }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop:8 }}>
        <Bar value={risk} color={RC(risk)} label="RISK (higher = dumps sooner)" lm={lm} />
      </div>

      {expanded && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${divider}`, animation:"fadeIn 0.2s ease" }}>
          {(token.suspiciousWallets?.length ?? 0) > 0 && (
            <>
              <div style={{ color:textMuted, fontSize:8, letterSpacing:1, marginBottom:6 }}>FLAGGED WALLETS</div>
              {token.suspiciousWallets.slice(0, 5).map((w, wi) => (
                <div key={wi} style={{ display:"flex", justifyContent:"space-between", background:walletBg, borderRadius:6, padding:"6px 10px", marginBottom:4, fontFamily:"'Space Mono',monospace" }}>
                  <span style={{ color:w.action === "jito bundle" ? "#ff4444" : w.action === "dev/deployer" ? "#ffaa00" : "#ff8866", fontSize:9 }}>{(w.address||"").slice(0,4)}...{(w.address||"").slice(-4)}</span>
                  <span style={{ color: lm ? "#888" : "#444", fontSize:9 }}>{w.action} · {w.percent}%</span>
                  {w.slot && <span style={{ color: lm ? "#bbb" : "#222", fontSize:8 }}>slot {w.slot}</span>}
                </div>
              ))}
            </>
          )}
          <DaumenPanel token={token} lm={lm} />
          <ExtLinks mint={token.mint} lm={lm} />
          {!aiSig && (
            <button
              onClick={async e => { e.stopPropagation(); setAiLoad(true); try { setAiSig(await getAISignal(token,"frontrun")); } catch(err) { setAiSig({ signal:"ERROR", window: err.message || "API call failed — check console.", strategy:"" }); } setAiLoad(false); }}
              disabled={aiLoad}
              style={{ width:"100%", padding:"9px 0", background:aiLoad?(lm?"#e8e8e0":"#0f0f20"):(lm?"linear-gradient(135deg,#fff0f0,#fff8e8)":"linear-gradient(135deg,#1a0505,#1a0a00)"), border:`1px solid ${lm?"#ffaa0044":"#ff444418"}`, borderRadius:8, color:aiLoad?(lm?"#aaa":"#2a2a3a"):(lm?"#cc6600":"#ff8866"), fontSize:9, fontWeight:900, letterSpacing:1.5, cursor:aiLoad?"default":"pointer", fontFamily:"'Space Mono',monospace" }}>
              {aiLoad ? "⏳ ANALYZING..." : "🎯 AI FRONTRUN SIGNAL"}
            </button>
          )}
          {aiSig && <AIPanel signal={aiSig} mode="frontrun" lm={lm} />}
        </div>
      )}
    </div>
  );
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function Toast({ toasts, onDismiss }) {
  return (
    <div style={{ position:"fixed", top:16, right:16, zIndex:9999, display:"flex", flexDirection:"column", gap:8, pointerEvents:"none" }}>
      {toasts.map(t => (
        <div key={t.id}
          onClick={() => onDismiss(t.id)}
          style={{ background:t.type==="frontrun"?"#1a0505":"#001a0d", border:`1px solid ${t.type==="frontrun"?"#ff444455":"#00ff8855"}`, borderLeft:`3px solid ${t.type==="frontrun"?"#ff4444":"#00ff88"}`, borderRadius:8, padding:"10px 14px", color:"#fff", fontSize:10, maxWidth:280, pointerEvents:"auto", cursor:"pointer", animation:"slideIn 0.3s ease" }}>
          <div style={{ color:t.type==="frontrun"?"#ff6666":"#00ff88", fontWeight:900, fontSize:9, letterSpacing:1 }}>{t.type==="frontrun"?"🎯 FRONTRUN ALERT":"⚡ CLEAN SIGNAL"}</div>
          <div style={{ marginTop:3, color:"#888" }}>{t.message}</div>
        </div>
      ))}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [allTokens,   setAllTokens]   = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [tab,         setTab]         = useState("clean");
  const [lastScan,    setLastScan]    = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [toasts,      setToasts]      = useState([]);
  const [scanCount,   setScanCount]   = useState(0);
  const [narrative,   setNarrative]   = useState("ALL");
  const [lightMode,   setLightMode]   = useState(false);

  const lm = lightMode;
  const theme = {
    bg:        lm ? "#f5f5f0" : "#06060e",
    bgCard:    lm ? "#ffffff" : "linear-gradient(135deg,#070712,#0b0b1e)",
    bgHeader:  lm ? "linear-gradient(180deg,#ffffff,#f5f5f0)" : "linear-gradient(180deg,#0a0a1c,#06060e)",
    bgControl: lm ? "#efefea" : "#090915",
    border:    lm ? "#e0e0d8" : "#0f0f22",
    text:      lm ? "#111111" : "#ffffff",
    textDim:   lm ? "#666666" : "#2a2a3a",
    textFaint: lm ? "#aaaaaa" : "#0f0f20",
    scrollBg:  lm ? "#e8e8e0" : "#080810",
    scrollThumb: lm ? "#cccccc" : "#1e1e30",
  };

  const intervalRef = useRef(null);
  const scanLockRef = useRef(false);
  const visibleRef  = useRef(true);
  const everSeenRef = useRef({ clean: new Set(), gems: new Set(), frontrun: new Set() });

  useEffect(() => {
    const fn = () => { visibleRef.current = !document.hidden; };
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  }, []);

  const addToast = useCallback((msg, type) => {
    const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    setToasts(t => [...t.slice(-4), { id, message: msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
  }, []);

  const scan = useCallback(async () => {
    if (scanLockRef.current) return;
    scanLockRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const raw          = await fetchLiveTokens();
      const cleanList    = raw.filter(passesClean);
      const gemsList     = raw.filter(passesGems);
      const frontrunList = raw.filter(passesFrontrun);

      for (const t of cleanList) {
        if (!everSeenRef.current.clean.has(t.mint)) {
          everSeenRef.current.clean.add(t.mint);
          addToast(`${t.symbol} clean entry · Opp ${opportunityScore(t)}`, "clean");
        }
      }
      for (const t of gemsList) {
        if (!everSeenRef.current.gems.has(t.mint)) {
          everSeenRef.current.gems.add(t.mint);
          addToast(`${t.symbol} gem found · MC ${fmtMcap(t) || "?"}`, "gems");
        }
      }
      for (const t of frontrunList) {
        if (!everSeenRef.current.frontrun.has(t.mint)) {
          everSeenRef.current.frontrun.add(t.mint);
          addToast(`${t.symbol} bundle detected · window ${fmtSecs(frontrunWindowSecs(t))}`, "frontrun");
        }
      }

      setAllTokens(raw);
      setLastScan(new Date());
      setScanCount(c => c + 1);
    } catch (e) {
      console.error(e);
      setError(e.message || "Scan failed");
    } finally {
      setLoading(false);
      scanLockRef.current = false;
    }
  }, [addToast]);

  useEffect(() => { scan(); }, [scan]);

  useEffect(() => {
    clearInterval(intervalRef.current);
    if (autoRefresh) intervalRef.current = setInterval(() => { if (visibleRef.current) scan(); }, 20000);
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, scan]);

  const { cleanTokens, gemsTokens, frontrunTokens } = useMemo(() => {
    let clean    = allTokens.filter(passesClean);
    let gems     = allTokens.filter(passesGems);
    let frontrun = allTokens.filter(passesFrontrun);
    if (narrative !== "ALL") {
      clean    = clean.filter(t => t.narrative === narrative);
      gems     = gems.filter(t => t.narrative === narrative);
      frontrun = frontrun.filter(t => t.narrative === narrative);
    }
    clean.sort((a, b)    => opportunityScore(b) - opportunityScore(a));
    gems.sort((a, b)     => opportunityScore(b) - opportunityScore(a));
    frontrun.sort((a, b) => (a.priceChange || 0) - (b.priceChange || 0));
    return { cleanTokens: clean, gemsTokens: gems, frontrunTokens: frontrun };
  }, [allTokens, narrative]);

  const displayed = tab === "clean" ? cleanTokens : tab === "gems" ? gemsTokens : frontrunTokens;

  const tabDescriptions = {
    clean:    "Fresh launches under 45min, MC $15K–$300K, bundle <55%, ≤6 insiders, no Jito. Sorted by opportunity score.",
    gems:     "Up to 24hrs old, MC $50K–$1M, bundle <40%, ≤4 insiders, no Jito. Coins with traction still under $1M. Sorted by opportunity.",
    frontrun: "Bundle confirmed but price under 40%. Get in before the pump. Most unpopped first. High risk — know your exit.",
  };

  return (
    <div style={{ minHeight:"100vh", background:theme.bg, fontFamily:"'Space Mono','Courier New',monospace", color:theme.text, paddingBottom:60 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-track{background:${theme.scrollBg}}
        ::-webkit-scrollbar-thumb{background:${theme.scrollThumb};border-radius:2px}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
        @keyframes slideIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.25}}
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>

      <Toast toasts={toasts} onDismiss={id => setToasts(t => t.filter(x => x.id !== id))} />

      {/* ── Header ── */}
      <div style={{ background:theme.bgHeader, borderBottom:`1px solid ${theme.border}`, padding:"16px 20px 12px", position:"sticky", top:0, zIndex:100, backdropFilter:"blur(10px)" }}>
        <div style={{ maxWidth:540, margin:"0 auto" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background:autoRefresh?"#00ff88":"#ff3b3b", animation:"pulse 1.5s infinite" }} />
                <span style={{ color:autoRefresh?"#00bb66":"#ff3b3b", fontSize:9, letterSpacing:2, fontWeight:700 }}>
                  {loading ? "SCANNING..." : autoRefresh ? "AUTO-LIVE" : "PUMP.FUN SCANNER"}
                </span>
              </div>
              <div style={{ fontSize:22, fontWeight:700, letterSpacing:-1, lineHeight:1.1, marginTop:2, color:theme.text }}>
                PUMP<span style={{ color:"#5bc0ff" }}>RADAR</span>
                <span style={{ color:theme.textFaint, fontSize:9, fontWeight:400, marginLeft:8, letterSpacing:2 }}>v3</span>
              </div>
            </div>
            <div style={{ textAlign:"right", display:"flex", flexDirection:"column", gap:4, alignItems:"flex-end" }}>
              <button onClick={() => setLightMode(m => !m)} style={{ background:lm?"#1a1a2a":"#f0f0e8", color:lm?"#aaa":"#555", border:"none", borderRadius:20, padding:"3px 10px", fontSize:8, fontWeight:900, cursor:"pointer", letterSpacing:1 }}>
                {lm ? "🌙 DARK" : "☀ LIGHT"}
              </button>
              {cleanTokens.length > 0 && <div style={{ background:"#001a0d", border:"1px solid #00ff8828", color:"#00ff88", fontSize:9, fontWeight:900, padding:"3px 10px", borderRadius:4, letterSpacing:1 }}>⚡ {cleanTokens.length} CLEAN</div>}
              {gemsTokens.length > 0  && <div style={{ background:"#1a1000", border:"1px solid #ffaa0028", color:"#ffaa00", fontSize:9, fontWeight:900, padding:"3px 10px", borderRadius:4, letterSpacing:1 }}>💎 {gemsTokens.length} GEMS</div>}
              {frontrunTokens.length > 0 && <div style={{ background:"#1a0000", border:"1px solid #ff3b3b28", color:"#ff6666", fontSize:9, fontWeight:700, padding:"3px 10px", borderRadius:4, letterSpacing:1 }}>🎯 {frontrunTokens.length} FRONTRUN</div>}
              {lastScan && <div style={{ color:theme.textFaint, fontSize:8 }}>#{scanCount} · {lastScan.toLocaleTimeString()}</div>}
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:540, margin:"0 auto", padding:"14px 16px 0" }}>

        {/* ── Controls ── */}
        <div style={{ background:theme.bgControl, border:`1px solid ${theme.border}`, borderRadius:10, padding:12, marginBottom:12 }}>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={scan} disabled={loading} style={{ flex:1, padding:"9px 0", borderRadius:6, border:"none", cursor:loading?"default":"pointer", background:loading?(lm?"#e0e0d8":"#0f0f20"):"linear-gradient(135deg,#5bc0ff18,#00ff8818)", color:loading?(lm?"#aaa":"#222"):"#00bb66", fontSize:10, fontWeight:900, letterSpacing:1 }}>
              {loading ? "⏳ SCANNING..." : "⚡ SCAN NOW"}
            </button>
            <button onClick={() => setAutoRefresh(a => !a)} style={{ padding:"9px 14px", borderRadius:6, border:"none", cursor:"pointer", background:autoRefresh?"#00ff8818":(lm?"#e0e0d8":"#0f0f20"), color:autoRefresh?"#00bb66":(lm?"#aaa":"#333"), fontSize:9, fontWeight:900, letterSpacing:1 }}>
              {autoRefresh ? "⏹ AUTO" : "▶ AUTO"}
            </button>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div style={{ background:"#160000", border:"1px solid #ff3b3b18", borderRadius:8, padding:"10px 14px", marginBottom:12, color:"#ff6666", fontSize:10, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span>⚠ {error}</span>
            <button onClick={() => setError(null)} style={{ background:"none", border:"none", color:"#ff6666", cursor:"pointer", fontSize:14, marginLeft:12 }}>✕</button>
          </div>
        )}

        {/* ── Tabs ── */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:12 }}>
          {[
            { key:"clean",    label:"✓ CLEAN",   ac:"#00ff88", bg:lm?"#e8fff4":"linear-gradient(135deg,#001a0d,#002a14)", cnt:cleanTokens.length,    cc:"#00ff8822", ct:"#00bb66" },
            { key:"gems",     label:"💎 GEMS",    ac:"#ffaa00", bg:lm?"#fff8e8":"linear-gradient(135deg,#1a1000,#2a1800)", cnt:gemsTokens.length,     cc:"#ffaa0022", ct:"#ffaa00" },
            { key:"frontrun", label:"🎯 FRONTRUN", ac:"#ff6666", bg:lm?"#fff0f0":"linear-gradient(135deg,#1a0000,#2a0500)", cnt:frontrunTokens.length, cc:"#ff444422", ct:"#ff6666" },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ padding:"10px 4px", borderRadius:8, border:"none", cursor:"pointer", background:tab===t.key?t.bg:(lm?"#efefea":"#090915"), color:tab===t.key?t.ac:(lm?"#aaa":"#333"), fontSize:8, fontWeight:900, letterSpacing:1, borderBottom:`2px solid ${tab===t.key?t.ac:"transparent"}`, transition:"all 0.2s" }}>
              {t.label}
              {t.cnt > 0 && <span style={{ marginLeft:5, background:t.cc, color:t.ct, fontSize:8, padding:"1px 5px", borderRadius:10 }}>{t.cnt}</span>}
            </button>
          ))}
        </div>

        {/* ── Tab description ── */}
        <div style={{ background:lm?"#f0f0e8":"#08080f", border:`1px solid ${theme.border}`, borderRadius:8, padding:"8px 12px", marginBottom:12 }}>
          <p style={{ color:theme.textDim, fontSize:9, lineHeight:1.7, letterSpacing:0.3 }}>{tabDescriptions[tab]}</p>
        </div>

        {/* ── Narrative filter ── */}
        <div style={{ display:"flex", gap:5, overflowX:"auto", marginBottom:12, scrollbarWidth:"none", msOverflowStyle:"none" }}>
          {["ALL","AI","MEME","TRUMP","DEPIN","GAMING","RWA"].map(n => (
            <button key={n} onClick={() => setNarrative(n)} style={{ flexShrink:0, padding:"4px 11px", borderRadius:20, border:"none", cursor:"pointer", background:narrative===n?"#cc88ff22":(lm?"#e8e8e0":"#0e0e1e"), color:narrative===n?"#cc88ff":(lm?"#888":"#333"), fontSize:8, fontWeight:900, letterSpacing:1.5 }}>{n}</button>
          ))}
        </div>

        {/* ── Token list ── */}
        {loading ? (
          <div style={{ textAlign:"center", padding:"60px 0", color:theme.textDim }}>
            <div style={{ display:"inline-block", width:34, height:34, border:`2px solid ${theme.border}`, borderTop:"2px solid #5bc0ff", borderRadius:"50%", animation:"spin 0.7s linear infinite" }} />
            <div style={{ marginTop:12, fontSize:10, letterSpacing:2 }}>SCANNING PUMP.FUN...</div>
          </div>
        ) : displayed.length === 0 ? (
          <div style={{ textAlign:"center", padding:"50px 20px" }}>
            <div style={{ color:theme.textDim, fontSize:11, letterSpacing:2, marginBottom:8 }}>
              {tab === "clean" ? "NO CLEAN TOKENS" : tab === "gems" ? "NO GEMS FOUND" : "NO FRONTRUN TARGETS"}
            </div>
            <div style={{ color:theme.textFaint, fontSize:9, lineHeight:1.9 }}>
              {tab === "clean" ? "All tokens failed safety filters. Scan again soon."
               : tab === "gems" ? "No coins in the $50K–$300K range right now. Try again shortly."
               : "No active bundle windows. Enable auto-refresh to catch them."}
            </div>
            <button onClick={scan} style={{ marginTop:16, padding:"8px 20px", borderRadius:6, border:`1px solid ${theme.border}`, background:"transparent", color:theme.textDim, fontSize:9, fontWeight:900, cursor:"pointer", letterSpacing:1 }}>SCAN AGAIN</button>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
            {tab === "frontrun"
              ? displayed.map((t, i) => <FrontrunCard key={t.mint} token={t} rank={i+1} lm={lm} />)
              : tab === "gems"
              ? displayed.map((t, i) => <GemCard key={t.mint} token={t} rank={i+1} lm={lm} />)
              : displayed.map((t, i) => <CleanCard key={t.mint} token={t} rank={i+1} lm={lm} />)
            }
          </div>
        )}

        <div style={{ marginTop:28, textAlign:"center", color:theme.textFaint, fontSize:8, letterSpacing:1.5, lineHeight:2.2 }}>
          PUMPRADAR v3 · LIVE VIA HELIUS + JUPITER<br/>
          RESEARCH ONLY · NOT FINANCIAL ADVICE · DYOR
        </div>
      </div>
    </div>
  );
}
