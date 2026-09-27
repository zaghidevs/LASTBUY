// Pure race logic: turning trades into leaders, clocks and finished races.
// No network calls here, so it can be tested on its own.

const WSOL = "So11111111111111111111111111111111111111112";

function newState(mint) {
  return {
    version: 1,
    mint,
    lastSig: null,          // newest trade signature already processed
    race: freshRace(1),
    toSettle: [],           // finished races waiting for payout
    pending: null,          // payout transaction in flight
    buys: [],               // recent qualifying buys (newest first)
    payouts: [],            // finished races (newest first)
    prizeLamports: 0,
    stats: { races: 0, paidLamports: 0 },
  };
}

function freshRace(number) {
  return { number, leader: null, leaderSig: null, start: null, deadline: null, lastBuyAt: null, buys: 0 };
}

// Read one transaction (RPC getTransaction, encoding "json") and return
// { wallet, lamports } if it is a buy of `mint`, otherwise null.
function classifyTx(tx, mint, excludeWallet) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys;
  const signer = typeof keys[0] === "string" ? keys[0] : keys[0].pubkey;
  if (signer === excludeWallet) return null;

  const sumFor = (list, m) => (list || [])
    .filter((b) => b.mint === m && b.owner === signer)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);

  const tokenDelta = sumFor(tx.meta.postTokenBalances, mint) - sumFor(tx.meta.preTokenBalances, mint);
  if (tokenDelta <= 0n) return null;

  const solSpent = BigInt(tx.meta.preBalances[0]) - BigInt(tx.meta.postBalances[0]) - BigInt(tx.meta.fee);
  const wsolSpent = sumFor(tx.meta.preTokenBalances, WSOL) - sumFor(tx.meta.postTokenBalances, WSOL);
  const lamports = solSpent + (wsolSpent > 0n ? wsolSpent : 0n);
  if (lamports <= 0n) return null;
  return { wallet: signer, lamports: Number(lamports) };
}

// Apply a qualifying buy at block time t (seconds). Returns true if it counted.
function applyBuy(state, cfg, buy) {
  if (buy.lamports < cfg.minBuyLamports) return false;
  let race = state.race;

  // A buy after the current race's deadline belongs to the next race.
  if (race.deadline !== null && buy.t > race.deadline) {
    endRace(state);
    race = state.race;
  }

  if (race.start === null) race.start = buy.t;
  const overCap = buy.t - race.start >= cfg.maxRaceSeconds;
  race.leader = buy.wallet;
  race.leaderSig = buy.sig;
  race.lastBuyAt = buy.t;
  race.deadline = buy.t + (overCap ? cfg.finalLapSeconds : cfg.clockSeconds);
  race.buys++;

  state.buys.unshift({ sig: buy.sig, wallet: buy.wallet, lamports: buy.lamports, t: buy.t, race: race.number });
  state.buys = state.buys.slice(0, 25);
  return true;
}

// Close the current race and queue it for payout; start the next one.
function endRace(state) {
  const r = state.race;
  if (r.leader) state.toSettle.push({ number: r.number, winner: r.leader, winningSig: r.leaderSig, deadline: r.deadline, buys: r.buys });
  state.race = freshRace(r.number + 1);
}

// Called on a timer after polling has caught up. Ends the race once the
// deadline has passed by more than `graceSeconds` (so late-indexed buys that
// landed before the deadline still count).
function checkDeadline(state, cfg, nowSec) {
  const r = state.race;
  if (r.deadline !== null && nowSec > r.deadline + cfg.graceSeconds) {
    endRace(state);
    return true;
  }
  return false;
}

// Is this transaction the prize wallet creating a coin on pump.fun?
// Returns the new coin's mint address, or null.
function detectCreatedMint(tx, creator, pumpProgram) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys;
  const signer = typeof keys[0] === "string" ? keys[0] : keys[0].pubkey;
  if (signer !== creator) return null;
  const logs = tx.meta.logMessages || [];
  if (!logs.some((l) => l.includes(pumpProgram)) || !logs.some((l) => /Instruction: Create/.test(l))) return null;
  const before = new Set((tx.meta.preTokenBalances || []).map((b) => b.mint));
  const created = [...new Set((tx.meta.postTokenBalances || []).map((b) => b.mint))].filter((m) => m !== WSOL && !before.has(m));
  return created.find((m) => m.endsWith("pump")) || created[0] || null;
}

module.exports = { detectCreatedMint, newState, freshRace, classifyTx, applyBuy, endRace, checkDeadline, WSOL };
