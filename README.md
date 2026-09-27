# LAST race bot

Every buy of $LAST resets a 10-minute clock. When the clock runs out, the last buyer gets 90% of the prize wallet. This app runs the races and serves the website.

It has no dependencies. Railway runs it with `npm start`.

## Launch guide

Everything is running and tested **before** the coin exists. When you create the coin, the bot detects it within seconds and race 1 is live from the first buy, snipers included.

### 1. Prize wallet
1. In Phantom, add a **new** wallet. Only use it for LAST.
2. Fund it with the launch cost, plus the SOL you want as the starting prize (1–2 SOL makes race 1 worth fighting for).
3. Export its private key: Settings → Manage Accounts → the wallet → Show Private Key.

### 2. Helius
Sign up free at helius.dev and copy your API key.

### 3. GitHub
Create a **private** repository called `last-bot`. Click "uploading an existing file" and drag in everything from this folder, including the `lib`, `public` and `scripts` folders. Commit.

### 4. Railway
1. At railway.com, sign in with GitHub → New Project → Deploy from GitHub repo → `last-bot`.
2. Add a **Volume** with mount path `/data`.
3. Settings → Networking → **Generate Domain**. That's your site. Add your own domain here later if you want.

### 5. Pre-launch test on mainnet (about 5 minutes, costs 0.001 SOL)
Set these **Variables**:

| Variable | Value |
|---|---|
| `PRIZE_WALLET_PRIVATE_KEY` | The prize wallet's private key |
| `HELIUS_API_KEY` | Your Helius key |
| `DATA_DIR` | `/data` |
| `X_URL` | Your X profile link |
| `DRY_RUN` | `true` |
| `MINT` | Any busy pump.fun coin's contract address (just to watch it) |
| `CLOCK_SECONDS` | `30` |
| `TEST_PAYOUT_TO` | Another wallet of yours |

In **Deploy Logs**, check for these three things:
1. `TEST PAYOUT OK` with a Solscan link. Payouts work on mainnet. (This one real transfer is sent even in dry run. Your other wallet receives 0.001 SOL.)
2. `took the lead` lines as people trade that coin. Buy detection works.
3. `[dry run] race N would pay ...` after a quiet 30 seconds. Race endings work.

### 6. Arm it for launch
1. Delete `MINT`, `CLOCK_SECONDS`, `TEST_PAYOUT_TO` and `DRY_RUN`. The test coin's data is cleared automatically.
2. After it redeploys, the logs say `Waiting for the prize wallet to create a coin on pump.fun`. The site shows the prize with "Launching soon."

### 7. Launch
1. Connect the **prize wallet** to pump.fun and create $LAST. Any dev buy from the prize wallet doesn't count in the race.
2. Within seconds the logs say `Launch detected`. The site switches to the live race with the contract address and buy button.
3. Post the site link.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `CLOCK_SECONDS` | 600 | Race clock |
| `MIN_BUY_SOL` | 0.1 | Smallest buy that takes the lead |
| `WINNER_SHARE` | 0.9 | Share of the prize paid to the winner |
| `RESERVE_SOL` | 0.05 | Always left in the wallet for network fees |
| `FINAL_LAP_SECONDS` | 60 | Clock after a race passes 24 hours |
| `MAX_RACE_SECONDS` | 86400 | When the final-lap clock kicks in |
| `GRACE_SECONDS` | 20 | Wait after zero to catch buys that landed just before it |
| `CLAIM_EVERY_SECONDS` | 300 | How often creator fees are collected into the wallet |
| `RPC_URL` | Helius | Use a different RPC instead of `HELIUS_API_KEY` |
| `MINT` | none | Fix the coin. Leave empty to auto-detect the prize wallet's launch |
| `TEST_PAYOUT_TO` | none | Sends 0.001 SOL there on startup to prove payouts work |

## How it works
- It polls every transaction that touches the $LAST mint. A buy is counted when the signer's $LAST balance goes up, and the SOL they spent is at least `MIN_BUY_SOL`.
- The clock uses on-chain block time. A buy after the deadline starts the next race.
- At payout, it collects creator fees through PumpPortal, then sends `WINNER_SHARE` of (balance − reserve) to the winner.
- A payout is saved before it's sent, so a restart can't pay the same race twice.
- `node test.js` runs the offline checks.
