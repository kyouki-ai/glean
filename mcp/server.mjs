#!/usr/bin/env node
// Skim MCP server (stdio): exposes a running skim server to any MCP client.
//   node mcp/server.mjs            (expects skim-server on SKIM_URL or http://127.0.0.1:9879)
// JSON-RPC 2.0 over stdin/stdout, one message per line.
import readline from 'node:readline';
import { env } from '../src/env.mjs';

const BASE = env('SKIM_URL') || 'http://127.0.0.1:9879';
const SERVER = { name: 'skim', version: '0.1.0' };

const TOOLS = [
  {
    name: 'browser_open',
    description: 'Open a URL and return a compact digest of interactive elements (inputs, buttons, links) with short ids e1, e2, ... Much cheaper than a DOM dump.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to open.' },
        tab: { type: 'string', description: 'Reuse an existing tab id (e.g. t1). Omit to use the newest tab.' },
        visual: { type: 'boolean', description: 'Keep images and fonts (slower, for sites that need them).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_act',
    description: 'Click, type, press a key, or upload a file into an element by its digest id. Returns a fresh digest after navigation or only the changed elements otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Element id from the last digest, e.g. e3.' },
        action: { type: 'string', enum: ['click', 'type', 'press', 'upload'], description: 'What to do with the element. Default click.' },
        text: { type: 'string', description: 'Text to type, key to press, or absolute file path to upload.' },
        tab: { type: 'string', description: 'Tab id. Omit for the newest tab.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_read',
    description: 'Return the main readable text of the current page, truncated to keep the answer small.',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Tab id. Omit for the newest tab.' } },
    },
  },
  {
    name: 'browser_tabs',
    description: 'List open tabs with their current URLs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_plan',
    description: 'Read or edit a step plan kept outside the model context, so long tasks survive context compaction.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'done'], description: 'get returns the plan, set replaces it, done removes one step.' },
        steps: { type: 'array', description: 'For set: array of steps, e.g. [{id:1, text:"open docs"}].' },
        id: { type: ['string', 'number'], description: 'For done: id of the finished step.' },
      },
    },
  },
];

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method: method || 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || 'HTTP ' + res.status);
  return json;
}

async function runTool(name, args = {}) {
  if (name === 'browser_open') {
    const q = new URLSearchParams({ url: args.url });
    if (args.tab) q.set('tab', args.tab);
    if (args.visual) q.set('visual', '1');
    const r = await call('GET', '/go?' + q);
    return r.digest;
  }
  if (name === 'browser_act') {
    const r = await call('POST', '/act', { id: args.id, action: args.action || 'click', text: args.text, tab: args.tab });
    if (r.error) return 'Error: ' + r.error;
    if (r.digest) return r.digest;
    const added = (r.added || []).map((x) => '- ' + x).join('\n');
    return 'changed: ' + (r.changed ?? 0) + '\n' + added + (r.download ? '\ndownloaded: ' + r.download : '');
  }
  if (name === 'browser_read') {
    const r = await call('GET', '/read' + (args.tab ? '?tab=' + encodeURIComponent(args.tab) : ''));
    return r.text;
  }
  if (name === 'browser_tabs') {
    const r = await call('GET', '/tabs');
    return (r.tabs || []).map((t) => `${t.id} ${t.url || '(empty)'}`).join('\n') || 'no tabs';
  }
  if (name === 'browser_plan') {
    const r = await call('POST', '/plan', { action: args.action || 'get', steps: args.steps, id: args.id });
    return JSON.stringify(r);
  }
  throw new Error('unknown tool: ' + name);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
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
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      try {
        const output = await runTool(name, params?.arguments || {});
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

process.stderr.write('[skim-mcp] ready, server=' + BASE + '\n');
