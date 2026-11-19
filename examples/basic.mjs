// Basic agent loop against a running glean server:
//   npx glean-server
//   node examples/basic.mjs
const G = process.env.GLEAN_URL || 'http://127.0.0.1:9879';

// 1. open a page, get a compact digest
const page = await (await fetch(G + '/go?url=' + encodeURIComponent('https://example.com'))).json();
console.log('digest tokens:', page.tokens);
console.log(page.digest);

// 2. act by id — ids come from the digest (e1 = first element)
const res = await (await fetch(G + '/act', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tab: page.tab, id: 'e1', action: 'click' }),
})).json();
console.log('act:', res.ok ? 'ok' : res.error);