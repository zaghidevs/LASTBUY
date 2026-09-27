// Offline checks: node test.js
const assert = require("assert");
const crypto = require("crypto");
const S = require("./lib/solana");
const R = require("./lib/race");

// base58
assert.strictEqual(S.b58encode(Buffer.alloc(32)), "11111111111111111111111111111111");
assert.strictEqual(S.b58decode("ComputeBudget111111111111111111111111111111").length, 32);
const rnd = crypto.randomBytes(32);
assert.ok(S.b58decode(S.b58encode(rnd)).equals(rnd));

// keypair from a Phantom-style 64-byte secret
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const kp = S.loadKeypair(S.b58encode(Buffer.concat([seed, pub])));
assert.ok(kp.publicKey.equals(pub));
const kp2 = S.loadKeypair(JSON.stringify([...seed, ...pub]));
assert.strictEqual(kp2.address, kp.address);
assert.throws(() => S.loadKeypair(S.b58encode(Buffer.concat([seed, crypto.randomBytes(32)]))));

// transfer transaction: structure + valid signature
const to = S.b58encode(crypto.randomBytes(32));
const bh = S.b58encode(crypto.randomBytes(32));
const { tx, signature } = S.buildTransfer({ payer: kp, to, lamports: 123456789, blockhash: bh });
assert.strictEqual(tx[0], 1);
const msg = tx.subarray(65);
assert.ok(crypto.verify(null, msg, publicKey, tx.subarray(1, 65)));
assert.strictEqual(S.b58encode(tx.subarray(1, 65)), signature);
assert.deepStrictEqual([...msg.subarray(0, 3)], [1, 0, 2]);
assert.strictEqual(msg[3], 4);
assert.ok(msg.subarray(4, 36).equals(kp.publicKey));
assert.strictEqual(S.b58encode(msg.subarray(36, 68)), to);
assert.strictEqual(S.b58encode(msg.subarray(132, 164)), bh);
assert.ok(tx.length < 1232);
assert.throws(() => S.buildTransfer({ payer: kp, to: kp.address, lamports: 1, blockhash: bh }));

// signSerialized: v0 tx with 1 empty signature, payer first
const v0msg = Buffer.concat([Buffer.from([0x80, 1, 0, 1, 2]), kp.publicKey, Buffer.alloc(32), Buffer.alloc(32), Buffer.from([0, 0])]);
const unsigned = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), v0msg]);
const signed = S.signSerialized(unsigned, kp);
assert.ok(crypto.verify(null, v0msg, publicKey, signed.tx.subarray(1, 65)));
const badmsg = Buffer.from(v0msg); crypto.randomBytes(32).copy(badmsg, 5);
assert.throws(() => S.signSerialized(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), badmsg]), kp));

// classifyTx
const MINT = "Mint1111111111111111111111111111111111111pump";
const mkTx = ({ signer = "Buyer", pre = 5e9, post = 4.7e9, fee = 5000, tokPre = null, tokPost = "1000000", err = null, wsolPre, wsolPost }) => ({
  meta: {
    err, fee, preBalances: [pre], postBalances: [post],
    preTokenBalances: [...(tokPre ? [{ mint: MINT, owner: signer, uiTokenAmount: { amount: tokPre } }] : []), ...(wsolPre ? [{ mint: R.WSOL, owner: signer, uiTokenAmount: { amount: wsolPre } }] : [])],
    postTokenBalances: [{ mint: MINT, owner: signer, uiTokenAmount: { amount: tokPost } }, ...(wsolPost ? [{ mint: R.WSOL, owner: signer, uiTokenAmount: { amount: wsolPost } }] : [])],
  },
  transaction: { message: { accountKeys: [signer] } },
});
assert.deepStrictEqual(R.classifyTx(mkTx({}), MINT, "Prize"), { wallet: "Buyer", lamports: 3e8 - 5000 });
assert.strictEqual(R.classifyTx(mkTx({ tokPre: "2000000", tokPost: "1000000", post: 5.2e9 }), MINT, "Prize"), null); // sell
assert.strictEqual(R.classifyTx(mkTx({ err: { x: 1 } }), MINT, "Prize"), null);
assert.strictEqual(R.classifyTx(mkTx({ signer: "Prize" }), MINT, "Prize"), null);
assert.deepStrictEqual(R.classifyTx(mkTx({ post: 5e9 - 5000, wsolPre: "500000000", wsolPost: "0" }), MINT, "Prize"), { wallet: "Buyer", lamports: 5e8 });

// race flow
const cfg = { minBuyLamports: 1e8, clockSeconds: 600, finalLapSeconds: 60, maxRaceSeconds: 86400, graceSeconds: 20 };
const st = R.newState(MINT);
assert.strictEqual(R.applyBuy(st, cfg, { wallet: "A", lamports: 5e8, t: 1000, sig: "a" }), true);
assert.strictEqual(st.race.deadline, 1600);
assert.strictEqual(R.applyBuy(st, cfg, { wallet: "B", lamports: 5e7, t: 1250, sig: "b" }), false); // under minimum
assert.strictEqual(st.race.leader, "A");
R.applyBuy(st, cfg, { wallet: "C", lamports: 2e8, t: 1450, sig: "c" });
assert.strictEqual(st.race.leader, "C"); assert.strictEqual(st.race.deadline, 2050);
assert.strictEqual(R.checkDeadline(st, cfg, 2060), false); // inside grace
// a buy landing after the deadline but before the check starts race 2
R.applyBuy(st, cfg, { wallet: "D", lamports: 2e8, t: 2055, sig: "d" });
assert.strictEqual(st.toSettle.length, 1);
assert.strictEqual(st.toSettle[0].winner, "C");
assert.strictEqual(st.race.number, 2); assert.strictEqual(st.race.leader, "D");
assert.strictEqual(R.checkDeadline(st, cfg, 2655 + 21), true);
assert.strictEqual(st.toSettle[1].winner, "D");
assert.strictEqual(st.race.number, 3); assert.strictEqual(st.race.leader, null);
// 24h cap switches to the final lap clock
const st2 = R.newState(MINT);
R.applyBuy(st2, cfg, { wallet: "A", lamports: 2e8, t: 0, sig: "1" });
for (let t = 500; t < 86400; t += 500) R.applyBuy(st2, cfg, { wallet: "A", lamports: 2e8, t, sig: "s" + t });
R.applyBuy(st2, cfg, { wallet: "Z", lamports: 2e8, t: 86500, sig: "z" });
assert.strictEqual(st2.race.deadline, 86560);
assert.strictEqual(st2.race.number, 1);

// launch detection
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const createTx = (signer, logs, mints) => ({ meta: { err: null, logMessages: logs, preTokenBalances: [], postTokenBalances: mints.map((m) => ({ mint: m, owner: "Curve", uiTokenAmount: { amount: "1" } })) }, transaction: { message: { accountKeys: [signer] } } });
assert.strictEqual(R.detectCreatedMint(createTx("Prize", ["Program " + PUMP + " invoke [1]", "Program log: Instruction: Create"], ["AbcNewpump"]), "Prize", PUMP), "AbcNewpump");
assert.strictEqual(R.detectCreatedMint(createTx("Prize", ["Program " + PUMP + " invoke [1]", "Program log: Instruction: CreateV2"], [R.WSOL, "XyzNewpump"]), "Prize", PUMP), "XyzNewpump");
assert.strictEqual(R.detectCreatedMint(createTx("Prize", ["Program " + PUMP + " invoke [1]", "Program log: Instruction: Buy"], ["AbcNewpump"]), "Prize", PUMP), null);
assert.strictEqual(R.detectCreatedMint(createTx("Other", ["Program " + PUMP + " invoke [1]", "Program log: Instruction: Create"], ["AbcNewpump"]), "Prize", PUMP), null);

console.log("All tests passed");
