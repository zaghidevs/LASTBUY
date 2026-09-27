// Minimal Solana helpers with zero dependencies: base58, keypairs, RPC, and
// building/signing the two kinds of transactions this bot sends.
const crypto = require("crypto");

// ---------- base58 ----------
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = Object.fromEntries([...ALPHA].map((c, i) => [c, i]));

function b58encode(buf) {
  const bytes = [...buf];
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHA[d]).join("");
}

function b58decode(str) {
  const bytes = [];
  for (const c of str) {
    if (!(c in MAP)) throw new Error("Invalid base58 character");
    let carry = MAP[c];
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

// ---------- keypair ----------
// Accepts a base58 secret key (Phantom/Solflare export, 64 bytes) or a JSON
// array of 64 numbers (Solana CLI keypair file).
function loadKeypair(secret) {
  secret = String(secret || "").trim();
  let bytes;
  if (secret.startsWith("[")) bytes = Buffer.from(JSON.parse(secret));
  else bytes = b58decode(secret);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("Private key must be 64 bytes (got " + bytes.length + ")");
  const seed = bytes.subarray(0, 32);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = spki.subarray(spki.length - 32);
  if (bytes.length === 64 && !bytes.subarray(32).equals(publicKey)) throw new Error("Private key doesn't match its public key");
  return {
    publicKey,
    address: b58encode(publicKey),
    sign: (msg) => crypto.sign(null, msg, privateKey),
  };
}

// ---------- RPC ----------
function makeRpc(url) {
  let id = 0;
  async function call(method, params = []) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        if (res.status === 429 || res.status >= 500) throw new Error("RPC HTTP " + res.status);
        const json = await res.json();
        if (json.error) {
          const e = new Error(method + ": " + json.error.message);
          e.rpc = json.error;
          throw e;
        }
        return json.result;
      } catch (e) {
        if (e.rpc || attempt >= 4) throw e;
        await sleep(400 * 2 ** attempt);
      }
    }
  }
  return call;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- transaction encoding ----------
function shortvec(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n) { out.push(b | 0x80); } else { out.push(b); return Buffer.from(out); }
  }
}
function readShortvec(buf, off) {
  let n = 0, shift = 0, len = 0;
  for (;;) {
    const b = buf[off + len++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [n, len];
    shift += 7;
  }
}

const SYSTEM_PROGRAM = Buffer.alloc(32); // 11111111111111111111111111111111
const COMPUTE_BUDGET = b58decode("ComputeBudget111111111111111111111111111111");

// Legacy transaction: SOL transfer from payer to `to`, with a priority fee.
function buildTransfer({ payer, to, lamports, blockhash, microLamports = 50000 }) {
  const toKey = b58decode(to);
  if (toKey.length !== 32) throw new Error("Bad recipient address");
  if (toKey.equals(payer.publicKey)) throw new Error("Refusing to pay the prize wallet itself");
  // accounts: [payer (signer, writable), to (writable), system (ro), compute budget (ro)]
  const keys = [payer.publicKey, toKey, SYSTEM_PROGRAM, COMPUTE_BUDGET];
  const header = Buffer.from([1, 0, 2]);

  const limitData = Buffer.alloc(5); limitData[0] = 2; limitData.writeUInt32LE(3000, 1);
  const priceData = Buffer.alloc(9); priceData[0] = 3; priceData.writeBigUInt64LE(BigInt(microLamports), 1);
  const xferData = Buffer.alloc(12); xferData.writeUInt32LE(2, 0); xferData.writeBigUInt64LE(BigInt(lamports), 4);

  const ix = (prog, accts, data) => Buffer.concat([Buffer.from([prog]), shortvec(accts.length), Buffer.from(accts), shortvec(data.length), data]);
  const message = Buffer.concat([
    header,
    shortvec(keys.length), ...keys,
    b58decode(blockhash),
    shortvec(3),
    ix(3, [], limitData),
    ix(3, [], priceData),
    ix(2, [0, 1], xferData),
  ]);
  return signMessage(message, payer, 1);
}

function signMessage(message, payer, numSigs) {
  const sig = payer.sign(message);
  const sigs = [sig];
  for (let i = 1; i < numSigs; i++) sigs.push(Buffer.alloc(64));
  const tx = Buffer.concat([shortvec(numSigs), ...sigs, message]);
  return { tx, signature: b58encode(sig) };
}

// Sign a serialized (legacy or v0) transaction where `payer` is the first signer.
function signSerialized(txBytes, payer) {
  const buf = Buffer.from(txBytes);
  const [numSigs, len] = readShortvec(buf, 0);
  const sigStart = len;
  const message = buf.subarray(sigStart + numSigs * 64);
  // Check the first account key in the message is our payer.
  let off = 0;
  if (message[0] & 0x80) off = 1; // versioned prefix
  off += 3; // header
  const [, klen] = readShortvec(message, off);
  const firstKey = message.subarray(off + klen, off + klen + 32);
  if (!Buffer.from(firstKey).equals(payer.publicKey)) throw new Error("Transaction fee payer is not the prize wallet");
  const sig = payer.sign(message);
  sig.copy(buf, sigStart);
  return { tx: buf, signature: b58encode(sig) };
}

module.exports = { b58encode, b58decode, loadKeypair, makeRpc, buildTransfer, signSerialized, sleep, readShortvec };
