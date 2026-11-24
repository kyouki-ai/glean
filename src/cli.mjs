#!/usr/bin/env node
// skim — one-shot compact digest of a page, no server needed.
//   npx skim <url> [--visual] [--json] [--max=80]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { env } from './env.mjs';

const url = process.argv.slice(2).find((a) => !a.startsWith('--'));
const visual = process.argv.includes('--visual');
const asJson = process.argv.includes('--json');
const max = Number((process.argv.find((a) => a.startsWith('--max=')) || '--max=80').split('=')[1]);
if (!url) {
  console.error('usage: skim <url> [--visual] [--json] [--max=80]');
  process.exit(1);
}

function findBrowser() {
  if (env('SKIM_BROWSER')) return env('SKIM_BROWSER');
  const c = [
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  return c.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

const COLLECT = (limit) => {
  const SEL = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) >= 0.05
      && r.top < innerHeight * 1.8 && r.bottom > -innerHeight * 0.8;
  };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder')
    || (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    || el.getAttribute('title') || el.getAttribute('name') || '').slice(0, 55);
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const name = nameOf(el);
    if (!name && tag !== 'input') continue;
    let kind = tag === 'input' ? 'input:' + (el.getAttribute('type') || 'text') : tag;
    if (el.getAttribute('role')) kind = el.getAttribute('role');
    const key = kind + '|' + name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, name });
    if (out.length >= limit) break;
  }
  const weight = (k) => (k.startsWith('input') ? 0 : k === 'button' ? 1 : k === 'a' ? 3 : 2);
  return { title: document.title.slice(0, 70), url: location.href, els: out.sort((a, b) => weight(a.kind) - weight(b.kind)), htmlLen: document.documentElement.outerHTML.length };
};

const exe = findBrowser();
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
if (!visual) {
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });
}
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(visual ? 900 : 120);
const data = await page.evaluate(COLLECT, max);
await browser.close();

const digest = `PAGE ${data.title}\nURL ${data.url}\n\n` + data.els.map((e, i) => `e${i + 1} ${e.kind} "${e.name}"`).join('\n');
const est = (v) => Math.round((typeof v === 'number' ? v : String(v).length) / 4);
const report = { url, ms: Date.now() - t0, elements: data.els.length, html_tokens: est(data.htmlLen), digest_tokens: est(digest), saving_x: Number((data.htmlLen / digest.length).toFixed(1)) };

if (asJson) console.log(JSON.stringify({ report, digest }, null, 2));
else { console.log(digest); console.log('\n--- ' + JSON.stringify(report)); }
