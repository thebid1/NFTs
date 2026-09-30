# NFT Mint Tracker Bot (VPS edition, multi-chain)

Sends a Telegram alert the moment a tracked wallet **mints** an NFT, on any
configured EVM chain (Ethereum, Base, Robinhood, …). Each alert contains:
chain · collection name · OpenSea link · max supply · collection minted /
remaining · floor price · best offer · wallet (+ name) + token id, plus inline
buttons (OpenSea, transaction on that chain's block explorer). One alert per
minted token.

Design docs (`plan.md`, `architecture.md`, `research.md`, `agent.md`) and
`progress.md` (build state & learnings) are kept **locally only** — gitignored,
not in the repo.

## Setup (< 15 min)

### 1. Keys (one-time)

| Secret | Where |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram → @BotFather → `/newbot` |
| `TELEGRAM_CHAT_ID` | Message your bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id` (or run `node bot.js --chat-id`) |
| Alchemy URLs per chain | alchemy.com → one free app **per chain** → copy its HTTPS, WSS, and NFT API URLs |
| `OPENSEA_API_KEY` | `curl -X POST https://api.opensea.io/api/v2/auth/keys` (instant, free — rate-limited per IP; or a non-expiring key at opensea.io → Settings → Developer) |

### 2. Channel streaming & multiple admins (optional)

- **Stream to a channel:** create your channel → Channel settings →
  Administrators → add your bot (grant *Post Messages*). Then set
  `TELEGRAM_CHAT_ID` to the channel: `@channelusername` for a public channel,
  or the channel's `-100…` id for a private one — discover it by posting any
  message in the channel (bot admin required) and running `node bot.js --chat-id`.
- **Multiple admins:** (1) list private chat ids in `ADMIN_CHAT_IDS` in `.env`
  (comma-separated, needs a restart); or (2) **in-bot approval:** a friend
  messages the bot and you get a "🙋 Access request" note — reply
  `/allow <id>` from your private chat and they're an admin immediately.
  `/revoke <id>` removes access.
- Commands work from **private chats only** (never inside the channel), admins
  only. The watchlist is shared by all admins.

### 3. Configure

```bash
cp .env.example .env                # fill in Telegram + OpenSea
cp chains.example.json chains.json  # fill in one block per chain you want
```

`chains.json` holds your Alchemy keys inside the URLs — treat it like `.env`
(it is gitignored and `chmod 600`'d by `deploy.sh`). Add/remove a chain block
at any time, then `pm2 restart nft-tracker --update-env` (or Telegram `/add`,
which resubscribes live). Alchemy URL patterns for common chains:

| chain | host prefix |
|---|---|
| ethereum | `eth-mainnet` |
| base | `base-mainnet` |
| arbitrum | `arb-mainnet` |
| polygon | `polygon-mainnet` |
| optimism | `opt-mainnet` |
| sepolia (testnet) | `eth-sepolia` |
| robinhood | `robinhood-mainnet` |

Fast L2s (Robinhood et al.) produce a block every ~100–250 ms, so the global
`LOOKBACK_BLOCKS=50` covers only seconds of history there. Add a per-chain
`"lookback": <blocks>` field in `chains.json` to override it (the example sets
5,000 for robinhood ≈ 20–35 min).

### 4. Verify locally

```bash
npm install
npm run selftest        # offline logic checks (no keys needed)
npm run test-message    # sends the sample alert to your Telegram
```

### 5. First real data

```bash
# track a wallet (name optional), then scan recent history for its mints:
npm run backfill-once            # all configured chains
npm run backfill-once -- base    # or just one chain
```

## Deploy to the VPS (GitHub → clone)

The repo is safe to push — `.env`, `chains.json`, `progress.md`, and `*.db` are
gitignored. Prefer a **private** repo anyway.

```bash
# on your PC (first time):
git init && git add -A && git commit -m "nft mint tracker"
# create a PRIVATE repo at github.com, then:
git remote add origin git@github.com:<you>/nft-mint-tracker.git
git push -u origin main

# on your PC, copy secrets to the VPS (they never live in git):
scp .env chains.json <user>@<your-vps>:~/nft-tracker/   # after cloning on the VPS

# on the VPS:
git clone https://github.com/<you>/nft-mint-tracker.git ~/nft-tracker
cd ~/nft-tracker && chmod 700 . && chmod 600 .env chains.json && ./deploy.sh
```

`deploy.sh` installs Node 22 + PM2 if missing, installs deps, and starts the bot
under PM2. First time only: run `pm2 startup` and paste the printed sudo command
so the bot survives reboots. Then `pm2 save`.

Check health from your phone: Telegram `/status` (reports each chain's cursor).

## Operating

| Task | How |
|---|---|
| Add a wallet | Telegram `/add 0x… [name]` or `/add name.eth [name]` — or send `/add` alone for a step-by-step prompt. Applied to **all** chains, live resubscribe |
| Remove | `/remove 0x…` or `/remove name` (also step-by-step if sent alone) |
| List / health | `/list`, `/status` · VPS logs: `pm2 logs nft-tracker` |
| Restart after key/config change | edit `.env` or `chains.json`, then `pm2 restart nft-tracker --update-env` |
| Add/remove a chain | edit `chains.json`, then `pm2 restart nft-tracker --update-env` |
| Backup | `tar czf tracker-backup.tgz -C ~ nft-tracker/bot.js nft-tracker/.env nft-tracker/chains.json nft-tracker/tracker.db` |

## CLI modes

| Command | Effect |
|---|---|
| `node bot.js` | run the bot (all chains + command loop) |
| `node bot.js --test` | send one sample alert, exit |
| `node bot.js --backfill-once [chain]` | one backfill pass (all chains, or one), exit |
| `node bot.js --chat-id` | print Telegram chat ids (yours and channels the bot sees) |
| `node bot.js --replay <chain> <txHash> <logIndex> <contract> [tokenId]` | replay a known mint through the full pipeline (testing) |
| `node bot.js --selftest` | offline logic checks, exit |
