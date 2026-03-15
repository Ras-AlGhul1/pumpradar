import fetch from 'node-fetch';
import http from 'http';

// Dummy HTTP server to satisfy Render's port requirement
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('PumpRadar bot is running')).listen(PORT, () => {
  console.log(`Health check server on port ${PORT}`);
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID     = process.env.TELEGRAM_OWNER_ID || '1050266367';
const HELIUS_KEY   = process.env.HELIUS_API_KEY || '30ec2243-f612-45e5-a461-408e71dd50df';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const SCAN_INTERVAL_MS = 20000; // 20 seconds

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── PUMP.FUN CONSTANTS ───────────────────────────────────────────────────────
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_SUPPLY      = 1_000_000_000;
const SOL_PRICE_USD    = 150;
const PUMP_VIRTUAL_SOL    = 30;
const PUMP_VIRTUAL_TOKENS = 1_073_000_000;

const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzoperd53oBV7GkS3CJFeMxhj3E5b',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

const EXCLUDED_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'So11111111111111111111111111111111111111111',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
]);

// ─── FILTERS ──────────────────────────────────────────────────────────────────
const CLEAN_FILTERS = {
  MAX_BUNDLE_SCORE: 0.55, MAX_INSIDERS: 6, MAX_AGE_MINUTES: 45,
  MIN_UNIQUE_BUYERS: 2,   MIN_OPP_SCORE: 35,
  MIN_MCAP_USD: 15_000,   MAX_MCAP_USD: 300_000,
};
const GEMS_FILTERS = {
  MAX_AGE_MINUTES: 1440, MIN_OPP_SCORE: 35,
  MIN_MCAP_USD: 50_000,  MAX_MCAP_USD: 1_000_000,
};
const FRONTRUN_FILTERS = {
  MIN_BUNDLE_SCORE: 0.40, MAX_AGE_MINUTES: 30,
  MAX_PRICE_CHANGE: 40,   MIN_UNIQUE_BUYERS: 2,
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const priceHistory  = {};
const seenTokens    = { clean: new Set(), gems: new Set(), frontrun: new Set() };
let   autoScan      = false;
let   scanTimer     = null;
let   lastOffset    = 0;

// ─── HELIUS HELPERS ───────────────────────────────────────────────────────────
async function heliusRpc(method, params) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  return data.result;
}

async function heliusTx(sigs) {
  const res = await fetch(`https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: sigs }),
  });
  return res.json();
}

async function heliusMeta(mints) {
  const res = await fetch(`https://api.helius.xyz/v0/token-metadata/?api-key=${HELIUS_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mintAccounts: mints, includeOffChain: true }),
  });
  return res.json();
}

async function jupiterPrice(mints) {
  try {
    const res = await fetch(`https://price.jup.ag/v4/price?ids=${mints.join(',')}`);
    const data = await res.json();
    return data.data || {};
  } catch { return {}; }
}

// ─── SCORING ──────────────────────────────────────────────────────────────────
function computeSlotClusterScore(txSlots = []) {
  if (!txSlots.length) return 0;
  const counts = {};
  for (const s of txSlots) counts[s] = (counts[s] || 0) + 1;
  return Math.min(1, (Math.max(...Object.values(counts)) / txSlots.length) * 1.6);
}

function computeBundleScore(txCount, uniqueBuyerCount, slotCluster) {
  if (uniqueBuyerCount === 0) return 1;
  const ratio    = txCount / uniqueBuyerCount;
  const rawRatio = Math.min(1, Math.max(0, (ratio - 1) / 4));
  const scale    = Math.max(0.2, 1 - Math.log10(Math.max(1, uniqueBuyerCount)) / 3);
  return Math.min(1, rawRatio * scale * 0.6 + slotCluster * 0.4);
}

function computeRisk(t) {
  let s = 0;
  if (t.insiderCount > 5) s += 35; else if (t.insiderCount > 3) s += 22; else if (t.insiderCount > 1) s += 12;
  if (t.bundleScore > 0.65) s += 35; else if (t.bundleScore > 0.4) s += 20; else if (t.bundleScore > 0.2) s += 10;
  if (t.jitoDetected) s += 40;
  if ((t.slotClusterScore || 0) > 0.7) s += 15; else if ((t.slotClusterScore || 0) > 0.4) s += 8;
  return Math.min(s, 100);
}

function opportunityScore(t) {
  const risk      = computeRisk(t);
  const safetyPct = (100 - risk) / 100;
  const freshPct  = Math.max(0, 1 - (t.ageMinutes || 30) / 30);
  const demandPct = Math.min(1, (t.uniqueBuyers || 0) / 20);
  return Math.min(100, Math.round((safetyPct * 0.50 + freshPct * 0.30 + demandPct * 0.20) * 100));
}

function estimatePrice(totalVolume, totalSolVolume) {
  if (!totalVolume) return null;
  const price = ((PUMP_VIRTUAL_SOL + (totalSolVolume || 0)) * SOL_PRICE_USD) / PUMP_VIRTUAL_TOKENS;
  return price > 0 ? price : null;
}

function getMcap(t) {
  const price = t.jupPrice ?? t.estimatedPrice ?? null;
  return price != null ? price * PUMP_SUPPLY : null;
}

function fmtMcap(t) {
  const mc = getMcap(t);
  if (!mc) return null;
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(1)}M`;
  if (mc >= 1_000)     return `$${(mc / 1_000).toFixed(1)}K`;
  return `$${mc.toFixed(0)}`;
}

function recordPrice(mint, price) {
  if (price == null) return;
  if (!priceHistory[mint]) priceHistory[mint] = { firstPrice: price };
  else priceHistory[mint].lastPrice = price;
}

function getPriceChange(mint, price) {
  if (price == null) return 0;
  const h = priceHistory[mint];
  if (!h || !h.firstPrice) return 0;
  return +((( price - h.firstPrice) / h.firstPrice) * 100).toFixed(1);
}

// ─── DAUMEN CHECKS ────────────────────────────────────────────────────────────
function daumenChecks(t) {
  const freshWalletScore   = Math.min(1, (t.rawTxs?.slice(0,5).filter(x=>x.buyer).length || 0) / Math.max(1, t.uniqueBuyers));
  const hasFreshWallets    = freshWalletScore > 0.4 && t.uniqueBuyers >= 2;
  const avgSolPerBuyer     = (t.totalSolVolume || 0) / Math.max(1, t.uniqueBuyers);
  const meetsBalance       = avgSolPerBuyer >= 0.3;
  const currentMcap        = getMcap(t);
  const hasEntry           = currentMcap != null;
  const holdWindowOpen     = t.ageMinutes < (t.ageMinutes < 10 ? 20 : t.ageMinutes < 30 ? 15 : 10);
  const passes             = hasFreshWallets && meetsBalance && hasEntry && holdWindowOpen;
  return { hasFreshWallets, meetsBalance, avgSolPerBuyer, hasEntry, holdWindowOpen, passes, currentMcap };
}

// ─── FILTERS ──────────────────────────────────────────────────────────────────
function passesClean(t) {
  if (t.bundleScore   > CLEAN_FILTERS.MAX_BUNDLE_SCORE)  return false;
  if (t.insiderCount  > CLEAN_FILTERS.MAX_INSIDERS)      return false;
  if (t.ageMinutes    > CLEAN_FILTERS.MAX_AGE_MINUTES)   return false;
  if (t.uniqueBuyers  < CLEAN_FILTERS.MIN_UNIQUE_BUYERS) return false;
  if (t.jitoDetected)                                    return false;
  if (opportunityScore(t) < CLEAN_FILTERS.MIN_OPP_SCORE) return false;
  const mc = getMcap(t);
  if (mc != null && mc < CLEAN_FILTERS.MIN_MCAP_USD)     return false;
  if (mc != null && mc > CLEAN_FILTERS.MAX_MCAP_USD)     return false;
  return true;
}

function passesGems(t) {
  const mc = getMcap(t);
  if (mc == null)                                       return false;
  if (mc < GEMS_FILTERS.MIN_MCAP_USD)                  return false;
  if (mc > GEMS_FILTERS.MAX_MCAP_USD)                  return false;
  if (t.ageMinutes > GEMS_FILTERS.MAX_AGE_MINUTES)     return false;
  if (opportunityScore(t) < GEMS_FILTERS.MIN_OPP_SCORE) return false;
  return true;
}

function passesFrontrun(t) {
  if (t.bundleScore    < FRONTRUN_FILTERS.MIN_BUNDLE_SCORE)  return false;
  if (t.ageMinutes     > FRONTRUN_FILTERS.MAX_AGE_MINUTES)   return false;
  if ((t.priceChange||0) > FRONTRUN_FILTERS.MAX_PRICE_CHANGE) return false;
  if (t.uniqueBuyers   < FRONTRUN_FILTERS.MIN_UNIQUE_BUYERS)  return false;
  return true;
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scanTokens() {
  const sigs = await heliusRpc('getSignaturesForAddress', [PUMP_FUN_PROGRAM, { limit: 100 }]);
  if (!Array.isArray(sigs) || !sigs.length) throw new Error('No signatures returned');

  const parsed = await heliusTx(sigs.slice(0, 25).map(s => s.signature));
  if (!Array.isArray(parsed)) throw new Error('Invalid tx response');
  const validTxs = parsed.filter(tx => tx && tx.signature && !tx.error);

  const tokenMap = {};
  for (const tx of validTxs) {
    const nativeTransfers = tx.nativeTransfers || [];
    const isJito   = nativeTransfers.some(t => JITO_TIP_ACCOUNTS.has(t.toUserAccount));
    const solMoved = nativeTransfers.reduce((s, t) => s + (t.amount || 0), 0) / 1e9;

    for (const swap of (tx.tokenTransfers || [])) {
      const mint = swap.mint;
      if (!mint || EXCLUDED_MINTS.has(mint)) continue;
      if (!tokenMap[mint]) {
        tokenMap[mint] = {
          mint, buyerSet: new Set(), txSlots: [], rawTxs: [],
          txCount: 0, firstSeen: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
          totalVolume: 0, totalSolVolume: 0, bundleVolumeSol: 0,
          jitoDetected: false, jitoTxCount: 0,
          jitoSigsSeen: new Set(), slotSigsSeen: new Set(), bundleVolSigsSeen: new Set(),
        };
      }
      const t = tokenMap[mint];
      const buyer = swap.toUserAccount;
      if (buyer && buyer !== 'unknown') t.buyerSet.add(buyer);
      if (tx.slot && !t.slotSigsSeen.has(tx.signature)) {
        t.slotSigsSeen.add(tx.signature);
        t.txSlots.push(tx.slot);
      }
      t.txCount++;
      t.totalVolume += swap.tokenAmount || 0;
      t.totalSolVolume += nativeTransfers
        .filter(x => !JITO_TIP_ACCOUNTS.has(x.toUserAccount))
        .reduce((s, x) => s + (x.amount || 0), 0) / 1e9;
      if (isJito) {
        t.jitoDetected = true;
        if (!t.bundleVolSigsSeen.has(tx.signature)) {
          t.bundleVolSigsSeen.add(tx.signature);
          t.bundleVolumeSol += solMoved;
        }
        if (!t.jitoSigsSeen.has(tx.signature)) {
          t.jitoSigsSeen.add(tx.signature);
          t.jitoTxCount++;
        }
      }
      t.rawTxs.push({ sig: tx.signature, slot: tx.slot, buyer, isJito, amount: swap.tokenAmount || 0, timestamp: tx.timestamp });
    }
  }

  const mints = Object.keys(tokenMap)
    .filter(m => {
      const t = tokenMap[m];
      if (t.jitoDetected && t.bundleVolumeSol < 1000 / SOL_PRICE_USD) return false;
      return true;
    })
    .slice(0, 25);

  if (!mints.length) throw new Error('No token mints found');

  const [metaArr, prices] = await Promise.all([
    heliusMeta(mints),
    jupiterPrice(mints),
  ]);

  const metaByMint = {};
  for (let i = 0; i < mints.length; i++) {
    const meta = Array.isArray(metaArr) ? metaArr[i] : null;
    if (meta?.account) metaByMint[meta.account] = meta;
    else if (meta) metaByMint[mints[i]] = meta;
  }

  return mints.map(mint => {
    const raw           = tokenMap[mint];
    const m             = metaByMint[mint] || {};
    const name          = m.onChainMetadata?.metadata?.data?.name   || 'Unknown';
    const symbol        = m.onChainMetadata?.metadata?.data?.symbol || '???';
    const uniqueBuyers  = [...raw.buyerSet];
    const ageMinutes    = Math.max(1, Math.floor((Date.now() - raw.firstSeen) / 60000));
    const slotCluster   = computeSlotClusterScore(raw.txSlots);
    const bundleScore   = computeBundleScore(raw.txCount, uniqueBuyers.length, slotCluster);
    const jupPrice      = prices[mint]?.price ?? null;
    const estimatedPrice = jupPrice ?? estimatePrice(raw.totalVolume, raw.totalSolVolume);
    recordPrice(mint, jupPrice ?? estimatedPrice);
    const priceChange   = getPriceChange(mint, jupPrice ?? estimatedPrice);

    const sortedTxs = [...raw.rawTxs].filter(t => t.timestamp != null).sort((a,b) => a.timestamp - b.timestamp);
    const allTxs    = [...raw.rawTxs];
    const earlyBuyers = new Set(sortedTxs.slice(0,3).map(t=>t.buyer).filter(Boolean));
    const jitoSenders = new Set(allTxs.filter(t=>t.isJito).map(t=>t.buyer).filter(Boolean));
    const insiderSet  = new Set([...earlyBuyers, ...jitoSenders]);

    return {
      mint, name, symbol, uniqueBuyers: uniqueBuyers.length,
      insiderCount: Math.min(insiderSet.size, 8),
      bundleScore: +bundleScore.toFixed(3),
      slotClusterScore: +slotCluster.toFixed(3),
      ageMinutes, firstSeen: raw.firstSeen,
      jitoDetected: raw.jitoDetected, jitoTxCount: raw.jitoTxCount,
      isBundled: bundleScore > 0.4,
      priceChange, jupPrice, estimatedPrice,
      volume: raw.totalVolume, txCount: raw.txCount,
      totalSolVolume: raw.totalSolVolume,
      rawTxs: raw.rawTxs,
    };
  });
}

// ─── MESSAGE FORMATTING ───────────────────────────────────────────────────────
function formatToken(t, type) {
  const mc      = fmtMcap(t) || 'unknown';
  const risk    = computeRisk(t);
  const opp     = opportunityScore(t);
  const daumen  = daumenChecks(t);
  const d1 = daumen.meetsBalance    ? '✅' : '❌';
  const d2 = daumen.hasFreshWallets ? '🌿' : '❌';
  const d3 = daumen.hasEntry        ? '✅' : '❌';
  const d4 = daumen.holdWindowOpen  ? '✅' : '❌';
  const daumenBadge = daumen.passes ? '🌿 DAUMEN PASS' : '⚠️ partial';

  const typeHeader = type === 'clean'
    ? '⚡ *CLEAN ENTRY*'
    : type === 'gems'
    ? '💎 *GEM FOUND*'
    : '🎯 *FRONTRUN ALERT*';

  const targetMc  = daumen.currentMcap ? fmtMcap({ estimatedPrice: (daumen.currentMcap * 2.5) / PUMP_SUPPLY }) : '—';
  const stopMc    = daumen.currentMcap ? fmtMcap({ estimatedPrice: (daumen.currentMcap * 0.75) / PUMP_SUPPLY }) : '—';

  return `${typeHeader} ${daumenBadge}

*${t.symbol}* — ${t.name}
💰 MC: ${mc} | 📈 +${t.priceChange.toFixed(1)}% | ⏱ ${t.ageMinutes}m

📊 *Metrics*
• Bundle: ${(t.bundleScore*100).toFixed(0)}% | Insiders: ${t.insiderCount}
• Buyers: ${t.uniqueBuyers} | Risk: ${risk}/100 | Opp: ${opp}/100
${t.jitoDetected ? '⚡ JITO DETECTED\n' : ''}
🎯 *Daumen Checks*
${d1} Balance (${daumen.avgSolPerBuyer.toFixed(2)} SOL avg)
${d2} Fresh Wallets
${d3} Entry: ${mc} → TP: ${targetMc} | SL: ${stopMc}
${d4} Hold Window: ${t.ageMinutes < 20 ? 'OPEN' : 'CLOSING'}

\`${t.mint}\`
[pump.fun](https://pump.fun/coin/${t.mint}) | [DexScreener](https://dexscreener.com/solana/${t.mint}) | [Solscan](https://solscan.io/token/${t.mint})`;
}

// ─── TELEGRAM API ─────────────────────────────────────────────────────────────
async function sendMessage(chatId, text, extra = {}) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...extra,
    }),
  });
}

async function getUpdates() {
  const res = await fetch(`${TG_API}/getUpdates?offset=${lastOffset}&timeout=5`);
  const data = await res.json();
  return data.ok ? data.result : [];
}

// ─── AUTO SCAN LOOP ───────────────────────────────────────────────────────────
async function runScan(chatId, silent = false) {
  if (!silent) await sendMessage(chatId, '🔍 Scanning pump\\.fun\\.\\.\\.');
  try {
    const tokens      = await scanTokens();
    const cleanList   = tokens.filter(passesClean);
    const gemsList    = tokens.filter(passesGems);
    const frontrunList = tokens.filter(passesFrontrun);

    let newFound = 0;

    for (const t of cleanList) {
      if (!seenTokens.clean.has(t.mint)) {
        seenTokens.clean.add(t.mint);
        await sendMessage(chatId, formatToken(t, 'clean'));
        newFound++;
      }
    }
    for (const t of gemsList) {
      if (!seenTokens.gems.has(t.mint)) {
        seenTokens.gems.add(t.mint);
        await sendMessage(chatId, formatToken(t, 'gems'));
        newFound++;
      }
    }
    for (const t of frontrunList) {
      if (!seenTokens.frontrun.has(t.mint)) {
        seenTokens.frontrun.add(t.mint);
        await sendMessage(chatId, formatToken(t, 'frontrun'));
        newFound++;
      }
    }

    if (!silent && newFound === 0) {
      await sendMessage(chatId,
        `✅ Scan complete — no new signals\\.\n` +
        `Clean: ${cleanList.length} | Gems: ${gemsList.length} | Frontrun: ${frontrunList.length}`
      );
    }

    return { cleanList, gemsList, frontrunList };
  } catch (e) {
    if (!silent) await sendMessage(chatId, `⚠️ Scan failed: ${e.message}`);
    return null;
  }
}

function startAutoScan(chatId) {
  if (scanTimer) clearInterval(scanTimer);
  autoScan = true;
  scanTimer = setInterval(() => runScan(chatId, true), SCAN_INTERVAL_MS);
}

function stopAutoScan() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  autoScan  = false;
}

// ─── COMMAND HANDLER ──────────────────────────────────────────────────────────
async function handleCommand(chatId, text) {
  const cmd = text.trim().toLowerCase().split(' ')[0];

  // Security — only owner can use bot
  if (String(chatId) !== String(OWNER_ID)) {
    await sendMessage(chatId, '⛔ Unauthorized.');
    return;
  }

  switch (cmd) {
    case '/start':
    case '/help':
      await sendMessage(chatId,
        `🚀 *PumpRadar Bot*\n\n` +
        `*Commands:*\n` +
        `/scan — scan now and show all signals\n` +
        `/clean — show clean entries only\n` +
        `/gems — show gems only\n` +
        `/frontrun — show frontrun targets only\n` +
        `/autoon — start auto\\-scanning every 20s\n` +
        `/autooff — stop auto\\-scanning\n` +
        `/status — show current status\n` +
        `/reset — clear seen tokens cache\n` +
        `/help — show this message\n\n` +
        `Auto\\-scan sends alerts the moment a new signal appears\\.`
      );
      break;

    case '/scan':
      await runScan(chatId, false);
      break;

    case '/clean': {
      await sendMessage(chatId, '🔍 Fetching clean entries\\.\\.\\.');
      try {
        const tokens = await scanTokens();
        const list   = tokens.filter(passesClean);
        if (!list.length) { await sendMessage(chatId, '😴 No clean entries right now\\.'); break; }
        for (const t of list.slice(0, 5)) await sendMessage(chatId, formatToken(t, 'clean'));
      } catch (e) { await sendMessage(chatId, `⚠️ ${e.message}`); }
      break;
    }

    case '/gems': {
      await sendMessage(chatId, '🔍 Fetching gems\\.\\.\\.');
      try {
        const tokens = await scanTokens();
        const list   = tokens.filter(passesGems);
        if (!list.length) { await sendMessage(chatId, '😴 No gems right now\\.'); break; }
        for (const t of list.slice(0, 5)) await sendMessage(chatId, formatToken(t, 'gems'));
      } catch (e) { await sendMessage(chatId, `⚠️ ${e.message}`); }
      break;
    }

    case '/frontrun': {
      await sendMessage(chatId, '🔍 Fetching frontrun targets\\.\\.\\.');
      try {
        const tokens = await scanTokens();
        const list   = tokens.filter(passesFrontrun);
        if (!list.length) { await sendMessage(chatId, '😴 No frontrun targets right now\\.'); break; }
        for (const t of list.slice(0, 5)) await sendMessage(chatId, formatToken(t, 'frontrun'));
      } catch (e) { await sendMessage(chatId, `⚠️ ${e.message}`); }
      break;
    }

    case '/autoon':
      startAutoScan(chatId);
      await sendMessage(chatId, '✅ Auto-scan started. You will be notified instantly when signals appear.');
      break;

    case '/autooff':
      stopAutoScan();
      await sendMessage(chatId, '⏹ Auto\\-scan stopped\\.');
      break;

    case '/status':
      await sendMessage(chatId,
        `📊 *Status*\n\n` +
        `Auto\\-scan: ${autoScan ? '🟢 ON' : '🔴 OFF'}\n` +
        `Seen clean: ${seenTokens.clean.size}\n` +
        `Seen gems: ${seenTokens.gems.size}\n` +
        `Seen frontrun: ${seenTokens.frontrun.size}`
      );
      break;

    case '/reset':
      seenTokens.clean.clear();
      seenTokens.gems.clear();
      seenTokens.frontrun.clear();
      await sendMessage(chatId, '🔄 Cache cleared\\. All tokens are fresh again\\.');
      break;

    default:
      await sendMessage(chatId, `❓ Unknown command\\. Type /help for the list\\.`);
  }
}

// ─── POLLING LOOP ─────────────────────────────────────────────────────────────
async function poll() {
  console.log('PumpRadar bot started, polling for updates...');
  await sendMessage(OWNER_ID, '🚀 PumpRadar bot is online\\! Type /help to get started\\.');

  while (true) {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        lastOffset = update.update_id + 1;
        const msg = update.message;
        if (msg?.text) {
          await handleCommand(msg.chat.id, msg.text);
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

poll();
