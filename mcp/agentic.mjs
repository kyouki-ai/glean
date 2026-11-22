#!/usr/bin/env node
// agentic MCP server (stdio): один сервер вместо десятков мелких инструментов.
// JSON-RPC 2.0, одно сообщение на строку.
import readline from 'node:readline';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';

const ROOT = process.env.AGENTIC_ROOT || process.cwd();
const SERVER = { name: 'agentic', version: '0.1.0' };
const MAX_OUT = Number(process.env.AGENTIC_MAX_OUT || 24000);
const GLEAN = process.env.GLEAN_URL || 'http://127.0.0.1:9879';
const GLEAN_DIR = process.env.GLEAN_DIR || (fs.existsSync(path.join(ROOT, 'projects', 'glean', 'src', 'server.mjs'))
  ? path.join(ROOT, 'projects', 'glean')
  : ROOT);
const GLEAN_AUTOSTART = process.env.GLEAN_AUTOSTART !== '0';

let gleanStarting = null;
async function gleanUp() {
  try {
    const r = await fetch(GLEAN + '/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}
async function ensureGlean() {
  if (await gleanUp()) return true;
  if (!GLEAN_AUTOSTART) return false;
  if (!gleanStarting) {
    gleanStarting = (async () => {
      const child = spawn(process.execPath, [path.join(GLEAN_DIR, 'src', 'server.mjs')], {
        cwd: GLEAN_DIR,
        env: { ...process.env, GLEAN_HEADLESS: process.env.GLEAN_HEADLESS || '0', GLEAN_ALLOW_JS: process.env.GLEAN_ALLOW_JS || '1' },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await gleanUp()) return true;
      }
      return false;
    })().finally(() => { gleanStarting = null; });
  }
  return gleanStarting;
}

const TOOLS = [
  {
    name: 'read',
    description: 'Read one or many text files (UTF-8) with line numbers. Batch: pass paths array.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to workspace root.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Several files at once.' },
        offset: { type: 'number', description: 'First line (1-based).' },
        limit: { type: 'number', description: 'Max lines per file.' },
      },
    },
  },
  {
    name: 'write',
    description: 'Create or overwrite files. Batch: pass files [{path, content}].',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      },
    },
  },
  {
    name: 'edit',
    description: 'Replace literal text in files. Batch: pass edits [{path, old, new}].',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old: { type: 'string' },
        new: { type: 'string' },
        all: { type: 'boolean', description: 'Replace all matches.' },
        edits: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
      },
    },
  },
  {
    name: 'find',
    description: 'Search files: mode=grep (regex over contents) or mode=glob (paths). One call instead of grep+glob.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Regex (grep) or glob like **/*.md (glob).' },
        mode: { type: 'string', enum: ['grep', 'glob'], description: 'Default grep.' },
        path: { type: 'string', description: 'Directory to search, relative to root.' },
        max: { type: 'number', description: 'Max results. Default 60.' },
        ignore: { type: 'string', description: 'Regex of paths to skip. Default node_modules|\\.git|\\.asar' },
      },
      required: ['q'],
    },
  },
  {
    name: 'run',
    description: 'Run a shell command (PowerShell on Windows) and return tail of output plus exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Command line.' },
        cwd: { type: 'string', description: 'Working dir, relative to root.' },
        timeoutSec: { type: 'number', description: 'Default 120.' },
        tail: { type: 'number', description: 'Return last N lines. Default 60.' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'note',
    description: 'Append a line to NOTES.md (workspace memory) or read its tail.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Line to append. Omit to read last 40 lines.' },
        file: { type: 'string', description: 'Default NOTES.md.' },
      },
    },
  },
  {
    name: 'ui',
    description: 'Browser through the local glean server: open a URL (compact digest with e1.. ids), act by id, read text, list tabs, plan.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['open', 'act', 'read', 'tabs', 'plan'], description: 'Default open.' },
        url: { type: 'string', description: 'For open.' },
        id: { type: 'string', description: 'For act: element id like e3.' },
        action: { type: 'string', enum: ['click', 'type', 'press', 'upload'], description: 'For act.' },
        text: { type: 'string', description: 'For act: text/key/path.' },
        tab: { type: 'string', description: 'Tab id, e.g. t1.' },
        steps: { type: 'array', description: 'For plan set.' },
      },
    },
  },
];

const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s);

async function readFile(p, offset, limit) {
  const text = await fsp.readFile(abs(p), 'utf8');
  const lines = text.split('\n');
  const start = Math.max(0, (offset || 1) - 1);
  const end = limit ? start + limit : lines.length;
  return `=== ${p} (${lines.length} lines)\n` + lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n');
}

function globToRe(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.').replace(/\u0000/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}

function walk(dir, out, skip) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (skip.test(p)) continue;
    if (e.isDirectory()) walk(p, out, skip);
    else out.push(p);
  }
}

async function runTool(name, a = {}) {
  if (name === 'read') {
    const paths = a.paths && a.paths.length ? a.paths : a.path ? [a.path] : [];
    if (!paths.length) throw new Error('path or paths required');
    const out = [];
    for (const p of paths) out.push(await readFile(p, a.offset, a.limit));
    return clip(out.join('\n\n'));
  }
  if (name === 'write') {
    const files = a.files && a.files.length ? a.files : a.path !== undefined ? [{ path: a.path, content: a.content ?? '' }] : [];
    if (!files.length) throw new Error('path+content or files required');
    const done = [];
    for (const f of files) {
      const target = abs(f.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, f.content, 'utf8');
      done.push(`${f.path} (${f.content.length} chars)`);
    }
    return 'written: ' + done.join(', ');
  }
  if (name === 'edit') {
    const edits = a.edits && a.edits.length ? a.edits : a.path !== undefined ? [{ path: a.path, old: a.old, new: a.new }] : [];
    if (!edits.length) throw new Error('path+old+new or edits required');
    const done = [];
    for (const e of edits) {
      const target = abs(e.path);
      const text = await fsp.readFile(target, 'utf8');
      if (!text.includes(e.old)) { done.push(`${e.path}: NOT FOUND`); continue; }
      const next = a.all ? text.split(e.old).join(e.new) : text.replace(e.old, e.new);
      await fsp.writeFile(target, next, 'utf8');
      done.push(`${e.path}: ok`);
    }
    return done.join('\n');
  }
  if (name === 'find') {
    const mode = a.mode || 'grep';
    const base = abs(a.path || '.');
    const max = a.max || 60;
    const skip = new RegExp(a.ignore || 'node_modules|\\\\\\.git|\\.asar|/dist/|/tmp/', 'i');
    const files = [];
    walk(base, files, skip);
    if (mode === 'glob') {
      const re = globToRe(a.q);
      const hits = files.filter((f) => re.test(f) || re.test(path.relative(ROOT, f).replace(/\\/g, '/')));
      return clip(hits.slice(0, max).map((f) => path.relative(ROOT, f)).join('\n') || 'no matches');
    }
    const re = new RegExp(a.q, 'i');
    const out = [];
    for (const f of files) {
      if (out.length >= max) break;
      let text;
      try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
      if (text.length > 2_000_000) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < max; i++) {
        if (re.test(lines[i])) out.push(`${path.relative(ROOT, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
    return clip(out.join('\n') || 'no matches');
  }
  if (name === 'run') {
    const cwd = abs(a.cwd || '.');
    const timeout = (a.timeoutSec || 120) * 1000;
    const cmd = process.platform === 'win32' ? `powershell -NoProfile -Command "${a.cmd.replace(/"/g, '\\"')}"` : a.cmd;
    return await new Promise((resolve) => {
      exec(cmd, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const lines = (String(stdout) + String(stderr)).split('\n');
        const tail = lines.slice(-(a.tail || 60)).join('\n');
        const code = err ? (err.code ?? 1) : 0;
        resolve(clip(`exit=${code}\n${tail}`));
      });
    });
  }
  if (name === 'note') {
    const file = abs(a.file || 'NOTES.md');
    if (a.text === undefined || a.text === null) {
      const t = await fsp.readFile(file, 'utf8');
      return clip(t.split('\n').slice(-40).join('\n'));
    }
    await fsp.appendFile(file, '\n' + a.text + '\n', 'utf8');
    return 'noted';
  }
  if (name === 'ui') {
    if (!(await ensureGlean())) throw new Error('glean server is not running and autostart failed: ' + GLEAN);
    const BASE = GLEAN;
    const call = async (method, p, body) => {
      const res = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) throw new Error(j.error || 'HTTP ' + res.status);
      return j;
    };
    const op = a.op || 'open';
    const q = new URLSearchParams();
    if (a.tab) q.set('tab', a.tab);
    if (op === 'open') {
      q.set('url', a.url);
      const r = await call('GET', '/go?' + q.toString());
      return clip(r.digest || JSON.stringify(r));
    }
    if (op === 'act') return clip(JSON.stringify(await call('POST', '/act', { tab: a.tab, id: a.id, action: a.action || 'click', text: a.text })));
    if (op === 'read') return clip((await call('GET', '/read?' + q.toString())).text || '');
    if (op === 'tabs') return clip(JSON.stringify(await call('GET', '/tabs')));
    if (op === 'plan') return clip(JSON.stringify(await call('POST', '/plan', { action: a.steps ? 'set' : 'get', steps: a.steps })));
    throw new Error('unknown op: ' + op);
  }
  throw new Error('unknown tool: ' + name);
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
if (GLEAN_AUTOSTART) ensureGlean().catch(() => {});
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER } });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (method === 'tools/call') {
      try {
        const output = await runTool(params?.name, params?.arguments || {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(output) }] } });
      } catch (e) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + String(e.message || e) }], isError: true } });
      }
      return;
    }
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
});

process.stderr.write('[agentic-mcp] ready, root=' + ROOT + '\n');
