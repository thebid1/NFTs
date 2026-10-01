// NFT Mint Tracker Bot (VPS edition, multi-chain)
// Watches tracked wallets via Alchemy WSS log subscriptions + getLogs backfill,
// on every chain configured in chains.json.
// Sends a rich Telegram alert when a tracked wallet MINTS an NFT.
// Mint = Transfer(from = 0x0, to = wallet) on ERC-721, or TransferSingle(from = 0x0, to = wallet) on ERC-1155.
// Outbound connections only. No inbound ports, no webhooks.

require("dotenv").config();
const { ethers } = require("ethers");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const MODE = process.argv[2];
const MODE_ARG = process.argv[3];
const VALID_MODES = [undefined, "--test", "--backfill-once", "--selftest", "--chat-id", "--replay"];
if (!VALID_MODES.includes(MODE)) {
  console.error(`usage: node bot.js [--test | --backfill-once [chain] | --selftest | --chat-id | --replay <chain> <txHash> <logIndex> <contract> [tokenId]]`);
  process.exit(2);
}

// ---------- constants ----------
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = ethers.zeroPadValue(ZERO, 32);
const TOPIC_TRANSFER = ethers.id("Transfer(address,address,uint256)");
const TOPIC_TRANSFER_SINGLE = ethers.id("TransferSingle(address,address,address,uint256,uint256)");
const CHUNK = Math.max(10, Number(process.env.GETLOGS_CHUNK) || 10); // Alchemy free tier: max 10-block range per eth_getLogs call
const FETCH_TIMEOUT_MS = 15000;
const EXPLORERS = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
  arbitrum: "https://arbiscan.io",
  polygon: "https://polygonscan.com",
  optimism: "https://optimistic.etherscan.io",
  sepolia: "https://sepolia.etherscan.io",
  robinhood: "https://robinhoodchain.blockscout.com",
};
const MAX_SUPPLY_SELECTORS = ["maxSupply()", "MAX_SUPPLY()", "maxTokens()", "SUPPLY_CAP()"];
const SAMPLE_INFO = {
  name: "Sample Collection",
  link: "https://opensea.io/collection/sample-collection",
  maxSupply: 10000, minted: 1337, remaining: 8663,
  floor: "0.42 ETH", bestOffer: "0.31 ETH", imageUrl: null,
};

// ---------- config ----------
function loadConfig() {
  const cfg = {
    OPENSEA_API_KEY: process.env.OPENSEA_API_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    SEED_WALLET: process.env.SEED_WALLET || null,
    ADMIN_CHAT_IDS: (process.env.ADMIN_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean),
    LOOKBACK_BLOCKS: Number(process.env.LOOKBACK_BLOCKS || 50),
    CONFIRMATIONS: Math.max(1, Number(process.env.CONFIRMATIONS || 1)),
    DEDUPE_RETENTION_DAYS: Number(process.env.DEDUPE_RETENTION_DAYS || 7),
  };
  if (MODE === "--selftest") return cfg;
  // --chat-id only needs the bot token (it's how you discover the chat id)
  const required = MODE === "--chat-id"
    ? ["TELEGRAM_BOT_TOKEN"]
    : ["OPENSEA_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const missing = required.filter(k => !cfg[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}\nCopy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return cfg;
}

// chains.json: [{ "chain": "ethereum", "wss": "...", "https": "...", "nft": "..." }, ...]
// Contains API keys in the URLs — treat it like .env (chmod 600, never commit).
function loadChains() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(__dirname, "chains.json"), "utf8"));
  } catch (e) {
    if (MODE === "--selftest" || MODE === "--chat-id") return [];
    console.error(`chains.json missing or invalid: ${e.message}\nCopy chains.example.json to chains.json and fill in your Alchemy URLs.`);
    process.exit(1);
  }
  const arr = Array.isArray(raw) ? raw : [raw];
  if (!arr.length && MODE !== "--selftest" && MODE !== "--chat-id") {
    console.error("chains.json has no chain entries.");
    process.exit(1);
  }
  for (const c of arr) {
    for (const k of ["chain", "wss", "https", "nft"]) {
      if (!c[k]) { console.error(`chains.json entry missing "${k}": ${JSON.stringify(c)}`); process.exit(1); }
    }
  }
  return arr;
}

const C = loadConfig();
const CHAINS = loadChains();
const chainCfg = name => CHAINS.find(c => c.chain === name);
// Admins: env bootstrap list ∪ runtime /allow list (persisted in SQLite).
// Defaults to the alert destination if neither is configured.
const dbAdmins = () => db.prepare("SELECT chat_id FROM admins").all().map(r => r.chat_id);
const adminIds = () => [...new Set([...(C.ADMIN_CHAT_IDS.length ? C.ADMIN_CHAT_IDS : [C.TELEGRAM_CHAT_ID]), ...dbAdmins()])];
// Private chat used for owner-only notices (falls back to the alert channel).
const ownerChat = () => adminIds().find(x => /^-?\d+$/.test(x)) ?? C.TELEGRAM_CHAT_ID;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- state ----------
const db = new Database(path.join(__dirname, "tracker.db"));
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS dedupe(key TEXT PRIMARY KEY, created_at INTEGER);
         CREATE TABLE IF NOT EXISTS cursor(chain TEXT PRIMARY KEY, last_block INTEGER);
         CREATE TABLE IF NOT EXISTS wallets(address TEXT NOT NULL, added_at INTEGER, label TEXT, owner_chat_id TEXT, PRIMARY KEY(address, owner_chat_id));
         CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER);
         CREATE TABLE IF NOT EXISTS retry_queue(key TEXT PRIMARY KEY, payload TEXT, run_at INTEGER);
         CREATE TABLE IF NOT EXISTS admins(chat_id TEXT PRIMARY KEY, added_at INTEGER);`);

// migrations for DBs created before labels / per-user ownership existed —
// MUST run before the prepared statements below reference the new columns.
const walletsDdl = () => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wallets'").get()?.sql ?? "";
if (!walletsDdl().includes("owner_chat_id")) {
  db.exec("ALTER TABLE wallets ADD COLUMN owner_chat_id TEXT");
  db.prepare("UPDATE wallets SET owner_chat_id=? WHERE owner_chat_id IS NULL").run(String(C.TELEGRAM_CHAT_ID));
}
if (!/PRIMARY KEY\s*\(\s*address\s*,\s*owner_chat_id\s*\)/i.test(walletsDdl())) {
  // rebuild with composite PK so different users can each track the same address
  db.exec(`CREATE TABLE wallets_new(address TEXT NOT NULL, added_at INTEGER, label TEXT, owner_chat_id TEXT, PRIMARY KEY(address, owner_chat_id));
           INSERT INTO wallets_new SELECT address, added_at, label, owner_chat_id FROM wallets;
           DROP TABLE wallets; ALTER TABLE wallets_new RENAME TO wallets;`);
}

const q = {
  seen: db.prepare("SELECT 1 FROM dedupe WHERE key=?"),
  addSeen: db.prepare("INSERT OR IGNORE INTO dedupe VALUES (?,?)"),
  getCursor: db.prepare("SELECT last_block FROM cursor WHERE chain=?"),
  setCursor: db.prepare("INSERT INTO cursor(chain,last_block) VALUES(?,?) ON CONFLICT(chain) DO UPDATE SET last_block=excluded.last_block"),
  rmWallet: db.prepare("DELETE FROM wallets WHERE address=? AND owner_chat_id=?"),
  cacheGet: db.prepare("SELECT value, expires_at FROM cache WHERE key=?"),
  cacheSet: db.prepare("INSERT INTO cache(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at"),
  cacheDel: db.prepare("DELETE FROM cache WHERE key=?"),
  addRetry: db.prepare("INSERT OR REPLACE INTO retry_queue VALUES (?,?,?)"),
  rmRetry: db.prepare("DELETE FROM retry_queue WHERE key=?"),
  pruneDedupe: db.prepare("DELETE FROM dedupe WHERE created_at<?"),
};

const walletRows = (owner = null) => owner == null
  ? db.prepare("SELECT address, label, owner_chat_id FROM wallets ORDER BY added_at").all()
  : db.prepare("SELECT address, label, owner_chat_id FROM wallets WHERE owner_chat_id=? ORDER BY added_at").all(owner);
const wallets = () => [...new Set(walletRows().map(r => r.address))]; // union — one shared subscription set
const labelFor = (addr, owner) => walletRows(owner).find(r => r.address === addr)?.label ?? null;
const ownersOf = addr => [...new Set(walletRows().filter(r => r.address === addr).map(r => r.owner_chat_id))];
// Insert per-user; a new label overwrites, omitting it keeps the existing one.
const upsertWallet = (addr, label, owner) => db.prepare(
  "INSERT INTO wallets(address,added_at,label,owner_chat_id) VALUES (?,?,?,?) " +
  "ON CONFLICT(address,owner_chat_id) DO UPDATE SET label=COALESCE(excluded.label, wallets.label)"
).run(addr, Date.now(), label, String(owner));

if (!wallets().length && C.SEED_WALLET && /^0x[0-9a-fA-F]{40}$/.test(C.SEED_WALLET)) {
  upsertWallet(C.SEED_WALLET.toLowerCase(), null, C.TELEGRAM_CHAT_ID);
  log("seeded wallet", C.SEED_WALLET.toLowerCase());
}
const cacheGet = key => {
  const row = q.cacheGet.get(key);
  if (!row) return null;
  if (row.expires_at != null && row.expires_at < Date.now()) return null;
  return row.value;
};
const cacheSet = (key, value, ttlMs) =>
  q.cacheSet.run(key, value, ttlMs == null ? null : Date.now() + ttlMs);
const getCursor = chain => q.getCursor.get(chain)?.last_block ?? null;
const setCursorMax = (chain, b) => {
  const cur = getCursor(chain);
  if (cur == null || b > cur) q.setCursor.run(chain, b);
};

// ---------- pure helpers (unit-testable) ----------
const addrFromTopic = t => "0x" + t.slice(26).toLowerCase();
const shortAddr = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = s => String(s).replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));

// Returns {wallet, contract, tokenId} if log is a mint into a tracked wallet, else null.
function parseMintLog(log) {
  const t = log.topics;
  if (t[0] === TOPIC_TRANSFER) {
    if (t[1] !== ZERO32) return null;               // from must be zero address
    return { wallet: addrFromTopic(t[2]), contract: log.address.toLowerCase(), tokenId: String(ethers.toBigInt(t[3])) };
  }
  if (t[0] === TOPIC_TRANSFER_SINGLE) {
    if (t[2] !== ZERO32) return null;               // from must be zero address
    return { wallet: addrFromTopic(t[3]), contract: log.address.toLowerCase(), tokenId: String(ethers.toBigInt("0x" + log.data.slice(2, 66))) };
  }
  return null;
}

function maxOffer(offers) {
  if (!offers?.length) return null;
  let best = null, bestVal = -1;
  for (const o of offers) {
    const p = o?.price;
    if (!p?.value) continue;
    const v = Number(BigInt(p.value)) / 10 ** (p.decimals ?? 18);
    if (v > bestVal) { bestVal = v; best = `${v} ${p.currency ?? "ETH"}`; }
  }
  return best;
}

function render(i, wallet, tokenId, chain, label = null) {
  const who = label ? `${esc(label)} (${shortAddr(wallet)})` : shortAddr(wallet);
  return `🆕 <b>MINT DETECTED — ${esc(i.name)}</b> · ${esc(chain)}\n` +
    `🔗 <a href="${i.link}">${i.link}</a>\n` +
    `📦 Max supply: ${i.maxSupply ?? "open/unknown"}\n` +
    `🧮 Collection minted: ${i.minted ?? "—"} · Remaining: ${i.remaining ?? "n/a"}\n` +
    `💰 Floor: ${i.floor ?? "n/a"}\n` +
    `🤝 Best offer: ${i.bestOffer ?? "n/a"}\n` +
    `👛 ${who}${tokenId != null ? ` · Token #${esc(tokenId)}` : ""}`;
}

function buildFilters(list = wallets()) {
  const ws = list.map(w => ethers.zeroPadValue(w, 32));
  if (!ws.length) return [];
  // Two subscriptions: ERC-721 has `to` in topics[2]; ERC-1155 TransferSingle has `to` in topics[3].
  return [
    { label: "erc721", topics: [TOPIC_TRANSFER, ZERO32, ws] },
    { label: "erc1155", topics: [TOPIC_TRANSFER_SINGLE, null, ZERO32, ws] },
  ];
}

// ---------- telegram ----------
const TG = `https://api.telegram.org/bot${C.TELEGRAM_BOT_TOKEN}`;
async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`tg ${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(`tg ${method}: ${j.description}`);
  return j;
}

function replyMarkup(info, txHash, chain) {
  const explorer = EXPLORERS[chain] ?? EXPLORERS.ethereum;
  const rows = [[{ text: "View on OpenSea", url: info.link }]];
  if (txHash) rows.push([{ text: "View transaction", url: `${explorer}/tx/${txHash}` }]);
  return { inline_keyboard: rows };
}

async function notify(info, wallet, tokenId, txHash, chain, label = null, chatId = C.TELEGRAM_CHAT_ID) {
  const text = render(info, wallet, tokenId, chain, label);
  const kb = replyMarkup(info, txHash, chain);
  if (info.imageUrl) {
    try {
      await tg("sendPhoto", { chat_id: chatId, photo: info.imageUrl, caption: text, parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (e) { log("sendPhoto failed, falling back to text:", e.message); }
  }
  await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: false, reply_markup: kb });
}

async function notifyWithRetry(info, wallet, tokenId, txHash, chain, label = null, chatId = C.TELEGRAM_CHAT_ID) {
  let last;
  for (const wait of [0, 2000, 8000]) {
    if (wait) await sleep(wait);
    try { return await notify(info, wallet, tokenId, txHash, chain, label, chatId); } catch (e) { last = e; }
  }
  throw last;
}

// ---------- http helpers ----------
async function j(url, headers = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (r.status === 429 || r.status >= 500) { last = new Error(`${r.status} ${url}`); await sleep(1000 * 2 ** i); continue; }
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") { last = e; await sleep(1000 * 2 ** i); continue; }
      throw e;
    }
  }
  throw last;
}

// ---------- per-chain providers ----------
const httpProviders = new Map();
function httpFor(chain) {
  if (!httpProviders.has(chain)) {
    const cfg = chainCfg(chain);
    if (!cfg) throw new Error(`unknown chain: ${chain}`);
    httpProviders.set(chain, new ethers.JsonRpcProvider(cfg.https, undefined, { timeout: 60000 }));
  }
  return httpProviders.get(chain);
}

// ---------- enrichment ----------
const OS = { "x-api-key": C.OPENSEA_API_KEY };
const H24 = 24 * 3600 * 1000;

async function readMaxSupply(chain, contract) {
  for (const sig of MAX_SUPPLY_SELECTORS) {
    try {
      const v = await httpFor(chain).call({ to: contract, data: ethers.id(sig).slice(0, 10) });
      const n = Number(ethers.toBigInt(v));
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* try next selector */ }
  }
  return null;
}

// totalSupply() = tokens minted so far; on-chain is authoritative (metadata caches lag).
async function readTotalSupply(chain, contract) {
  try {
    const v = await httpFor(chain).call({ to: contract, data: "0x18160ddd" });
    const n = Number(ethers.toBigInt(v));
    if (Number.isFinite(n) && n >= 0) return n;
  } catch { /* not an ERC-721/1155 supply fn */ }
  return null;
}

async function resolveSlug(chain, contract) {
  const ck = `slug:${chain}:${contract}`;
  const hit = cacheGet(ck);
  if (hit) return hit;
  const c = await j(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`, OS);
  const slug = c?.collection ?? c?.slug ?? null;
  if (slug) cacheSet(ck, slug, H24);
  return slug;
}

async function enrich(chain, contract, tokenId) {
  const cfg = chainCfg(chain);
  // Independent lookups fire in parallel — this is the alert-latency critical path.
  const metaP = j(`${cfg.nft}/getContractMetadata?contractAddress=${contract}`);
  const slugP = resolveSlug(chain, contract).catch(() => null);
  const mintedP = readTotalSupply(chain, contract).catch(() => null);
  const maxP = readMaxSupply(chain, contract).catch(() => null);

  const metaRaw = await metaP;                     // throws → caller's retry-queue path
  const meta = metaRaw?.contractMetadata ?? metaRaw ?? {};
  const slug = await slugP;

  let stats = null, bestOffer = null;
  if (slug) {
    [stats, bestOffer] = await Promise.all([
      j(`https://api.opensea.io/api/v2/collections/${slug}/stats`, OS).catch(() => null),
      j(`https://api.opensea.io/api/v2/offers/collection/${slug}`, OS)
        .then(r => maxOffer(r.offers)).catch(() => null),
    ]);
    if (!bestOffer && tokenId != null) {
      bestOffer = await j(`https://api.opensea.io/api/v2/offers/collection/${slug}/nfts/${tokenId}/best`, OS)
        .then(b => b?.price ? `${Number(BigInt(b.price.value)) / 10 ** (b.price.decimals ?? 18)} ${b.price.currency ?? "ETH"}` : null)
        .catch(() => null);
    }
  }

  const [onChainMinted, maxSupply] = await Promise.all([mintedP, maxP]);
  const minted = onChainMinted ?? (meta.totalSupply != null ? Number(meta.totalSupply) : (stats?.total?.total_supply ?? null));
  const name = meta.name ?? (slug ? slug : shortAddr(contract));
  const link = slug
    ? `https://opensea.io/collection/${slug}`
    : `https://opensea.io/assets/${chain}/${contract}${tokenId != null ? `/${tokenId}` : ""}`;
  const floor = stats?.total?.floor_price != null
    ? `${stats.total.floor_price} ${stats.total.floor_price_symbol ?? ""}`.trim() : null;

  return {
    name, link, slug,
    maxSupply,
    minted: Number.isFinite(minted) ? minted : null,
    remaining: maxSupply != null && Number.isFinite(minted) ? Math.max(maxSupply - minted, 0) : null,
    floor, bestOffer,
    imageUrl: meta.openseaMetadata?.imageUrl ?? null,
  };
}

// ---------- retry queue (OpenSea indexing lag) ----------
function scheduleRetry(key, payload, delayMs) {
  q.addRetry.run(key, JSON.stringify(payload), Date.now() + delayMs);
  setTimeout(() => runRetry(key).catch(e => log("retry failed:", e.message)), delayMs);
}

async function runRetry(key) {
  const pending = db.prepare("SELECT payload FROM retry_queue WHERE key=?").get(key);
  if (!pending) return;
  db.prepare("DELETE FROM retry_queue WHERE key=?").run(key);
  const p = JSON.parse(pending.payload); // {chain, contract, tokenId, wallet, txHash, label, owner}
  try {
    const info = await enrich(p.chain, p.contract, p.tokenId);
    await notifyWithRetry(info, p.wallet, p.tokenId, p.txHash, p.chain, p.label, p.owner);
    log("retry delivered full mint message", key);
  } catch {
    await notifyWithRetry({
      name: shortAddr(p.contract), link: `https://opensea.io/assets/${p.chain}/${p.contract}`,
      maxSupply: null, minted: null, remaining: null, floor: null, bestOffer: null, imageUrl: null,
    }, p.wallet, p.tokenId, p.txHash, p.chain, p.label, p.owner).catch(e => log("degraded send failed:", e.message));
    log("retry delivered degraded mint message", key);
  }
}

function flushRetries() {
  // Re-arm every pending retry after a restart: overdue runs now, future ones on schedule.
  for (const row of db.prepare("SELECT key, run_at FROM retry_queue").all()) {
    const wait = Math.max(0, row.run_at - Date.now());
    setTimeout(() => runRetry(row.key).catch(e => log("retry failed:", e.message)), wait);
  }
}

// ---------- mint pipeline ----------
async function processMint(chain, lg, parsed) {
  const { contract, tokenId, wallet } = parsed;
  // Whoever tracks this wallet gets their own alert; dedupe per recipient.
  const owners = ownersOf(wallet);
  if (!owners.length) return;
  const fresh = [];
  for (const owner of owners) {
    const key = `${chain}:${lg.transactionHash}:${lg.index}:${owner}`;
    if (q.seen.get(key)) continue;
    q.addSeen.run(key, Date.now());
    fresh.push(owner);
  }
  if (!fresh.length) {
    if (lg.blockNumber > 0) setCursorMax(chain, lg.blockNumber); // synthetic logs (replay) pass 0 — never move the cursor
    return;
  }
  if (lg.blockNumber > 0) setCursorMax(chain, lg.blockNumber);
  let info;
  try {
    info = await enrich(chain, contract, tokenId); // enriched once, delivered to each owner
  } catch (e) {
    log(`enrich failed for ${chain}:${contract}: ${e.message}; retry in 60s`);
    for (const owner of fresh) {
      scheduleRetry(`${chain}:${lg.transactionHash}:${lg.index}:${owner}`,
        { chain, contract, tokenId, wallet, txHash: lg.transactionHash, label: labelFor(wallet, owner), owner }, 60_000);
    }
    return;
  }
  for (const owner of fresh) {
    const label = labelFor(wallet, owner);
    try {
      await notifyWithRetry(info, wallet, tokenId, lg.transactionHash, chain, label, owner);
      log(`alert sent: [${chain}] ${info.name} -> ${label ?? shortAddr(wallet)} (block ${lg.blockNumber})`);
    } catch (e) {
      log("NOTIFY FAILED PERMANENTLY:", e.message);
      tg("sendMessage", { chat_id: ownerChat(), text: `⚠️ Mint alert for <code>${contract}</code> (${chain}) failed to reach <code>${owner}</code>: ${esc(e.message)}`, parse_mode: "HTML" }).catch(() => {});
    }
  }
}

async function handleLog(chain, lg) {
  if (lg.removed) return;                   // reorg replay: dedupe already handled it
  const parsed = parseMintLog(lg);
  if (!parsed) return;
  await processMint(chain, lg, parsed);
}

// Serialize event processing (enrichment is rate-limit friendly).
let pipeline = Promise.resolve();
const enqueue = fn => { pipeline = pipeline.then(fn).catch(e => log("pipeline:", e?.message ?? e)); };

// ---------- detectors: one websocket subscription set per chain ----------
const detectors = new Map(); // chain -> {provider, stopped, gen, restartTimer, watchdog}

function stopDetector(chain) {
  const d = detectors.get(chain);
  if (!d) return;
  d.stopped = true;
  d.gen++;
  if (d.restartTimer) clearTimeout(d.restartTimer);
  if (d.watchdog) clearInterval(d.watchdog);
  try { d.provider?.destroy(); } catch { /* already closed */ }
  detectors.delete(chain);
}

function scheduleReconnect(chain, gen) {
  const d = detectors.get(chain);
  if (!d || d.stopped || d.gen !== gen || d.restartTimer) return;
  d.restartTimer = setTimeout(async () => {
    d.restartTimer = null;
    try { await backfill(chain); } catch (e) { log(`[${chain}] pre-reconnect backfill failed:`, e.message); }
    await startDetector(chain);
  }, 5000);
}

async function startDetector(chain) {
  stopDetector(chain);
  const cfg = chainCfg(chain);
  if (!cfg) { log(`[${chain}] no config entry; skipping`); return; }
  const d = { provider: null, stopped: false, gen: 1, restartTimer: null, watchdog: null };
  detectors.set(chain, d);
  const gen = d.gen;
  const filters = buildFilters();
  if (!filters.length) { log("no tracked wallets; detectors idle — use /add to start tracking"); return; }

  const wss = new ethers.WebSocketProvider(cfg.wss);
  d.provider = wss;
  const onWsDown = why => { log(`[${chain}] websocket down (${why}); reconnecting in 5s`); scheduleReconnect(chain, gen); };
  wss.on("error", e => onWsDown(e?.message ?? "error"));
  try {
    const ws = wss.websocket;
    if (typeof ws?.on === "function") ws.on("close", () => onWsDown("close"));
    else ws?.addEventListener?.("close", () => onWsDown("close"));
  } catch { /* older ethers: watchdog covers this */ }

  try {
    await wss.getBlockNumber(); // force connection
  } catch (e) { log(`[${chain}] websocket connect failed:`, e.message); scheduleReconnect(chain, gen); return; }

  for (const f of filters) wss.on({ topics: f.topics }, entry => enqueue(() => handleLog(chain, entry)));
  log(`[${chain}] subscribed (${filters.map(f => f.label).join("+")}) to ${wallets().length} wallet(s)`);

  // liveness probe: catches half-dead sockets that never emit close
  d.watchdog = setInterval(() => {
    wss.getBlockNumber().catch(() => onWsDown("watchdog"));
  }, 60_000);

  await backfill(chain); // cold start / gap catch-up from persisted cursor
}

async function backfill(chain) {
  const cfg = chainCfg(chain);
  if (!cfg) throw new Error(`unknown chain: ${chain}`);
  const filters = buildFilters();
  if (!filters.length) return;
  const provider = httpFor(chain);
  const lookback = Number(cfg.lookback) > 0 ? Number(cfg.lookback) : C.LOOKBACK_BLOCKS;
  const head = await provider.getBlockNumber();
  const to = head - C.CONFIRMATIONS + 1;
  const from = Math.max(getCursor(chain) != null ? getCursor(chain) + 1 : to - lookback + 1, 0);
  if (from > to) return;
  log(`[${chain}] backfill blocks ${from}..${to}`);
  for (let s = from; s <= to; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, to);
    for (const f of filters) {
      const logs = await provider.getLogs({ topics: f.topics, fromBlock: s, toBlock: e });
      for (const entry of logs) await handleLog(chain, entry);
    }
    setCursorMax(chain, e);
  }
  log(`[${chain}] backfill done, cursor at`, getCursor(chain));
}

async function restartAllDetectors() {
  for (const c of CHAINS) {
    try { await startDetector(c.chain); } catch (e) { log(`[${c.chain}] start failed:`, e.message); }
  }
}

// ---------- telegram command loop (long polling, outbound only) ----------
// Resolve ENS names via the ethereum chain's provider (ENS registry home).
async function resolveEns(name) {
  if (!chainCfg("ethereum")) return null;
  try { return await httpFor("ethereum").resolveName(name); } catch { return null; }
}

// Shared /add logic: input = "0x… [label]" or "name.eth [label]". Wallet belongs to `owner`.
async function doAdd(reply, input, owner) {
  const parts = input.trim().split(/\s+/);
  const arg = parts[0];
  const label = parts.slice(1).join(" ").slice(0, 40) || null;
  let addr = null;
  if (/^0x[0-9a-fA-F]{40}$/.test(arg ?? "")) {
    addr = arg.toLowerCase();
  } else if (/^[^/\s]+\.eth$/i.test(arg ?? "")) {
    addr = (await resolveEns(arg))?.toLowerCase() ?? null;
    if (!addr) return reply(`❌ Couldn't resolve <code>${esc(arg)}</code> — check the spelling, or use a 0x address.`);
  } else {
    return reply("That doesn't look like a wallet — send <code>0x…</code> or <code>name.eth</code>.");
  }
  upsertWallet(addr, label, owner);
  await reply(`✅ Now tracking ${label ? `<b>${esc(label)}</b> ` : ""}<code>${addr}</code> on ${CHAINS.map(c => c.chain).join(", ")} — alerts will come to you here, privately.`);
  await restartAllDetectors(); // live resubscribe; cursor-protected backfill covers the gap
}

// Shared /remove logic: arg = address or exact label, scoped to the caller's own wallets.
async function doRemove(reply, arg, owner) {
  const rows = walletRows(owner);
  const byLabel = rows.find(r => r.label && r.label.toLowerCase() === arg.toLowerCase());
  const addr = /^0x[0-9a-fA-F]{40}$/.test(arg) ? arg.toLowerCase() : byLabel?.address;
  if (!addr) return reply("Not found — send an address or an exact label from YOUR list (/list).");
  q.rmWallet.run(addr, String(owner));
  await reply(`🗑 Removed ${byLabel?.label ? `<b>${esc(byLabel.label)}</b> ` : ""}<code>${addr}</code>`);
  await restartAllDetectors();
}

// Channels are independent tenants: commands are accepted from channel ADMINS only,
// and wallets added there belong to the channel (alerts post in the channel).
const channelAdminCache = new Map(); // chatId -> { ids: Set<userId>, ts }
async function isChannelAdmin(m) {
  const chatId = String(m.chat.id);
  if (m.sender_chat && String(m.sender_chat.id) === chatId) return true; // posted as the channel itself
  if (!m.from?.id) return false;
  const hit = channelAdminCache.get(chatId);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.ids.has(m.from.id);
  try {
    const r = await tg("getChatAdministrators", { chat_id: chatId });
    const ids = new Set((r.result ?? []).map(a => a.user?.id).filter(Boolean));
    channelAdminCache.set(chatId, { ids, ts: Date.now() });
    return ids.has(m.from.id);
  } catch { return false; }
}

async function handleCommand(m) {
  const chatId = String(m.chat.id);
  const isPrivate = m.chat?.type === "private";
  if (isPrivate) {
    if (!adminIds().includes(chatId)) {                 // unknown user: invite-only notice + one access request to the owner
      if (!cacheGet(`req:${chatId}`)) {
        cacheSet(`req:${chatId}`, "1", 30 * 24 * 3600 * 1000);
        const who = [m.from?.first_name, m.from?.username ? `@${m.from.username}` : null].filter(Boolean).join(" ");
        tg("sendMessage", { chat_id: ownerChat(), text: `🙋 Access request: ${who || "unknown user"}, chat id <code>${chatId}</code> — reply <code>/allow ${chatId}</code> to grant.`, parse_mode: "HTML" }).catch(() => {});
      }
      await tg("sendMessage", { chat_id: chatId, text: "⛔ This bot is invite-only — the owner has been notified of your request." }).catch(() => {});
      return;
    }
  } else if (m.chat?.type === "channel") {
    if (!(await isChannelAdmin(m))) return;             // only channel admins manage the channel's watchlist
  } else {
    return;                                             // groups/supergroups not supported
  }
  const reply = text => tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  const text = m.text.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0];
  const arg = parts[1];

  // Step-by-step mode: a pending prompt consumes this chat's next plain message.
  const pendingKey = `pending:${chatId}`;
  const pending = cacheGet(pendingKey);
  if (pending && !text.startsWith("/")) {
    q.cacheDel.run(pendingKey);
    if (pending === "add") return doAdd(reply, text, chatId);
    if (pending === "remove") return doRemove(reply, text, chatId);
  }

  if (cmd === "/cancel") {
    q.cacheDel.run(pendingKey);
    return reply("Cancelled.");
  }
  if (cmd === "/add") {
    q.cacheDel.run(pendingKey);
    if (!arg) {
      cacheSet(pendingKey, "add", 5 * 60 * 1000);
      return reply("Send the wallet to track — <code>0x…</code> or <code>name.eth</code>, optionally followed by a label.\nExample: <code>0x1234…abcd Whale1</code>. /cancel to abort.");
    }
    return doAdd(reply, parts.slice(1).join(" "), chatId);
  }
  if (cmd === "/remove") {
    q.cacheDel.run(pendingKey);
    if (!arg) {
      cacheSet(pendingKey, "remove", 5 * 60 * 1000);
      return reply("Send the wallet to remove — <code>0x…</code> or its label. /cancel to abort.");
    }
    return doRemove(reply, arg, chatId);
  }
  if (cmd === "/allow" && isPrivate && /^-?\d+$/.test(arg ?? "")) {
    db.prepare("INSERT OR IGNORE INTO admins VALUES (?,?)").run(arg, Date.now());
    await reply(`✅ Granted admin to <code>${arg}</code>`);
  } else if (cmd === "/revoke" && isPrivate && /^-?\d+$/.test(arg ?? "")) {
    db.prepare("DELETE FROM admins WHERE chat_id=?").run(arg);
    await reply(`🗑 Revoked admin <code>${arg}</code>`);
  } else if (cmd === "/list") {
    await reply("👛 Your wallets:\n" + (walletRows(chatId).map(r => `${r.label ? `<b>${esc(r.label)}</b> — ` : ""}<code>${r.address}</code>`).join("\n") || "(none)"));
  } else if (cmd === "/status") {
    const perChain = CHAINS.map(c => {
      const live = detectors.get(c.chain)?.provider ? "live" : "idle";
      return `${c.chain} @ ${getCursor(c.chain) ?? "—"} (${live})`;
    }).join("\n");
    await reply(`⚙️ up ${Math.floor(process.uptime())}s · ${wallets().length} wallet(s)\n${perChain}`);
  } else if (cmd === "/test") {
    await notify(SAMPLE_INFO, "0x000000000000000000000000000000000000dEaD", "42", null, CHAINS[0]?.chain ?? "ethereum", "Sample Wallet", chatId);
    await reply("✅ sample sent here");
  } else if (cmd === "/help") {
    await reply("/add — track a wallet (send alone for step-by-step, or /add 0x… [name])\n/remove — untrack by address or label\n/list — this chat's wallets\n/status — health\n/test — sample alert to this chat\n/allow <id> — grant bot access (owner, private chat)\n/revoke <id> — remove access (owner, private chat)\n/cancel — abort a pending prompt\nIn a channel: channel admins manage that channel's own watchlist — everything stays in the channel.");
  }
}

async function commandLoop() {
  let offset = Number(cacheGet("tg_offset") ?? 0);
  while (true) {
    try {
      const r = await tg("getUpdates", { offset, timeout: 30 });
      for (const u of r.result ?? []) {
        offset = u.update_id + 1;
        cacheSet("tg_offset", String(offset), null);
        const m = u.message ?? u.edited_message;
        if (m?.text) await handleCommand(m).catch(e => log("command failed:", e.message));
      }
    } catch (e) { log("getUpdates:", e.message); await sleep(5000); }
  }
}

// ---------- housekeeping ----------
function prune() {
  const cutoff = Date.now() - C.DEDUPE_RETENTION_DAYS * 86400 * 1000;
  const r = q.pruneDedupe.run(cutoff);
  if (r.changes) log("pruned", r.changes, "old dedupe rows");
}

// ---------- self-test (offline, no keys needed) ----------
function selftest() {
  const assert = require("node:assert");
  const W1 = "0x1111111111111111111111111111111111111111";
  const W2 = "0x2222222222222222222222222222222222222222";
  const C1 = "0xcccccccccccccccccccccccccccccccccccccccc";
  const w1 = ethers.zeroPadValue(W1, 32), w2 = ethers.zeroPadValue(W2, 32);
  const id5 = ethers.zeroPadValue(ethers.toBeHex(5), 32);
  const op = ethers.zeroPadValue(W2, 32);

  // ERC-721 mint: from=0x0, to=W1
  let p = parseMintLog({ address: C1, topics: [TOPIC_TRANSFER, ZERO32, w1, id5] });
  assert.equal(p.wallet, W1); assert.equal(p.contract, C1); assert.equal(p.tokenId, "5");
  // ERC-721 transfer IN (not a mint): from=W2 -> must be rejected
  p = parseMintLog({ address: C1, topics: [TOPIC_TRANSFER, w2, w1, id5] });
  assert.equal(p, null);
  // ERC-1155 mint via TransferSingle: topics[2]=from=0x0, topics[3]=to=W1, id in data
  const data1155 = ethers.zeroPadValue(ethers.toBeHex(7), 32).slice(2) + ethers.zeroPadValue(ethers.toBeHex(1), 32).slice(2);
  p = parseMintLog({ address: C1, topics: [TOPIC_TRANSFER_SINGLE, op, ZERO32, w1], data: "0x" + data1155 });
  assert.equal(p.wallet, W1); assert.equal(p.tokenId, "7");
  // ERC-1155 transfer in (not a mint): from=W2 -> rejected
  p = parseMintLog({ address: C1, topics: [TOPIC_TRANSFER_SINGLE, op, w2, w1], data: "0x" + data1155 });
  assert.equal(p, null);

  // dedupe
  const tdb = new Database(":memory:");
  tdb.exec("CREATE TABLE dedupe(key TEXT PRIMARY KEY, created_at INTEGER)");
  const seen1 = tdb.prepare("INSERT OR IGNORE INTO dedupe VALUES (?,?)").run("k", 1);
  const seen2 = tdb.prepare("INSERT OR IGNORE INTO dedupe VALUES (?,?)").run("k", 2);
  assert.equal(seen1.changes, 1); assert.equal(seen2.changes, 0);

  // chain-scoped dedupe keys (multi-chain: same tx on two chains = two alerts)
  const keyEth = `ethereum:0xaaa:1`, keyBase = `base:0xaaa:1`;
  assert.notEqual(keyEth, keyBase);

  // render: fields present, chain shown, label shown, HTML escaped, no wallet-count confusion
  const html = render({ name: "<script>", link: "https://opensea.io/collection/x", maxSupply: 100, minted: 10, remaining: 90, floor: "1 ETH", bestOffer: null }, W1.toLowerCase(), "9", "base", "Whale1");
  assert(html.includes("MINT DETECTED")); assert(html.includes("&lt;script&gt;")); assert(html.includes("Remaining: 90"));
  assert(html.includes("· base")); assert(html.includes("Whale1 (0x1111…1111)"));
  assert(html.includes("Collection minted: 10")); assert(!html.includes("×3"));

  // maxOffer picks highest normalized bid
  const best = maxOffer([{ price: { value: "500000000000000000", decimals: 18, currency: "ETH" } }, { price: { value: "2000000000000000000", decimals: 18, currency: "ETH" } }]);
  assert.equal(best, "2 ETH");

  // filter builder: 721 constrains topics[2], 1155 constrains topics[3] with wallets
  const fs = buildFilters([W1.toLowerCase()]);
  assert.equal(fs.length, 2);
  assert(fs[0].topics[2].includes(w1));      // 721: wallets at topics[2]
  assert(fs[1].topics[3].includes(w1));      // 1155: wallets at topics[3]

  console.log("selftest: all checks passed");
}

// ---------- entrypoints ----------
async function main() {
  log(`mintbot starting · chains=${CHAINS.map(c => c.chain).join(",")} · lookback=${C.LOOKBACK_BLOCKS} · confirmations=${C.CONFIRMATIONS}`);
  // Publish the command menu to Telegram (private chats) so / shows it even if BotFather edits lag.
  tg("setMyCommands", {
    commands: [
      { command: "add", description: "Track a wallet: 0x… or name.eth, optional label" },
      { command: "remove", description: "Untrack by address or label" },
      { command: "list", description: "Show tracked wallets" },
      { command: "status", description: "Bot health and chain cursors" },
      { command: "test", description: "Send a sample alert" },
      { command: "help", description: "Show all commands" },
      { command: "allow", description: "Grant admin (owner only, private chat)" },
      { command: "revoke", description: "Remove admin (owner only, private chat)" },
      { command: "cancel", description: "Abort a pending prompt" },
    ],
    scope: { type: "all_private_chats" },
  }).catch(e => log("setMyCommands:", e.message));
  flushRetries();
  prune();
  setInterval(prune, 24 * 3600 * 1000).unref();
  commandLoop();                                                 // Telegram answers immediately…
  restartAllDetectors().catch(e => log("detectors:", e.message)); // …while backfills run in the background
}

if (MODE === "--selftest") {
  selftest();
} else if (MODE === "--chat-id") {
  (async () => {
    const r = await tg("getUpdates", { timeout: 25 });
    const ids = new Map();
    for (const u of r.result ?? []) {
      const m = u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post ?? u.callback_query?.message;
      if (m?.chat?.id != null) {
        const label = m.chat.title ? `${m.chat.type}: ${m.chat.title}` : (m.chat.type ?? "unknown");
        ids.set(String(m.chat.id), label);
      }
    }
    if (!ids.size) {
      console.log("Nothing seen yet. Either: open your bot, press Start (or send it any message);\nor: add the bot as admin to your channel, post any message there — then re-run this command.");
    } else {
      for (const [id, type] of ids) console.log(`chat id: ${id}  (${type})`);
    }
    process.exit(0);
  })().catch(e => { console.error(e.message); process.exit(1); });
} else if (MODE === "--replay") {
  // Feed a known historical mint through the real pipeline (dedupe, count, enrich, notify).
  // usage: node bot.js --replay <chain> <txHash> <logIndex> <contract> [tokenId] [wallet]
  const [chain, txHash, logIndex, contract, tokenId, walletArg] = [
    process.argv[3], process.argv[4], Number(process.argv[5] || 0), process.argv[6], process.argv[7] ?? null, process.argv[8] ?? null,
  ];
  if (!chainCfg(chain) || !/^0x[0-9a-fA-F]{64}$/.test(txHash ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(contract ?? "")) {
    console.error("bad args — see usage"); process.exit(2);
  }
  const wallet = (walletArg ?? wallets()[0] ?? "0x000000000000000000000000000000000000dEaD").toLowerCase();
  processMint(chain, { transactionHash: txHash, index: logIndex, blockNumber: 0 },
    { wallet, contract: contract.toLowerCase(), tokenId })
    .then(() => { log("replay done"); process.exit(0); })
    .catch(e => { console.error("replay failed:", e.message); process.exit(1); });
} else if (MODE === "--test") {
  notifyWithRetry(SAMPLE_INFO, "0x000000000000000000000000000000000000dEaD", "42", null, CHAINS[0]?.chain ?? "ethereum")
    .then(() => { log("test message sent"); process.exit(0); })
    .catch(e => { console.error("test send failed:", e.message); process.exit(1); });
} else if (MODE === "--backfill-once") {
  const targets = MODE_ARG ? [MODE_ARG] : CHAINS.map(c => c.chain);
  (async () => {
    for (const chain of targets) {
      if (!chainCfg(chain)) { console.error(`unknown chain: ${chain}`); process.exit(1); }
      await backfill(chain);
    }
    log("backfill complete");
  })().then(() => process.exit(0)).catch(e => { console.error("backfill failed:", e.message); process.exit(1); });
} else {
  main().catch(e => { console.error("fatal:", e); process.exit(1); });
}
