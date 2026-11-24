// Skim — browser as a cheap tool for AI agents.
// Compact page digest, action-by-id, diffs, tabs, plans.
//
//   node src/server.mjs            → http://127.0.0.1:9879
//
// Config (env):
//   SKIM_STATE_DIR   state/profile dir, default ~/.skim (falls back to an existing ~/.glean)
//   SKIM_PORT        port, default 9879
//   legacy GLEAN_* env names are still read if the SKIM_* one is missing
//   SKIM_BROWSER     path to chrome/msedge executable (auto-detected otherwise)
//   SKIM_HEADLESS    1 (default) or 0
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env } from './env.mjs';

const PORT = Number(env('SKIM_PORT') || 9879);
const HOME = os.homedir();
const defaultState = () => {
  // keep an existing legacy profile (cookies, logins) unless the new dir is already there
  const fresh = path.join(HOME, '.skim');
  const legacy = path.join(HOME, '.glean');
  return !fs.existsSync(fresh) && fs.existsSync(legacy) ? legacy : fresh;
};
const STATE = env('SKIM_STATE_DIR') || defaultState();
const PROFILE = path.join(STATE, 'profile');
const PLAN = path.join(STATE, 'plan.json');
const DL = path.join(STATE, 'downloads');
const MAX_TABS = Number(env('SKIM_MAX_TABS') || 5);
const MIN_GAP = Number(env('SKIM_MIN_GAP_MS') || 700);
const HEADLESS = env('SKIM_HEADLESS') !== '0';
fs.mkdirSync(DL, { recursive: true });

let ctx = null;
const tabs = new Map();
const lastHit = new Map();
let seq = 0;

function findBrowser() {
  if (env('SKIM_BROWSER')) return env('SKIM_BROWSER');
  const c = [
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return c.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

async function ensure() {
  if (ctx) return;
  const exe = findBrowser();
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    ...(exe ? { executablePath: exe } : {}),
    viewport: { width: 1280, height: 860 },
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-first-run'],
  });
  // If the user closes the browser window, drop the dead context so the next
  // call relaunches instead of failing forever with "browser has been closed".
  ctx.on('close', () => { ctx = null; tabs.clear(); });
  for (const p of ctx.pages()) wire(p);
}

function wire(page) {
  page.on('close', () => { for (const [id, t] of tabs) if (t.page === page) tabs.delete(id); });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('download', async (d) => {
    try {
      const name = (d.suggestedFilename() || 'file').replace(/[^\w.\-]+/g, '_');
      const out = path.join(DL, Date.now() + '-' + name);
      await d.saveAs(out);
      page._lastDownload = out;
    } catch {}
  });
}

function attachRoutes(t) {
  t.page.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (t.blockHeavy && (type === 'image' || type === 'media' || type === 'font')) return route.abort();
    if (/google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.io|mc\.yandex/.test(req.url())) return route.abort();
    return route.continue();
  }).catch(() => {});
}

async function newTab(id) {
  const page = await ctx.newPage();
  wire(page);
  const t = { id: id || 't' + (++seq), page, els: [], url: '', at: Date.now(), blockHeavy: true, snap: [] };
  attachRoutes(t);
  tabs.set(t.id, t);
  return t;
}

async function getTab(id, createIfMissing) {
  await ensure();
  if (id) {
    if (tabs.has(id)) return tabs.get(id);
    if (createIfMissing) return newTab(id);
    throw new Error('no such tab: ' + id + ' (create one with POST /tab)');
  }
  if (!tabs.size) return newTab('t1');
  return [...tabs.values()].sort((a, b) => b.at - a.at)[0];
}

async function throttle(url) {
  let host = '';
  try { host = new URL(url).host; } catch { return; }
  const prev = lastHit.get(host) || 0;
  const wait = MIN_GAP - (Date.now() - prev);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

/* collect interactive elements from DOM, shadow roots and same-origin iframes */
const COLLECT = (limit) => {
  const SEL = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    return r.top < innerHeight * 1.8 && r.bottom > -innerHeight * 0.8;
  };
  const nameOf = (el) => {
    const a = el.getAttribute('aria-label');
    if (a) return a.trim();
    const ph = el.getAttribute('placeholder');
    if (ph) return ph.trim();
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) return t;
    return (el.getAttribute('title') || el.getAttribute('name') || '').trim();
  };
  const found = [];
  const walk = (root, frameIdx) => {
    if (!root) return;
    for (const el of root.querySelectorAll(SEL)) found.push({ el, frameIdx });
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, frameIdx);
  };
  walk(document, null);
  for (let i = 0; i < window.frames.length; i++) {
    try { const d = window.frames[i].document; if (d) walk(d, i); } catch {}
  }

  const weight = (k) => (k.startsWith('input') ? 0 : k === 'button' || k === 'role' ? 1 : k === 'a' ? 3 : 2);
  const out = [];
  const seen = new Set();
  let n = 0;
  for (const { el, frameIdx } of found) {
    if (out.length >= limit * 4) break;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const name = nameOf(el).slice(0, 55);
    if (!name && tag !== 'input') continue;
    let kind = tag;
    if (tag === 'input') kind = 'input:' + (el.getAttribute('type') || 'text');
    if (el.getAttribute('role')) kind = el.getAttribute('role');
    const key = kind + '|' + name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const wd = 'w' + (++n);
    el.setAttribute('data-skim', wd);
    const r = el.getBoundingClientRect();
    out.push({ kind, name, wd, frame: frameIdx, key, y: Math.round(r.top + scrollY) });
  }
  out.sort((a, b) => weight(a.kind) - weight(b.kind) || a.y - b.y);
  return out.slice(0, limit);
};

const CAPTCHA = () => {
  const s = ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '.g-recaptcha', '#captcha', 'input[name*="captcha" i]', '[class*="captcha" i]', '#challenge-form'];
  return s.some((q) => { try { return !!document.querySelector(q); } catch { return false; } });
};

async function load(t, url, visual) {
  t.blockHeavy = !visual;
  t.at = Date.now();
  const t0 = Date.now();
  await throttle(url);
  let err = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await t.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); err = null; break; }
    catch (e) { err = e; await t.page.waitForTimeout(400); }
  }
  if (err) throw new Error('navigation failed: ' + String(err.message || err).slice(0, 120));
  if (visual) {
    await t.page.evaluate(() => Promise.race([
      Promise.all([...document.images].map((i) => i.decode().catch(() => {}))),
      new Promise((r) => setTimeout(r, 1600)),
    ])).catch(() => {});
  } else {
    await t.page.waitForTimeout(110);
  }
  const els = await t.page.evaluate(COLLECT, 80);
  const captcha = await t.page.evaluate(CAPTCHA).catch(() => false);
  t.els = els;
  t.url = t.page.url();
  t.snap = els.map((e) => e.key);
  const title = await t.page.title().catch(() => '');
  const digest = `PAGE ${title.slice(0, 70)}\nURL ${t.url}\nTAB ${t.id}${captcha ? '\n! CAPTCHA detected' : ''}\n\n`
    + els.map((e, i) => `e${i + 1} ${e.kind} "${e.name}"`).join('\n');
  return { tab: t.id, ms: Date.now() - t0, tokens: Math.round(digest.length / 4), count: els.length, captcha, digest };
}

async function diff(t) {
  const els = await t.page.evaluate(COLLECT, 80);
  const prev = new Set(t.snap);
  const added = els.filter((e) => !prev.has(e.key));
  t.els = els;
  t.snap = els.map((e) => e.key);
  t.url = t.page.url();
  return { tab: t.id, url: t.url, changed: added.length, added: added.slice(0, 25).map((e) => `${e.kind} "${e.name}"`), total: els.length };
}

function locatorFor(t, it) {
  const sel = `[data-skim="${it.wd}"]`;
  if (it.frame === null || it.frame === undefined) return t.page.locator(sel).first();
  return t.page.frames()[it.frame].locator(sel).first();
}

async function act(t, id, action, text) {
  const idx = Number(String(id).replace(/\D/g, '')) - 1;
  let it = t.els[idx];
  if (!it) return { ok: false, error: 'no element ' + id + ' — collect a fresh digest (/diff)' };
  // React перерисовывает DOM и стирает data-skim — переснимаем и находим тот же элемент по ключу
  try {
    const fresh = await t.page.evaluate(COLLECT, 80);
    const i2 = Array.isArray(fresh) ? fresh.findIndex((e) => e.key === it.key) : -1;
    if (i2 >= 0) { t.els = fresh; it = fresh[i2]; }
  } catch {}
  const before = t.page.url();
  const t0 = Date.now();
  try {
    const loc = locatorFor(t, it);
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    if (action === 'type') await loc.fill(text || '', { timeout: 6000 });
    else if (action === 'press') await loc.press(text || 'Enter', { timeout: 6000 });
    else if (action === 'upload') await loc.setInputFiles(text || '', { timeout: 8000 });
    else await loc.click({ timeout: 6000 });
  } catch (e) {
    try { await locatorFor(t, it).click({ timeout: 1500, force: true }); }
    catch { return { ok: false, error: String(e.message || e).slice(0, 160) }; }
  }
  let verified = false;
  for (let i = 0; i < 14; i++) {
    await t.page.waitForTimeout(140);
    if (t.page.url() !== before) { verified = true; break; }
    const n = await t.page.evaluate(() => document.querySelectorAll('a,button,input').length).catch(() => -1);
    if (n >= 0 && n !== t.els.length) { verified = true; break; }
  }
  const d = await diff(t);
  const dl = t.page._lastDownload || null;
  if (t.page.url() !== before) {
    const digest = 'PAGE ' + (await t.page.title().catch(() => '')).slice(0, 70) + '\nURL ' + t.page.url() + '\nTAB ' + t.id + '\n\n'
      + t.els.map((e, i) => `e${i + 1} ${e.kind} "${e.name}"`).join('\n');
    return { ok: true, action, target: it.name, ms: Date.now() - t0, verified, navigated: true, download: dl, tab: t.id, tokens: Math.round(digest.length / 4), digest };
  }
  return { ok: true, action, target: it.name, ms: Date.now() - t0, verified, download: dl, ...d };
}

function plan(action, steps) {
  const read = () => (fs.existsSync(PLAN) ? JSON.parse(fs.readFileSync(PLAN, 'utf8')) : { steps: [] });
  if (action === 'set') { fs.writeFileSync(PLAN, JSON.stringify({ steps, at: Date.now() }, null, 2)); return { saved: steps.length }; }
  if (action === 'done') {
    const p = read();
    p.steps = (p.steps || []).filter((s) => String(s.id) !== String(steps));
    fs.writeFileSync(PLAN, JSON.stringify(p, null, 2));
    return { left: p.steps.length };
  }
  return read();
}

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/health') return send(200, { ok: true, tabs: [...tabs.keys()] });
    if (u.pathname === '/tabs') return send(200, { tabs: [...tabs.entries()].map(([id, t]) => ({ id, url: t.url, at: t.at })) });
    if (u.pathname === '/tab') { await ensure(); const t = await newTab(u.searchParams.get('id')); return send(200, { tab: t.id }); }
    if (u.pathname === '/close') {
      const id = u.searchParams.get('tab');
      const t = tabs.get(id);
      if (!t) return send(404, { error: 'no such tab' });
      await t.page.close().catch(() => {});
      tabs.delete(id);
      return send(200, { closed: id });
    }
    if (u.pathname === '/go') {
      const t = await getTab(u.searchParams.get('tab'), true);
      return send(200, await load(t, u.searchParams.get('url'), u.searchParams.has('visual')));
    }
    if (u.pathname === '/act') {
      const b = await body(req);
      return send(200, await act(await getTab(b.tab), b.id, b.action || 'click', b.text));
    }
    if (u.pathname === '/diff') return send(200, await diff(await getTab(u.searchParams.get('tab'))));
    if (u.pathname === '/read') {
      const t = await getTab(u.searchParams.get('tab'));
      if (u.searchParams.get('url')) await load(t, u.searchParams.get('url'), false);
      const text = await t.page.evaluate(() => {
        const m = document.querySelector('article, main, [role="main"]') || document.body;
        return (m.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 7000);
      });
      return send(200, { chars: text.length, tokens: Math.round(text.length / 4), text });
    }
    if (u.pathname === '/shot') {
      const t = await getTab(u.searchParams.get('tab'));
      if (u.searchParams.has('visual')) { t.blockHeavy = false; await t.page.reload({ waitUntil: 'load', timeout: 20000 }).catch(() => {}); }
      const buf = await t.page.screenshot({ type: 'jpeg', quality: 55 });
      const save = u.searchParams.get('save');
      if (save) { fs.writeFileSync(save, buf); return send(200, { saved: save, kb: Math.round(buf.length / 1024) }); }
      return send(200, { bytes: buf.length });
    }
    if (u.pathname === '/plan') { const b = await body(req); return send(200, plan(b.action, b.steps ?? b.id)); }
    if (u.pathname === '/clickat') {
      const b = await body(req);
      const t = await getTab(b.tab);
      await t.page.mouse.click(Number(b.x), Number(b.y));
      return send(200, { ok: true });
    }
    if (u.pathname === '/move') {
      const b = await body(req);
      const t = await getTab(b.tab);
      await t.page.mouse.move(Number(b.x), Number(b.y));
      return send(200, { ok: true });
    }
    if (u.pathname === '/js') {
      if (env('SKIM_ALLOW_JS') !== '1') return send(403, { error: 'set SKIM_ALLOW_JS=1 to enable /js' });
      const b = await body(req);
      const t = await getTab(b.tab);
      const r = await t.page.evaluate(b.expr);
      return send(200, { result: r });
    }
    return send(404, { error: 'unknown endpoint' });
  } catch (e) { return send(500, { error: String(e.message || e).slice(0, 200) }); }
});

function body(req) {
  return new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
}

srv.listen(PORT, '127.0.0.1', async () => {
  console.log('[skim] http://127.0.0.1:' + PORT);
  ensure().then(() => console.log('[skim] browser warm')).catch((e) => console.log('[skim] browser error:', e.message));
});
