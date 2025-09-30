import 'dotenv/config';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Telegraf, session } from 'telegraf';
import axios from 'axios';
import FormData from 'form-data';

// ====== ENV ======
const {
  TELEGRAM_BOT_TOKEN,
  MASTER_KEY,
  WORKER_JS_URL = 'https://github.com/bia-pain-bache/BPB-Worker-Panel/releases/download/v3.5.6/worker.js'
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
if (!MASTER_KEY || MASTER_KEY.length < 24) {
  throw new Error('MASTER_KEY must be a long random string (>=24 chars)');
}

// ====== DB (SQLite on persistent volume) ======
const db = new Database('/data/bot.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id TEXT PRIMARY KEY,
  cf_account_id TEXT NOT NULL,
  cf_token_enc BLOB NOT NULL,
  worker_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ====== Simple AES-GCM helpers ======
function enc(plaintext) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(MASTER_KEY).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]); // 12|16|N
}
function dec(blob) {
  const key = crypto.createHash('sha256').update(MASTER_KEY).digest();
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct  = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ====== Per-user Cloudflare client builder ======
function cfClient(cfToken) {
  return axios.create({
    baseURL: 'https://api.cloudflare.com/client/v4',
    headers: { Authorization: `Bearer ${cfToken}` },
    timeout: 30000
  });
}

// ====== Cloudflare ops ======
async function getWorkersSubdomain(cf, accountId) {
  const r = await cf.get(`/accounts/${accountId}/workers/subdomain`);
  return r.data?.result?.subdomain;
}

async function ensureKvNamespace(cf, accountId, title) {
  try {
    const r = await cf.post(`/accounts/${accountId}/storage/kv/namespaces`, { title });
    return r.data.result.id;
  } catch (e) {
    // Reuse if exists
    if (e?.response?.status === 400) {
      const list = await cf.get(`/accounts/${accountId}/storage/kv/namespaces`, { params: { per_page: 1000 } });
      const hit = (list.data?.result || []).find(n => n.title === title);
      if (hit) return hit.id;
    }
    throw e;
  }
}

async function downloadWorkerScript(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(r.data);
}

async function uploadModule(cf, accountId, { workerName, scriptBuf, kvId, vars = {} }) {
  const metadata = {
    name: workerName,
    main_module: 'worker.js',
    compatibility_date: '2025-01-01',
    bindings: [{ type: 'kv_namespace', name: 'kv', namespace_id: kvId }],
    vars
  };
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' });
  form.append('worker.js', scriptBuf, { filename: 'worker.js', contentType: 'application/javascript' });
  const url = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`;
  const r = await cf.put(url, form, { headers: form.getHeaders() });
  return r.data;
}

async function uploadClassic(cf, accountId, { workerName, scriptBuf, kvId, vars = {} }) {
  const metadata = {
    body_part: 'script',
    bindings: [{ type: 'kv_namespace', name: 'kv', namespace_id: kvId }],
    vars
  };
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' });
  form.append('script', scriptBuf, { filename: 'script.js', contentType: 'application/javascript' });
  const url = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`;
  const r = await cf.put(url, form, { headers: form.getHeaders() });
  return r.data;
}

async function deployWorker(cf, accountId, args) {
  try {
    return await uploadModule(cf, accountId, args);
  } catch (e) {
    const msg = JSON.stringify(e?.response?.data?.errors || e.message || '');
    if (msg.includes('only supports classic') || msg.includes('modules')) {
      return await uploadClassic(cf, accountId, args);
    }
    throw e;
  }
}

function scrapeSecrets(html) {
  const uuidReA = /["']UUID["']\s*[:=]\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})["']/i;
  const uuidReB = /name=["']UUID["'][^>]*value=["']([0-9a-f-]{36})["']/i;
  const trA = /["']TR[_-]?PASS["']\s*[:=]\s*["']([A-Za-z0-9\-_.]{6,})["']/i;
  const trB = /name=["']TR_pass["'][^>]*value=["']([^"']+)["']/i;
  const uuid = (html.match(uuidReA) || html.match(uuidReB))?.[1];
  const tr = (html.match(trA) || html.match(trB))?.[1];
  return (uuid && tr) ? { uuid, tr } : null;
}

async function pollForSecrets(baseUrl) {
  const candidates = [baseUrl, `${baseUrl}/panel`];
  for (let i = 0; i < 10; i++) {
    for (const url of candidates) {
      try {
        const res = await axios.get(url, { timeout: 15000 });
        const vals = scrapeSecrets(String(res.data || ''));
        if (vals) return vals;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 20000)); // 20s
  }
  return null;
}

// ====== Bot ======
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
bot.use(session());

const getUser = db.prepare('SELECT * FROM users WHERE tg_id = ?');
const upsertUser = db.prepare(`
INSERT INTO users (tg_id, cf_account_id, cf_token_enc, worker_name) VALUES (?, ?, ?, ?)
ON CONFLICT(tg_id) DO UPDATE SET
  cf_account_id=excluded.cf_account_id,
  cf_token_enc=excluded.cf_token_enc
`);
const setWorker = db.prepare(`UPDATE users SET worker_name = ? WHERE tg_id = ?`);
const delUser = db.prepare('DELETE FROM users WHERE tg_id = ?');

bot.start(ctx =>
  ctx.reply(
    'Hey! Use:\n' +
    '/connect <CLOUDFLARE_ACCOUNT_ID> → then paste your API Token (Workers+KV: Edit)\n' +
    '/automation → deploy Worker+KV and get your /panel URL\n' +
    '/status → connection status\n' +
    '/forget → delete saved Cloudflare token'
  )
);

bot.command('status', (ctx) => {
  const u = getUser.get(String(ctx.from.id));
  if (!u) return ctx.reply('Not connected. Use /connect <ACCOUNT_ID>.');
  return ctx.reply(
    `Connected ✅\nAccount: ${u.cf_account_id}\nWorker: ${u.worker_name || '—'}`
  );
});

bot.command('forget', (ctx) => {
  delUser.run(String(ctx.from.id));
  ctx.reply('Your Cloudflare token was removed. You can /connect again anytime.');
});

bot.command('connect', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('Usage: /connect <CLOUDFLARE_ACCOUNT_ID>');
  }
  const accountId = parts[1];
  ctx.session = { awaitingToken: { accountId } };
  return ctx.reply(
    'Now send your *Cloudflare API Token* **as a reply to this message**.\n' +
    'Tip: after I save it, you can delete your message on your side.'
  );
});

// Capture next message as the API token when waiting
bot.on('message', async (ctx, next) => {
  if (!ctx.session?.awaitingToken) return next();
  const token = (ctx.message.text || '').trim();
  if (!token || token.length < 20) {
    return ctx.reply('That does not look like an API token. Please paste the token string.');
  }
  const { accountId } = ctx.session.awaitingToken;
  delete ctx.session.awaitingToken;

  // Save encrypted
  const blob = enc(token);
  upsertUser.run(String(ctx.from.id), accountId, blob, null);
  return ctx.reply('Saved ✅. You can now run /automation');
});

bot.command('automation', async (ctx) => {
  const u = getUser.get(String(ctx.from.id));
  if (!u) return ctx.reply('Not connected. Run /connect <ACCOUNT_ID> first.');

  let cfToken;
  try { cfToken = dec(u.cf_token_enc); } catch { return ctx.reply('Could not read your token. /connect again.'); }
  const cf = cfClient(cfToken);

  const workerName = u.worker_name || `bpb-${crypto.randomBytes(3).toString('hex')}`;

  try {
    await ctx.reply(`🔧 Deploying worker \`${workerName}\` …`);
    const kvId = await ensureKvNamespace(cf, u.cf_account_id, `kv-${workerName}`);
    const scriptBuf = await downloadWorkerScript(WORKER_JS_URL);
    await deployWorker(cf, u.cf_account_id, { workerName, scriptBuf, kvId });

    const subdomain = await getWorkersSubdomain(cf, u.cf_account_id);
    if (!subdomain) {
      return ctx.reply('Could not determine your workers.dev subdomain. Open Cloudflare → Workers & Pages once to initialize it.');
    }
    const base = `https://${workerName}.${subdomain}.workers.dev`;
    setWorker.run(workerName, String(ctx.from.id));

    await ctx.reply(`✅ Worker deployed:\n${base}\n⏳ Initializing panel…`);

    const vals = await pollForSecrets(base);
    if (vals) {
      await ctx.reply(`Found values. Applying as Worker variables…`);
      await deployWorker(cf, u.cf_account_id, {
        workerName,
        scriptBuf,
        kvId,
        vars: { UUID: vals.uuid, TR_pass: vals.tr }
      });
      return ctx.reply(`🎉 Done: ${base}/panel`);
    } else {
      return ctx.reply(
        `Could not auto-detect UUID/TR_pass yet.\n` +
        `Open ${base}/panel, copy the values, then in Cloudflare → Workers → ${workerName} → Settings → Variables, add:\n` +
        `• UUID = <uuid>\n• TR_pass = <password>\n` +
        `Save & redeploy. Your panel will be at: ${base}/panel`
      );
    }
  } catch (e) {
    console.error(e?.response?.data || e);
    return ctx.reply('❌ Failed to deploy. Check your token scopes and account ID, then try again.');
  }
});

bot.launch().then(() => console.log('Bot running'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
