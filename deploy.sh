#!/usr/bin/env bash
# Deploy/update the bot on the VPS. Idempotent — safe to re-run.
# Usage: copy the project dir to the VPS, then:  ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> checking node"
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi
node --version

echo "==> checking build tools (native modules need a compiler if no prebuilt binary downloads)"
if ! command -v make >/dev/null 2>&1; then
  sudo apt install -y build-essential
fi

echo "==> checking pm2"
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm i -g pm2
fi

echo "==> installing dependencies"
npm install --omit=dev

if [ ! -f .env ]; then
  echo "ERROR: .env missing. Copy .env.example to .env and fill in your keys, then re-run." >&2
  exit 1
fi
chmod 600 .env 2>/dev/null || true

if [ ! -f chains.json ]; then
  echo "ERROR: chains.json missing. Copy chains.example.json to chains.json and fill in your Alchemy URLs, then re-run." >&2
  exit 1
fi
chmod 600 chains.json 2>/dev/null || true

echo "==> (re)starting bot under pm2"
if pm2 describe nft-tracker >/dev/null 2>&1; then
  pm2 restart nft-tracker --update-env
else
  pm2 start bot.js --name nft-tracker
fi
pm2 save

echo "==> done. logs: pm2 logs nft-tracker"
echo "    if this is the first deploy, run: pm2 startup   (then copy-paste the printed sudo command)"
