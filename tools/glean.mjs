// Tiny driver for the local glean server: read the current quiz question, or
// pick answer option(s) and go to the next page, printing the next question.
//   node tools/glean.mjs read
//   node tools/glean.mjs pick 3          (0-based option index)
//   node tools/glean.mjs pick 0,2        (checkboxes)
const BASE = process.env.GLEAN_URL || 'http://127.0.0.1:9879';
const TAB = process.env.GLEAN_TAB || 't1';

async function js(expr) {
  const r = await fetch(BASE + '/js', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tab: TAB, expr }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const EXTRACT = `(() => {
  const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
  const opts = inputs.map((r, i) => ({
    i,
    t: ((r.closest('label') || r.parentElement || {}).innerText || '').replace(/\\s+/g, ' ').trim(),
    c: r.checked,
  }));
  const all = (document.body.innerText || '').replace(/\\s+/g, ' ');
  let qt = all.split('Текст вопроса')[1] || all;
  for (const o of opts) if (o.t) { const k = qt.indexOf(o.t); if (k > 0) qt = qt.slice(0, k); }
  qt = qt.slice(0, 500).trim();
  const txts = [...document.querySelectorAll('input[type=text], input[type=number], textarea')].map((e, i) => i + ':' + (e.name || e.id || '?') + '=' + (e.value || ''));
  const prog = (document.body.innerText.match(/(Вопрос|страница)\\\\s*\\\\d+\\\\s*из\\\\s*\\\\d+/gi) || []).join(' | ');
  return { q: qt || '(нет вопроса)', opts, txts, prog };
})()`;

const PICK = (idx) => `(() => {
  const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
  const want = ${JSON.stringify(idx)};
  for (const i of want) { if (inputs[i]) { inputs[i].click(); } }
  const btn = document.querySelector('input[name="next"], button[name="next"]');
  if (!btn) return { error: 'no next button' };
  btn.click();
  return { clicked: want, btn: btn.value || btn.innerText };
})()`;

const mode = process.argv[2];
if (mode === 'read') {
  console.log(JSON.stringify(await js(EXTRACT)));
} else if (mode === 'pick') {
  const idx = String(process.argv[3] || '')
    .split(',')
    .filter((s) => s.length)
    .map(Number);
  const r = await js(PICK(idx));
  console.log('pick:', JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 2500));
  console.log('next:', JSON.stringify(await js(EXTRACT)));
} else if (mode === 'dom') {
  const expr = `(() => {
    const nav = [...document.querySelectorAll('.qnbutton, a[href*="page="]')].map((a) => ({
      t: (a.innerText || '').replace(/\\s+/g, ' ').slice(0, 20),
      h: (a.getAttribute('href') || '').slice(-60),
    }));
    const q1 = document.querySelector('[id^="question-"]');
    const cand = [...q1.querySelectorAll('span.draghome')].filter((e) => (e.className || '').includes('choice'))
      .map((e) => (e.className.match(/choice\\d+/) || ['?'])[0] + '=' + (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 30));
    return { url: location.href, cand };
  })()`;
  console.log(JSON.stringify(await js(expr), null, 0).slice(0, 6000));
} else if (mode === 'set') {
  const spec = String(process.argv[3] || '');
  const expr = `(() => {
    const spec = ${JSON.stringify(spec)};
    const sels = [...document.querySelectorAll('select')];
    const log = [];
    for (const part of spec.split(';').filter(Boolean)) {
      const [si, frag] = part.split('=');
      const s = sels[Number(si)];
      if (!s) { log.push('no select ' + si); continue; }
      const opt = [...s.options].find((o) => o.text.includes(frag));
      if (!opt) { log.push('no opt ' + frag); continue; }
      s.value = opt.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      log.push(si + '->' + opt.text.slice(0, 40));
    }
    const btn = document.querySelector('input[name="next"], button[name="next"]');
    if (btn) btn.click();
    return { log, next: btn ? (btn.value || btn.innerText) : 'none' };
  })()`;
  console.log('set:', JSON.stringify(await js(expr)));
  await new Promise((res) => setTimeout(res, 2500));
  console.log('next:', JSON.stringify(await js(EXTRACT)));
} else if (mode === 'drops') {
  const expr = `(() => [...document.querySelectorAll('.drop')].map((d, i) => i + '|' + (d.innerHTML || '').replace(/\\s+/g, ' ').slice(0, 200)))()`;
  console.log(JSON.stringify(await js(expr)));
} else if (mode === 'places') {
  const vals = String(process.argv[3] || '').split(',');
  const expr = `(() => {
    const vals = ${JSON.stringify(vals)};
    const pis = [...document.querySelectorAll('input.placeinput')];
    const log = [];
    pis.forEach((inp, i) => { if (vals[i] !== undefined) { inp.value = vals[i]; inp.dispatchEvent(new Event('change', { bubbles: true })); log.push(inp.className.slice(0, 16) + '=' + vals[i]); } });
    const btn = document.querySelector('input[name="next"], button[name="next"]');
    if (btn) btn.click();
    return { log, n: pis.length, next: btn ? (btn.value || btn.innerText) : 'none' };
  })()`;
  console.log('places:', JSON.stringify(await js(expr)));
  await new Promise((res) => setTimeout(res, 2500));
  console.log('next:', JSON.stringify(await js(EXTRACT)));
} else if (mode === 'fill') {
  const val = String(process.argv[3] || '');
  const expr = `(() => {
    const inp = document.querySelector('input[type=text], textarea');
    if (!inp) return { error: 'no text input' };
    inp.focus();
    inp.value = ${JSON.stringify(val)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = document.querySelector('input[name="next"], button[name="next"]');
    if (btn) btn.click();
    return { filled: inp.name, next: btn ? (btn.value || btn.innerText) : 'none' };
  })()`;
  console.log('fill:', JSON.stringify(await js(expr)));
  await new Promise((res) => setTimeout(res, 2500));
  console.log('next:', JSON.stringify(await js(EXTRACT)));
} else if (mode === 'force') {
  const text = String(process.argv[3] || '');
  const expr = `(() => {
    window.confirm = () => true;
    window.alert = () => {};
    const el = [...document.querySelectorAll('button, input[type=submit], a')]
      .find((e) => ((e.value || '') + ' ' + (e.innerText || '')).includes(${JSON.stringify(text)}));
    if (!el) return { error: 'not found' };
    if (el.form && el.type === 'submit') el.form.requestSubmit(el); else el.click();
    return { clicked: (el.value || el.innerText || '').slice(0, 60) };
  })()`;
  console.log('force:', JSON.stringify(await js(expr)));
  await new Promise((res) => setTimeout(res, 3500));
  console.log('now:', JSON.stringify(await js('({title: document.title, head: document.body.innerText.replace(/\\s+/g," ").slice(0,500)})')));
} else if (mode === 'click') {
  const text = String(process.argv[3] || '');
  const expr = `(() => {
    const el = [...document.querySelectorAll('button, input[type=submit], a')]
      .find((e) => ((e.value || '') + ' ' + (e.innerText || '')).includes(${JSON.stringify(text)}));
    if (!el) return { error: 'not found' };
    el.click();
    return { clicked: (el.value || el.innerText || '').slice(0, 60) };
  })()`;
  console.log('click:', JSON.stringify(await js(expr)));
  await new Promise((res) => setTimeout(res, 3000));
  console.log('now:', JSON.stringify(await js('({title: document.title, head: document.body.innerText.replace(/\\s+/g," ").slice(0,400)})')));
} else {
  console.log('usage: read | pick <0-based indexes> | click <text>');
}
