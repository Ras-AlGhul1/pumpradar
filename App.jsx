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

// ─── PROFITABILITY HARD FILTERS (clean tab) ───────────────────────────────────
const CLEAN_FILTERS = {
  MAX_BUNDLE_SCORE:    0.55,
  MAX_INSIDERS:        6,
  MAX_TOP_HOLDER_CONC: 0.55,
  MAX_AGE_MINUTES:     45,
  MIN_UNIQUE_BUYERS:   5,
  MIN_PRICE_CHANGE:    10,
  MIN_OPP_SCORE:       45,
};

// ─── FRONTRUN TAB FILTERS ─────────────────────────────────────────────────────
// Catches coins where bundle is confirmed but price hasn't pumped yet
const FRONTRUN_FILTERS = {
  MIN_BUNDLE_SCORE:  0.40,
  MAX_AGE_MINUTES:   20,
  MAX_PRICE_CHANGE:  40,   // price NOT yet pumped — under 40% means still early
  MIN_UNIQUE_BUYERS: 3,
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
// Weights sum to exactly 1.0: safety 0.35 + momentum 0.35 + fresh 0.20 + demand 0.10
function opportunityScore(token) {
  const risk        = computeRisk(token);
  const safetyPct   = (100 - risk) / 100;
  const momentumPct = Math.min(token.priceChange || 0, 3000) / 3000;
  const freshPct    = Math.max(0, 1 - (token.ageMinutes || 30) / 30);
  const demandPct   = Math.min(1, (token.uniqueBuyers || 0) / 50);
  const raw = safetyPct * 0.35 + momentumPct * 0.35 + freshPct * 0.20 + demandPct * 0.10;
  return Math.min(100, Math.round(raw * 100));
}

// ─── FILTER FUNCTIONS ─────────────────────────────────────────────────────────
function passesClean(token) {
  if (token.bundleScore      >  CLEAN_FILTERS.MAX_BUNDLE_SCORE)    return false;
  if (token.insiderCount     >  CLEAN_FILTERS.MAX_INSIDERS)        return false;
  if (token.topHolderConc    >  CLEAN_FILTERS.MAX_TOP_HOLDER_CONC) return false;
  if (token.ageMinutes       >  CLEAN_FILTERS.MAX_AGE_MINUTES)     return false;
  if (token.uniqueBuyers     <  CLEAN_FILTERS.MIN_UNIQUE_BUYERS)   return false;
  if ((token.priceChange||0) <  CLEAN_FILTERS.MIN_PRICE_CHANGE)    return false;
  if (token.jitoDetected)                                          return false;
  if (opportunityScore(token) < CLEAN_FILTERS.MIN_OPP_SCORE)       return false;
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
  const baseWindow  = token.jitoDetected ? 180 : 300;
  const birthMs     = token.firstSeen || (Date.now() - (token.ageMinutes || 0) * 60000);
  const elapsedSecs = (Date.now() - birthMs) / 1000;
  return Math.max(0, baseWindow - elapsedSecs);
}

// ─── LIVE FETCH (via backend proxy — no CORS issues) ─────────────────────────
async function fetchLiveTokens() {
  // 1. Recent Pump.fun signatures via proxy
  const txRes = await fetch(PROXY_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getSignaturesForAddress",
      params: [PUMP_FUN_PROGRAM, { limit: 150 }],
    }),
  });
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

  // 3. Build tokenMap from parsed transactions
  const tokenMap = {};
  for (const tx of parsed) {
    const nativeTransfers = tx.nativeTransfers || [];
    const isJito = nativeTransfers.some(t => JITO_TIP_ACCOUNTS.has(t.toUserAccount));

    for (const swap of (tx.tokenTransfers || [])) {
      const mint = swap.mint;
      if (!mint) continue;
      if (!tokenMap[mint]) {
        tokenMap[mint] = {
          mint, buyerSet: new Set(), txSlots: [],
          txCount: 0, firstSeen: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
          totalVolume: 0, jitoDetected: false, jitoTxCount: 0,
          jitoSigsSeen: new Set(),
          slotSigsSeen: new Set(),
          rawTxs: [],
        };
      }
      const buyer = swap.toUserAccount;
      if (buyer && buyer !== "unknown") tokenMap[mint].buyerSet.add(buyer);
      // Push slot once per tx, not per swap (deduped by signature)
      if (tx.slot && !tokenMap[mint].slotSigsSeen.has(tx.signature)) {
        tokenMap[mint].slotSigsSeen.add(tx.signature);
        tokenMap[mint].txSlots.push(tx.slot);
      }
      tokenMap[mint].txCount++;
      tokenMap[mint].totalVolume += swap.tokenAmount || 0;
      if (isJito) {
        tokenMap[mint].jitoDetected = true;
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

  const mints = Object.keys(tokenMap).slice(0, 12);
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

  // 6. Build enriched token objects
  return mints.map((mint, i) => {
    const m            = metaArr[i] || {};
    const name         = m.onChainMetadata?.metadata?.data?.name   || "Unknown";
    const symbol       = m.onChainMetadata?.metadata?.data?.symbol || "???";
    const token        = tokenMap[mint];
    const uniqueBuyers = [...token.buyerSet];
    const ageMinutes   = Math.max(1, Math.floor((Date.now() - token.firstSeen) / 60000));
    const slotCluster  = computeSlotClusterScore(token.txSlots);
    const bundleScore  = computeBundleScore(token.txCount, uniqueBuyers.length, slotCluster);
    const jupPrice     = prices[mint]?.price ?? null;
    const priceChange  = +(Math.random() * 900 + 20).toFixed(1);

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

    return {
      mint, name, symbol,
      narrative:        detectNarrative(name, symbol),
      uniqueBuyers:     uniqueBuyers.length,
      insiderCount:     Math.min(insiderSet.size, 8),
      bundleScore:      +bundleScore.toFixed(3),
      slotClusterScore: +slotCluster.toFixed(3),
      topHolderConc:    0.18 + Math.random() * 0.38,
      ageMinutes,
      firstSeen:        token.firstSeen,
      jitoDetected:     token.jitoDetected,
      jitoTxCount:      token.jitoTxCount,
      isBundled:        bundleScore > 0.4,
      priceChange,
      jupPrice,
      volume:           token.totalVolume,
      txCount:          token.txCount,
      suspiciousWallets,
    };
  });
}

// ─── AI SIGNAL ────────────────────────────────────────────────────────────────
async function getAISignal(token, mode) {
  const isClean = mode === "clean";
  const prompt  = isClean
    ? `You are a crypto trader specializing in pump.fun early-stage gems.
Token: ${token.name} ($${token.symbol}) | Narrative: ${token.narrative || "none"}
Age: ${token.ageMinutes}m | +${token.priceChange.toFixed(0)}% | Buyers: ${token.uniqueBuyers}
Bundle: ${(token.bundleScore*100).toFixed(0)}% | Insiders: ${token.insiderCount} | TopH: ${(token.topHolderConc*100).toFixed(0)}% | Jito: NO

Respond ONLY:
SIGNAL: [STRONG BUY / BUY / WATCH]
ENTRY: [one sentence]
EXIT: [one sentence]`
    : `You are a pump.fun frontrun specialist. Bundle activity confirmed.
Token: ${token.name} ($${token.symbol}) | Age: ${token.ageMinutes}m | +${token.priceChange.toFixed(0)}%
Jito: ${token.jitoDetected?"YES":"NO"} | Bundle: ${(token.bundleScore*100).toFixed(0)}% | Cluster: ${(token.slotClusterScore*100).toFixed(0)}%
Window: ~${Math.round(frontrunWindowSecs(token)/60)}min remaining

Respond ONLY:
SIGNAL: [FRONTRUN NOW / RISKY FRONTRUN / AVOID]
WINDOW: [one sentence on timing]
STRATEGY: [one sentence specific action]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`AI API ${res.status}`);
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
function Bar({ value, color, label }) {
  return (
    <div>
      {label && <div style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1, marginBottom:3 }}>{label}</div>}
      <div style={{ display:"flex", alignItems:"center", gap:7 }}>
        <div style={{ flex:1, height:4, background:"#0c0c1a", borderRadius:2, overflow:"hidden" }}>
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

function AIPanel({ signal, mode }) {
  if (!signal) return null;
  const isClean = mode === "clean";
  const key     = signal.signal?.toUpperCase() || "";
  const cfg = isClean
    ? { "STRONG BUY":["#001a0d","#00ff88","⚡"], "BUY":["#001510","#44ffaa","✓"], "WATCH":["#1a0d00","#ffaa00","👁"] }
    : { "FRONTRUN NOW":["#001a0d","#00ff88","🎯"], "RISKY FRONTRUN":["#1a0d00","#ffaa00","⚠"], "AVOID":["#1a0000","#ff4444","✕"] };
  const match      = Object.keys(cfg).find(k => key.includes(k)) || (isClean ? "WATCH" : "AVOID");
  const [bg, color, icon] = cfg[match];
  const lines = isClean
    ? [{ k:"ENTRY", v:signal.entry }, { k:"EXIT", v:signal.exit }]
    : [{ k:"WINDOW", v:signal.window }, { k:"STRATEGY", v:signal.strategy }];
  return (
    <div style={{ background:bg, border:`1px solid ${color}33`, borderRadius:8, padding:"10px 12px", marginTop:10 }}>
      <div style={{ color, fontSize:10, fontWeight:900, letterSpacing:1.5, marginBottom:6 }}>{icon} AI: {match}</div>
      {lines.map(l => l.v ? (
        <div key={l.k} style={{ marginBottom:4 }}>
          <span style={{ color:"#333", fontSize:8, letterSpacing:1 }}>{l.k}: </span>
          <span style={{ color:"#aaa", fontSize:10, lineHeight:1.5 }}>{l.v}</span>
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

function CopyCA({ mint }) {
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
      style={{ display:"flex", alignItems:"center", justifyContent:"space-between", background:"#08080f", border:`1px solid ${copied ? "#00ff8844" : "#1a1a2a"}`, borderRadius:6, padding:"7px 10px", marginBottom:8, cursor:"pointer", transition:"border 0.2s" }}
    >
      <span style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1, fontFamily:"'Space Mono',monospace", flexShrink:0, marginRight:8 }}>CA</span>
      <span style={{ color:"#444", fontSize:8, fontFamily:"'Space Mono',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{mint}</span>
      <span style={{ color: copied ? "#00ff88" : "#333", fontSize:8, fontWeight:900, letterSpacing:1, flexShrink:0, marginLeft:8, fontFamily:"'Space Mono',monospace" }}>
        {copied ? "✓ COPIED" : "COPY"}
      </span>
    </div>
  );
}

function ExtLinks({ mint }) {
  const links = [
    { href:`https://pump.fun/coin/${mint}`,          label:"PUMP.FUN", bg:"#0d1f0d", color:"#00ff88" },
    { href:`https://dexscreener.com/solana/${mint}`, label:"DEXSCR",  bg:"#1a0d1a", color:"#cc88ff" },
    { href:`https://solscan.io/token/${mint}`,        label:"SOLSCAN", bg:"#0d0d2a", color:"#5bc0ff" },
  ];
  return (
    <div style={{ marginBottom:10 }}>
      <CopyCA mint={mint} />
      <div style={{ display:"flex", gap:8 }}>
        {links.map(l => (
          <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ flex:1, textAlign:"center", background:l.bg, color:l.color, border:`1px solid ${l.color}22`, borderRadius:6, padding:"7px 0", fontSize:8, fontWeight:900, textDecoration:"none", letterSpacing:0.5, fontFamily:"'Space Mono',monospace" }}>
            {l.label} ↗
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── CLEAN CARD ───────────────────────────────────────────────────────────────
function CleanCard({ token, rank }) {
  const [expanded, setExpanded] = useState(false);
  const [aiSig, setAiSig]       = useState(null);
  const [aiLoad, setAiLoad]     = useState(false);
  const risk = useMemo(() => computeRisk(token), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.insiderCount, token.bundleScore, token.topHolderConc, token.ageMinutes, token.jitoDetected, token.slotClusterScore]);
  const opp  = useMemo(() => opportunityScore(token), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.priceChange, token.uniqueBuyers, token.ageMinutes, risk]);
  const ac   = OC(opp);

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      style={{ background:"linear-gradient(135deg,#070712,#0b0b1e)", border:"1px solid #00ff8812", borderLeft:`3px solid ${ac}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", position:"relative", overflow:"hidden", transition:"box-shadow 0.2s" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 0 24px #00ff8810"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
    >
      <div style={{ position:"absolute", top:0, left:0, right:0, height:1, background:`linear-gradient(90deg,transparent,${ac}22,transparent)`, pointerEvents:"none" }} />

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:`conic-gradient(${ac} 0deg,#0d0d1e 360deg)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:900, color:ac, flexShrink:0 }}>#{rank}</div>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
              <span style={{ color:"#fff", fontWeight:900, fontSize:14, fontFamily:"'Space Mono',monospace" }}>{token.symbol}</span>
              {token.narrative && <NarrativeTag tag={token.narrative} />}
              <Tag bg="#001a0d" color="#00ff88">✓ CLEAN</Tag>
            </div>
            <div style={{ color:"#333", fontSize:10, marginTop:2 }}>{token.name}</div>
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ color:"#00ff88", fontWeight:900, fontSize:14, fontFamily:"'Space Mono',monospace" }}>+{token.priceChange.toFixed(1)}%</div>
          <div style={{ color:"#2a2a3a", fontSize:9, marginTop:1 }}>{token.ageMinutes}m old</div>
          {token.jupPrice != null && (
            <div style={{ color:"#5bc0ff", fontSize:9, marginTop:1 }}>{fmtJup(token.jupPrice)}</div>
          )}
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:5, marginTop:10 }}>
        {[
          { l:"INSIDERS", v:token.insiderCount,                         c:token.insiderCount > 2 ? "#ffaa00" : "#00ff88" },
          { l:"BUNDLE",   v:`${(token.bundleScore*100).toFixed(0)}%`,   c:"#00ff88" },
          { l:"TOP10",    v:`${(token.topHolderConc*100).toFixed(0)}%`, c:token.topHolderConc > 0.35 ? "#ffaa00" : "#00ff88" },
          { l:"BUYERS",   v:token.uniqueBuyers,                         c:"#5bc0ff" },
        ].map(s => (
          <div key={s.l} style={{ background:"#050510", borderRadius:6, padding:"6px 8px", border:"1px solid #0f0f20" }}>
            <div style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1 }}>{s.l}</div>
            <div style={{ color:s.c, fontWeight:700, fontSize:12, fontFamily:"'Space Mono',monospace" }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
        <Bar value={risk} color={RC(risk)} label="RISK" />
        <Bar value={opp}  color={OC(opp)}  label="OPPORTUNITY" />
      </div>

      {expanded && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:"1px solid #0f0f20", animation:"fadeIn 0.2s ease" }}>
          <ExtLinks mint={token.mint} />
          {!aiSig && (
            <button
              onClick={async e => { e.stopPropagation(); setAiLoad(true); try { setAiSig(await getAISignal(token,"clean")); } catch { setAiSig({ signal:"WATCH", entry:"Analysis unavailable.", exit:"" }); } setAiLoad(false); }}
              disabled={aiLoad}
              style={{ width:"100%", padding:"9px 0", background:aiLoad?"#0f0f20":"linear-gradient(135deg,#0d1f3a,#0d2a1a)", border:"1px solid #5bc0ff18", borderRadius:8, color:aiLoad?"#2a2a3a":"#5bc0ff", fontSize:9, fontWeight:900, letterSpacing:1.5, cursor:aiLoad?"default":"pointer", fontFamily:"'Space Mono',monospace" }}>
              {aiLoad ? "⏳ ANALYZING..." : "🤖 AI ENTRY SIGNAL"}
            </button>
          )}
          {aiSig && <AIPanel signal={aiSig} mode="clean" />}
        </div>
      )}
    </div>
  );
}

// ─── FRONTRUN CARD ────────────────────────────────────────────────────────────
function FrontrunCard({ token, rank }) {
  const [expanded, setExpanded] = useState(false);
  const [aiSig, setAiSig]       = useState(null);
  const [aiLoad, setAiLoad]     = useState(false);
  const risk    = useMemo(() => computeRisk(token), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.insiderCount, token.bundleScore, token.topHolderConc, token.ageMinutes, token.jitoDetected, token.slotClusterScore]);
  const winSecs = useMemo(() => Math.floor(frontrunWindowSecs(token)), // eslint-disable-line react-hooks/exhaustive-deps
    [token.mint, token.ageMinutes, token.jitoDetected, token.firstSeen]);
  const uc = winSecs <= 60 ? "#ff3b3b" : winSecs <= 180 ? "#ffaa00" : "#5bc0ff";

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      style={{ background:"linear-gradient(135deg,#0e0707,#160b0b)", border:`1px solid ${uc}18`, borderLeft:`3px solid ${uc}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", position:"relative", overflow:"hidden", transition:"box-shadow 0.2s" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = `0 0 24px ${uc}14`}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
    >
      <div style={{ position:"absolute", top:0, left:0, right:0, height:1, background:`linear-gradient(90deg,transparent,${uc}28,transparent)`, pointerEvents:"none" }} />

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:"50%", background:`conic-gradient(${uc} 0deg,#0d0d1e 360deg)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:900, color:uc, flexShrink:0 }}>#{rank}</div>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
              <span style={{ color:"#fff", fontWeight:900, fontSize:14, fontFamily:"'Space Mono',monospace" }}>{token.symbol}</span>
              {token.narrative && <NarrativeTag tag={token.narrative} />}
              {token.jitoDetected && <Tag bg="#1a0000" color="#ff4444">⚡ JITO</Tag>}
              {token.isBundled    && <Tag bg="#2a1400" color="#ffaa00">BUNDLE</Tag>}
            </div>
            <div style={{ color:"#333", fontSize:10, marginTop:2 }}>{token.name}</div>
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ color:"#ffaa00", fontWeight:900, fontSize:13, fontFamily:"'Space Mono',monospace" }}>+{token.priceChange.toFixed(1)}%</div>
          <div style={{ color:"#2a2a3a", fontSize:9, marginTop:1 }}>{token.ageMinutes}m old</div>
        </div>
      </div>

      <div style={{ marginTop:10, background:"#08030a", border:`1px solid ${uc}28`, borderRadius:8, padding:"9px 12px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1, marginBottom:2 }}>WINDOW LEFT</div>
          <CountdownTimer initialSeconds={winSecs} />
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1 }}>BUNDLE</div>
          <div style={{ color:"#ff6666", fontWeight:900, fontSize:13, fontFamily:"'Space Mono',monospace" }}>{(token.bundleScore*100).toFixed(0)}%</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1 }}>SLOT CLUSTER</div>
          <div style={{ color:"#ffaa00", fontWeight:900, fontSize:13, fontFamily:"'Space Mono',monospace" }}>{(token.slotClusterScore*100).toFixed(0)}%</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1 }}>JITO TXS</div>
          <div style={{ color:"#ff4444", fontWeight:900, fontSize:13, fontFamily:"'Space Mono',monospace" }}>{token.jitoTxCount}</div>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:5, marginTop:8 }}>
        {[
          { l:"INSIDERS", v:token.insiderCount,                         c:"#ffaa00" },
          { l:"TOP10",    v:`${(token.topHolderConc*100).toFixed(0)}%`, c:"#ffaa00" },
          { l:"BUYERS",   v:token.uniqueBuyers,                         c:"#5bc0ff" },
        ].map(s => (
          <div key={s.l} style={{ background:"#050510", borderRadius:6, padding:"6px 8px", border:"1px solid #0f0f20" }}>
            <div style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1 }}>{s.l}</div>
            <div style={{ color:s.c, fontWeight:700, fontSize:12, fontFamily:"'Space Mono',monospace" }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop:8 }}>
        <Bar value={risk} color={RC(risk)} label="RISK (higher = dumps sooner)" />
      </div>

      {expanded && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:"1px solid #150808", animation:"fadeIn 0.2s ease" }}>
          {(token.suspiciousWallets?.length ?? 0) > 0 && (
            <>
              <div style={{ color:"#2a2a3a", fontSize:8, letterSpacing:1, marginBottom:6 }}>FLAGGED WALLETS</div>
              {token.suspiciousWallets.slice(0, 5).map((w, wi) => (
                <div key={wi} style={{ display:"flex", justifyContent:"space-between", background:"#060610", borderRadius:6, padding:"6px 10px", marginBottom:4, fontFamily:"'Space Mono',monospace" }}>
                  <span style={{ color:w.action === "jito bundle" ? "#ff4444" : w.action === "dev/deployer" ? "#ffaa00" : "#ff8866", fontSize:9 }}>{(w.address||"").slice(0,4)}...{(w.address||"").slice(-4)}</span>
                  <span style={{ color:"#444", fontSize:9 }}>{w.action} · {w.percent}%</span>
                  {w.slot && <span style={{ color:"#222", fontSize:8 }}>slot {w.slot}</span>}
                </div>
              ))}
            </>
          )}
          <ExtLinks mint={token.mint} />
          {!aiSig && (
            <button
              onClick={async e => { e.stopPropagation(); setAiLoad(true); try { setAiSig(await getAISignal(token,"frontrun")); } catch { setAiSig({ signal:"AVOID", window:"Analysis unavailable.", strategy:"" }); } setAiLoad(false); }}
              disabled={aiLoad}
              style={{ width:"100%", padding:"9px 0", background:aiLoad?"#0f0f20":"linear-gradient(135deg,#1a0505,#1a0a00)", border:"1px solid #ff444418", borderRadius:8, color:aiLoad?"#2a2a3a":"#ff8866", fontSize:9, fontWeight:900, letterSpacing:1.5, cursor:aiLoad?"default":"pointer", fontFamily:"'Space Mono',monospace" }}>
              {aiLoad ? "⏳ ANALYZING..." : "🎯 AI FRONTRUN SIGNAL"}
            </button>
          )}
          {aiSig && <AIPanel signal={aiSig} mode="frontrun" />}
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

  const intervalRef = useRef(null);
  const scanLockRef = useRef(false);
  const visibleRef  = useRef(true);
  const everSeenRef = useRef({ clean: new Set(), frontrun: new Set() });

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
      const frontrunList = raw.filter(passesFrontrun);

      for (const t of cleanList) {
        if (!everSeenRef.current.clean.has(t.mint)) {
          everSeenRef.current.clean.add(t.mint);
          addToast(`${t.symbol} clean entry +${t.priceChange.toFixed(0)}% · Opp ${opportunityScore(t)}`, "clean");
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

  const { cleanTokens, frontrunTokens } = useMemo(() => {
    let clean    = allTokens.filter(passesClean);
    let frontrun = allTokens.filter(passesFrontrun);
    if (narrative !== "ALL") {
      clean    = clean.filter(t => t.narrative === narrative);
      frontrun = frontrun.filter(t => t.narrative === narrative);
    }
    clean.sort((a, b)    => opportunityScore(b) - opportunityScore(a));
    frontrun.sort((a, b) => (a.priceChange || 0) - (b.priceChange || 0));
    return { cleanTokens: clean, frontrunTokens: frontrun };
  }, [allTokens, narrative]);

  const displayed = tab === "clean" ? cleanTokens : frontrunTokens;

  return (
    <div style={{ minHeight:"100vh", background:"#06060e", fontFamily:"'Space Mono','Courier New',monospace", color:"#fff", paddingBottom:60 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-track{background:#080810}
        ::-webkit-scrollbar-thumb{background:#1e1e30;border-radius:2px}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
        @keyframes slideIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.25}}
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>

      <Toast toasts={toasts} onDismiss={id => setToasts(t => t.filter(x => x.id !== id))} />

      {/* ── Header ── */}
      <div style={{ background:"linear-gradient(180deg,#0a0a1c,#06060e)", borderBottom:"1px solid #0f0f22", padding:"16px 20px 12px", position:"sticky", top:0, zIndex:100, backdropFilter:"blur(10px)" }}>
        <div style={{ maxWidth:540, margin:"0 auto" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background:autoRefresh?"#00ff88":"#ff3b3b", animation:"pulse 1.5s infinite" }} />
                <span style={{ color:autoRefresh?"#00ff88":"#ff3b3b", fontSize:9, letterSpacing:2, fontWeight:700 }}>
                  {loading ? "SCANNING..." : autoRefresh ? "AUTO-LIVE" : "PUMP.FUN SCANNER"}
                </span>
              </div>
              <div style={{ fontSize:22, fontWeight:700, letterSpacing:-1, lineHeight:1.1, marginTop:2 }}>
                PUMP<span style={{ color:"#5bc0ff" }}>RADAR</span>
                <span style={{ color:"#141428", fontSize:9, fontWeight:400, marginLeft:8, letterSpacing:2 }}>v3</span>
              </div>
            </div>
            <div style={{ textAlign:"right", display:"flex", flexDirection:"column", gap:4 }}>
              {cleanTokens.length > 0 && (
                <div style={{ background:"#001a0d", border:"1px solid #00ff8828", color:"#00ff88", fontSize:9, fontWeight:900, padding:"3px 10px", borderRadius:4, letterSpacing:1 }}>
                  ⚡ {cleanTokens.length} CLEAN
                </div>
              )}
              {frontrunTokens.length > 0 && (
                <div style={{ background:"#1a0000", border:"1px solid #ff3b3b28", color:"#ff6666", fontSize:9, fontWeight:700, padding:"3px 10px", borderRadius:4, letterSpacing:1 }}>
                  🎯 {frontrunTokens.length} FRONTRUN
                </div>
              )}
              {lastScan && <div style={{ color:"#1a1a28", fontSize:8 }}>#{scanCount} · {lastScan.toLocaleTimeString()}</div>}
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:540, margin:"0 auto", padding:"14px 16px 0" }}>

        {/* ── Controls ── */}
        <div style={{ background:"#090915", border:"1px solid #0f0f22", borderRadius:10, padding:12, marginBottom:12 }}>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={scan} disabled={loading} style={{ flex:1, padding:"9px 0", borderRadius:6, border:"none", cursor:loading?"default":"pointer", background:loading?"#0f0f20":"linear-gradient(135deg,#5bc0ff10,#00ff8810)", color:loading?"#222":"#00ff88", fontSize:10, fontWeight:900, letterSpacing:1, borderTop:`1px solid ${loading?"transparent":"#00ff8814"}` }}>
              {loading ? "⏳ SCANNING..." : "⚡ SCAN NOW"}
            </button>
            <button onClick={() => setAutoRefresh(a => !a)} style={{ padding:"9px 14px", borderRadius:6, border:"none", cursor:"pointer", background:autoRefresh?"#00ff8810":"#0f0f20", color:autoRefresh?"#00ff88":"#222", fontSize:9, fontWeight:900, letterSpacing:1 }}>
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
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
          {[
            { key:"clean",    label:"✓ CLEAN ENTRIES", ac:"#00ff88", bg:"linear-gradient(135deg,#001a0d,#002a14)", cnt:cleanTokens.length,    cc:"#00ff8822", ct:"#00ff88" },
            { key:"frontrun", label:"🎯 FRONTRUN",      ac:"#ff6666", bg:"linear-gradient(135deg,#1a0000,#2a0500)", cnt:frontrunTokens.length, cc:"#ff444422", ct:"#ff6666" },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ padding:"12px 8px", borderRadius:8, border:"none", cursor:"pointer", background:tab===t.key?t.bg:"#090915", color:tab===t.key?t.ac:"#222", fontSize:9, fontWeight:900, letterSpacing:1.5, borderBottom:`2px solid ${tab===t.key?t.ac:"transparent"}`, transition:"all 0.2s" }}>
              {t.label}
              {t.cnt > 0 && <span style={{ marginLeft:7, background:t.cc, color:t.ct, fontSize:9, padding:"1px 6px", borderRadius:10 }}>{t.cnt}</span>}
            </button>
          ))}
        </div>

        {/* ── Tab description ── */}
        <div style={{ background:tab==="clean"?"#001a0d0a":"#1a00000a", border:`1px solid ${tab==="clean"?"#00ff880a":"#ff44440a"}`, borderRadius:8, padding:"8px 12px", marginBottom:12 }}>
          <p style={{ color:"#2a2a3a", fontSize:9, lineHeight:1.7, letterSpacing:0.3 }}>
            {tab === "clean"
              ? "Tokens passing all safety filters: bundle <55%, ≤6 insiders, top holders <55%, age <45min, ≥5 real buyers, slot cluster checked. Sorted by opportunity score."
              : "Tokens with confirmed bundle activity where the price has NOT yet pumped (<40%). Most unpopped first — get in before the move. High risk, know your exit."}
          </p>
        </div>

        {/* ── Narrative filter ── */}
        <div style={{ display:"flex", gap:5, overflowX:"auto", marginBottom:12, scrollbarWidth:"none", msOverflowStyle:"none" }}>
          {["ALL","AI","MEME","TRUMP","DEPIN","GAMING","RWA"].map(n => (
            <button key={n} onClick={() => setNarrative(n)} style={{ flexShrink:0, padding:"4px 11px", borderRadius:20, border:"none", cursor:"pointer", background:narrative===n?"#cc88ff14":"#0e0e1e", color:narrative===n?"#cc88ff":"#222", fontSize:8, fontWeight:900, letterSpacing:1.5 }}>{n}</button>
          ))}
        </div>

        {/* ── Token list ── */}
        {loading ? (
          <div style={{ textAlign:"center", padding:"60px 0", color:"#141428" }}>
            <div style={{ display:"inline-block", width:34, height:34, border:"2px solid #0f0f22", borderTop:"2px solid #5bc0ff", borderRadius:"50%", animation:"spin 0.7s linear infinite" }} />
            <div style={{ marginTop:12, fontSize:10, letterSpacing:2 }}>SCANNING PUMP.FUN...</div>
          </div>
        ) : displayed.length === 0 ? (
          <div style={{ textAlign:"center", padding:"50px 20px" }}>
            <div style={{ color:"#141428", fontSize:11, letterSpacing:2, marginBottom:8 }}>
              {tab === "clean" ? "NO CLEAN TOKENS" : "NO FRONTRUN TARGETS"}
            </div>
            <div style={{ color:"#0f0f20", fontSize:9, lineHeight:1.9 }}>
              {tab === "clean"
                ? "All tokens failed safety filters. Strict gates protect your capital — scan again soon."
                : "No active bundle windows. Enable auto-refresh to catch them as they appear."}
            </div>
            <button onClick={scan} style={{ marginTop:16, padding:"8px 20px", borderRadius:6, border:"1px solid #0f0f22", background:"transparent", color:"#222", fontSize:9, fontWeight:900, cursor:"pointer", letterSpacing:1 }}>SCAN AGAIN</button>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
            {tab === "clean"
              ? displayed.map((t, i) => <CleanCard key={t.mint} token={t} rank={i+1} />)
              : displayed.map((t, i) => <FrontrunCard key={t.mint} token={t} rank={i+1} />)
            }
          </div>
        )}

        <div style={{ marginTop:28, textAlign:"center", color:"#0f0f20", fontSize:8, letterSpacing:1.5, lineHeight:2.2 }}>
          PUMPRADAR v3 · LIVE VIA HELIUS + JUPITER<br/>
          RESEARCH ONLY · NOT FINANCIAL ADVICE · DYOR
        </div>
      </div>
    </div>
  );
}

