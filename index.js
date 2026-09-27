// LAST race bot + website.
// Watches every trade of one pump.fun coin, runs the race clock, claims the
// coin's creator fees into the prize wallet and pays each race's winner.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { loadKeypair, makeRpc, buildTransfer, signSerialized, sleep } = require("./lib/solana");
const R = require("./lib/race");

const LAMPORTS = 1e9;
const env = process.env;
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

const cfg = {
  rpcUrl: env.RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : ""),
  mint: (env.MINT || "").trim(),
  clockSeconds: num(env.CLOCK_SECONDS, 600),
  finalLapSeconds: num(env.FINAL_LAP_SECONDS, 60),
  maxRaceSeconds: num(env.MAX_RACE_SECONDS, 86400),
  minBuyLamports: Math.round(num(env.MIN_BUY_SOL, 0.1) * LAMPORTS),
  winnerShare: num(env.WINNER_SHARE, 0.9),
  reserveLamports: Math.round(num(env.RESERVE_SOL, 0.05) * LAMPORTS),
  graceSeconds: num(env.GRACE_SECONDS, 20),
  pollMs: num(env.POLL_MS, 2000),
  claimEverySeconds: num(env.CLAIM_EVERY_SECONDS, 300),
  dryRun: /^(1|true|yes)$/i.test(env.DRY_RUN || ""),
  dataDir: env.DATA_DIR || path.join(__dirname, "data"),
  port: num(env.PORT, 3000),
  xUrl: env.X_URL || "https://x.com/",
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sol = (l) => (l / LAMPORTS).toFixed(4);

// ---------- state ----------
fs.mkdirSync(cfg.dataDir, { recursive: true });
const STATE_FILE = path.join(cfg.dataDir, "state.json");
let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  // A fixed MINT always wins. Without one, keep the coin detected earlier.
  if (cfg.mint && state.mint !== cfg.mint) { log("MINT changed, starting fresh state"); state = R.newState(cfg.mint); }
  // MINT was removed after a test run: forget the test coin and wait for launch.
  if (!cfg.mint && state.mint && !state.detected) { log("MINT removed, clearing test data"); state = R.newState(null); }
} catch { state = R.newState(cfg.mint || null); }
function save() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- wallet + rpc ----------
let wallet = null;
try { if (env.PRIZE_WALLET_PRIVATE_KEY) wallet = loadKeypair(env.PRIZE_WALLET_PRIVATE_KEY); }
catch (e) { log("PRIZE_WALLET_PRIVATE_KEY is invalid:", e.message); }
const rpc = cfg.rpcUrl ? makeRpc(cfg.rpcUrl) : null;

const ready = !!(rpc && wallet);
const status = { ready, message: "", caughtUp: false, lastPollAt: 0, lastError: null };
if (!wallet) status.message = "Waiting for PRIZE_WALLET_PRIVATE_KEY";
else if (!rpc) status.message = "Waiting for HELIUS_API_KEY or RPC_URL";

// ---------- sending transactions ----------
async function sendAndConfirm(txBuf, signature, lastValidBlockHeight, force = false) {
  if (cfg.dryRun && !force) { log("[dry run] would send", signature); return "dry-run"; }
  const b64 = Buffer.from(txBuf).toString("base64");
  const send = () => rpc("sendTransaction", [b64, { encoding: "base64", skipPreflight: false, maxRetries: 0, preflightCommitment: "confirmed" }]);
  await send();
  for (let i = 0; ; i++) {
    await sleep(2000);
    const st = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
    const s = st.value[0];
    if (s && s.err) throw new Error("Transaction failed: " + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return "confirmed";
    if (lastValidBlockHeight) {
      const h = await rpc("getBlockHeight", [{ commitment: "confirmed" }]);
      if (h > lastValidBlockHeight) return "expired";
    } else if (i > 45) return "expired";
    if (i % 3 === 2) await send().catch(() => {}); // rebroadcast
  }
}

async function txLanded(signature) {
  const st = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  const s = st.value[0];
  return !!(s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"));
}

// ---------- claiming creator fees (PumpPortal local transaction) ----------
let lastClaimAt = 0;
async function claimFees() {
  lastClaimAt = Date.now();
  if (cfg.dryRun) { log("[dry run] would claim creator fees"); return; }
  try {
    const res = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: wallet.address, action: "collectCreatorFee", priorityFee: 0.00001, pool: "pump" }),
    });
    if (res.status !== 200) { log("Fee claim skipped:", res.status, (await res.text()).slice(0, 200)); return; }
    const { tx, signature } = signSerialized(new Uint8Array(await res.arrayBuffer()), wallet);
    const result = await sendAndConfirm(tx, signature);
    log("Fee claim", result, signature);
  } catch (e) {
    log("Fee claim failed (usually means nothing to claim):", e.message);
  }
}

async function refreshPrize() {
  const bal = await rpc("getBalance", [wallet.address, { commitment: "confirmed" }]);
  state.prizeLamports = Math.max(0, bal.value - cfg.reserveLamports);
  return bal.value;
}

// ---------- payouts ----------
let settling = false;
async function settleQueue() {
  if (settling) return;
  settling = true;
  try {
    // Resume a payout that was in flight when the bot last stopped.
    if (state.pending) await finishPending();
    while (state.toSettle.length) {
      const race = state.toSettle[0];
      log(`Race ${race.number} finished. Winner ${race.winner}`);
      await claimFees();
      const bal = await refreshPrize();
      const pot = bal - cfg.reserveLamports;
      const lamports = Math.floor(pot * cfg.winnerShare);
      if (lamports < 1_000_000) { // under 0.001 SOL: nothing worth sending
        recordPayout(race, 0, null, pot);
        continue;
      }
      await startPayout(race, lamports, pot);
      await finishPending();
    }
  } catch (e) {
    status.lastError = "Payout: " + e.message;
    log("Payout error, will retry:", e.message);
  } finally { settling = false; }
}

async function startPayout(race, lamports, pot) {
  const bh = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const { tx, signature } = buildTransfer({ payer: wallet, to: race.winner, lamports, blockhash: bh.value.blockhash });
  state.pending = { race: race.number, winner: race.winner, lamports, pot, signature, tx: tx.toString("base64"), lastValidBlockHeight: bh.value.lastValidBlockHeight };
  save(); // saved before sending so a restart can never pay twice
  log(`Paying ${sol(lamports)} SOL to ${race.winner} (race ${race.number}) sig ${signature}`);
}

async function finishPending() {
  const p = state.pending;
  if (!p) return;
  if (!cfg.dryRun && await txLanded(p.signature)) return donePending(p);
  const result = await sendAndConfirm(Buffer.from(p.tx, "base64"), p.signature, p.lastValidBlockHeight);
  if (result === "confirmed" || result === "dry-run") return donePending(p);
  // Blockhash expired without landing: double-check, then rebuild with a fresh one.
  if (await txLanded(p.signature)) return donePending(p);
  log("Payout expired without landing, rebuilding");
  const race = state.toSettle.find((r) => r.number === p.race);
  state.pending = null;
  await startPayout(race, p.lamports, p.pot);
  return finishPending();
}

function donePending(p) {
  const race = state.toSettle.find((r) => r.number === p.race);
  state.pending = null;
  recordPayout(race, p.lamports, p.signature, p.pot);
}

function recordPayout(race, lamports, signature, pot) {
  state.toSettle = state.toSettle.filter((r) => r.number !== race.number);
  if (cfg.dryRun) { save(); log(`[dry run] race ${race.number} would pay ${sol(lamports)} SOL to ${race.winner}`); return; }
  state.payouts.unshift({ race: race.number, winner: race.winner, winningSig: race.winningSig, lamports, signature, pot, buys: race.buys, t: Math.floor(Date.now() / 1000) });
  state.payouts = state.payouts.slice(0, 100);
  state.stats.races++;
  state.stats.paidLamports += lamports;
  save();
  log(`Race ${race.number} settled: ${sol(lamports)} SOL to ${race.winner}`);
}

// ---------- watching trades ----------
async function poll() {
  // First run: start from the newest trade, ignore history.
  if (!state.lastSig) {
    const latest = await rpc("getSignaturesForAddress", [state.mint, { limit: 1, commitment: "confirmed" }]);
    state.lastSig = latest[0] ? latest[0].signature : "none";
    save();
    log("Watching", state.mint, "from", state.lastSig);
    return;
  }

  // Collect every new signature since lastSig (newest first, paginated).
  let sigs = [], before;
  for (;;) {
    const opts = { limit: 1000, commitment: "confirmed" };
    if (state.lastSig !== "none") opts.until = state.lastSig;
    if (before) opts.before = before;
    const page = await rpc("getSignaturesForAddress", [state.mint, opts]);
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  if (!sigs.length) return;
  sigs.reverse(); // oldest first

  // Fetch in small parallel batches, apply strictly in order.
  for (let i = 0; i < sigs.length; i += 8) {
    const batch = sigs.slice(i, i + 8);
    const txs = await Promise.all(batch.map((s) => s.err ? null :
      rpc("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])));
    batch.forEach((s, k) => {
      const buy = R.classifyTx(txs[k], state.mint, wallet.address);
      if (buy) {
        const t = s.blockTime || (txs[k] && txs[k].blockTime) || Math.floor(Date.now() / 1000);
        if (R.applyBuy(state, cfg, { ...buy, sig: s.signature, t })) {
          log(`Race ${state.race.number}: ${buy.wallet} took the lead with ${sol(buy.lamports)} SOL`);
        }
      }
      state.lastSig = s.signature;
    });
    save();
  }
}

// ---------- launch detection ----------
// Without MINT, watch the prize wallet. The moment it creates a coin on
// pump.fun, that coin becomes $LAST and the race starts, including the very
// first snipers' buys.
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
async function waitForLaunch() {
  status.message = "Waiting for launch";
  log("No MINT set. Waiting for the prize wallet to create a coin on pump.fun...");
  const checked = new Set();
  for (;;) {
    try {
      const sigs = await rpc("getSignaturesForAddress", [wallet.address, { limit: 15, commitment: "confirmed" }]);
      for (const s of sigs) {
        if (s.err || checked.has(s.signature)) continue;
        checked.add(s.signature);
        const tx = await rpc("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
        const mint = R.detectCreatedMint(tx, wallet.address, PUMP_PROGRAM);
        if (mint) {
          state = R.newState(mint);
          state.lastSig = "none"; // read the coin's whole (seconds-long) history
          state.launchSig = s.signature;
          state.detected = true;
          save();
          status.message = "";
          log("Launch detected:", mint, "in", s.signature);
          return;
        }
      }
      status.lastPollAt = Date.now();
      await refreshPrize();
    } catch (e) { log("Launch watch error:", e.message); }
    await sleep(1500);
  }
}

// Sends 0.001 SOL to prove payouts work on mainnet before launch.
async function testPayout(to) {
  try {
    const bh = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const { tx, signature } = buildTransfer({ payer: wallet, to, lamports: 1_000_000, blockhash: bh.value.blockhash });
    const r = await sendAndConfirm(tx, signature, bh.value.lastValidBlockHeight, true);
    log(r === "confirmed" ? "TEST PAYOUT OK: 0.001 SOL sent to " + to + " https://solscan.io/tx/" + signature : "TEST PAYOUT DID NOT LAND (" + r + ")");
  } catch (e) { log("TEST PAYOUT FAILED:", e.message); }
}

async function loop() {
  if (!ready) { log("Not running:", status.message); return; }
  log(`LAST bot. Prize wallet ${wallet.address}.${cfg.dryRun ? " DRY RUN: no transactions will be sent." : ""}`);
  if (env.TEST_PAYOUT_TO) await testPayout(env.TEST_PAYOUT_TO.trim());
  if (!state.mint) await waitForLaunch();
  log("Race running for", state.mint);
  refreshPrize().catch(() => {});
  let lastPrize = 0;
  for (;;) {
    try {
      await poll();
      status.caughtUp = true;
      status.lastPollAt = Date.now();
      if (R.checkDeadline(state, cfg, Date.now() / 1000)) save();
      if (state.toSettle.length || state.pending) settleQueue();
      if (!settling && state.race.leader && Date.now() - lastClaimAt > cfg.claimEverySeconds * 1000) claimFees().then(refreshPrize).catch(() => {});
      if (Date.now() - lastPrize > 15000) { lastPrize = Date.now(); refreshPrize().catch(() => {}); }
      status.lastError = null;
    } catch (e) {
      status.lastError = e.message;
      log("Poll error:", e.message);
    }
    await sleep(cfg.pollMs);
  }
}

// ---------- website + API ----------
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function snapshot() {
  const r = state.race;
  return {
    now: Date.now() / 1000,
    mint: state.mint || null,
    prizeWallet: wallet ? wallet.address : null,
    xUrl: cfg.xUrl,
    rules: { clockSeconds: cfg.clockSeconds, minBuySol: cfg.minBuyLamports / LAMPORTS, winnerShare: cfg.winnerShare, finalLapSeconds: cfg.finalLapSeconds, maxRaceSeconds: cfg.maxRaceSeconds },
    status: { ready: status.ready, launched: !!state.mint, message: status.message, healthy: status.ready && Date.now() - status.lastPollAt < 30000, dryRun: cfg.dryRun },
    prizeSol: state.prizeLamports / LAMPORTS,
    race: { number: r.number, leader: r.leader, leaderSig: r.leaderSig, deadline: r.deadline, start: r.start, lastBuyAt: r.lastBuyAt, buys: r.buys },
    settling: state.toSettle.map((x) => x.number),
    buys: state.buys.slice(0, 10).map((b) => ({ ...b, sol: b.lamports / LAMPORTS })),
    payouts: state.payouts.slice(0, 20).map((p) => ({ ...p, sol: p.lamports / LAMPORTS })),
    stats: { races: state.stats.races, paidSol: state.stats.paidLamports / LAMPORTS },
  };
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/state") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify(snapshot()));
  }
  if (url.pathname === "/health") { res.writeHead(200); return res.end("ok"); }
  let p = url.pathname === "/" ? "/index.html" : url.pathname === "/docs" ? "/docs.html" : url.pathname;
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(cfg.port, () => log("Site on port", cfg.port));

loop();
