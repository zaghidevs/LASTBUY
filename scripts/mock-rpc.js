// Fake Solana RPC for an end-to-end test of the bot (never used in production).
const http = require("http");
const MINT = process.env.MINT;
const sigs = []; // newest first
const txs = {};
let balance = 3e9, sent = [];
let n = 0; const started = Date.now();
function addBuy(wallet, lamports) {
  const sig = "sig" + (++n) + "x".repeat(10);
  const t = Math.floor(Date.now() / 1000);
  sigs.unshift({ signature: sig, slot: n, blockTime: t, err: null });
  txs[sig] = { blockTime: t, meta: { err: null, fee: 5000, preBalances: [5e9], postBalances: [5e9 - lamports - 5000],
    preTokenBalances: [], postTokenBalances: [{ mint: MINT, owner: wallet, uiTokenAmount: { amount: "1000" } }] },
    transaction: { message: { accountKeys: [wallet] } } };
  balance += Math.floor(lamports * 0.01);
}
module.exports = { addBuy };
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body);
    let result;
    if (method === "getSignaturesForAddress") {
      const o = params[1] || {};
      if (params[0] !== MINT) { // prize wallet: shows the launch after 2s
        result = Date.now() - started > 2000 ? [{ signature: "createSig", slot: 0, blockTime: 1, err: null }] : [];
        return res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      }
      let list = sigs;
      if (o.until) { const i = list.findIndex((s) => s.signature === o.until); list = i < 0 ? list : list.slice(0, i); }
      result = list.slice(0, o.limit || 1000);
    } else if (method === "getTransaction") result = params[0] === "createSig"
      ? { meta: { err: null, logMessages: ["Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]", "Program log: Instruction: Create"], preTokenBalances: [], postTokenBalances: [{ mint: MINT, owner: "curve", uiTokenAmount: { amount: "1" } }] }, transaction: { message: { accountKeys: [process.env.PRIZE] } } }
      : txs[params[0]];
    else if (method === "getBalance") result = { value: balance };
    else if (method === "getLatestBlockhash") result = { value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000 } };
    else if (method === "sendTransaction") {
      const tx = Buffer.from(params[0], "base64");
      const msg = tx.subarray(65);
      const lamports = Number(msg.readBigUInt64LE(msg.length - 8));
      const { b58encode } = require("../lib/solana");
      sent.push({ sig: b58encode(tx.subarray(1, 65)), to: b58encode(msg.subarray(36, 68)), lamports });
      balance -= lamports;
      console.log("MOCK sent", lamports / 1e9, "SOL to", b58encode(msg.subarray(36, 68)));
      result = b58encode(tx.subarray(1, 65));
    } else if (method === "getSignatureStatuses") result = { value: params[0].map((s) => sent.find((x) => x.sig === s) ? { confirmationStatus: "confirmed", err: null } : null) };
    else if (method === "getBlockHeight") result = 10;
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
}).listen(8899);
// scenario
const A = "AAAAbuyerwallet1111111111111111111111111111", B = "BBBBbuyerwallet1111111111111111111111111111";
setTimeout(() => addBuy("5eyo7oVHtZPWqKT1ivT1h2Dv5TB4eHxDzGTbCp9vTLRD", 3e8), 1000);
setTimeout(() => addBuy("9WzDXwBbmkg8ZTbNMqUxvphRAnEPRSMPk1k2P6VGAkh8", 5e7), 3000); // too small
setTimeout(() => addBuy("9WzDXwBbmkg8ZTbNMqUxvphRAnEPRSMPk1k2P6VGAkh8", 2e8), 4000);
