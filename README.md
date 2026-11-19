# Glean

**A browser for AI agents that costs ~500 tokens per page instead of ~250,000.**

![glean demo](docs/demo.gif)
Agents usually get a full DOM dump or an accessibility tree on every step. On a Wikipedia article that is ~246,000 tokens — for one page view. Glean sends only what an agent can act on: visible interactive elements with short ids, plus optional text or a screenshot when needed.

```
PAGE Neural network — Wikipedia
URL https://en.wikipedia.org/wiki/Neural_network
TAB t1

e1 input:search "Search Wikipedia"
e2 button "Search"
e3 button "Hide Contents"
e4 a "History"
...
```

## Numbers

Measured on a real Wikipedia article (1,280×860 viewport, Chrome, headless):

| what you send | tokens |
|---|---|
| raw HTML | 246,212 |
| visible text | 13,179 |
| **Glean digest** | **902** |
| diff after an action | ~100 |
| screenshot (when you need eyes) | ~1,650 |

Speed (warm browser, persistent profile): page ~1.4 s, click/type 0.4–0.9 s with verification, cached page 2 ms, plan update 3 ms.


### Why not just Playwright MCP?

| | Playwright MCP | Glean |
|---|---|---|
| per-step payload | full DOM / accessibility tree, 20k–50k tokens | digest 300–900 tokens, diff ~100 |
| page navigation | new snapshot every time | digest on navigation, diff otherwise |
| screenshots | every step or on demand, full size | only when asked, JPEG, downscaled |
| cost per page view | ~25–60¢ | ~0.02–0.03¢ |
| warm browser | separate instance per session | persistent profile, warmed at start |
## Install

```bash
npm i glean-browser
npx playwright install chromium   # or use your system Chrome/Edge (auto-detected)
```

Run the server:

```bash
npx glean-server        # http://127.0.0.1:9879
```

One-shot digest without a server:

```bash
npx glean https://example.com
npx glean https://example.com --visual   # keep images, slower
npx glean https://example.com --json
```

## API

| endpoint | what it does |
|---|---|
| `GET /go?url=&tab=&visual=1` | open page, return compact digest |
| `POST /act` `{tab,id,action,text}` | `click` / `type` / `press` / `upload` by digest id, verified |
| `GET /diff?tab=` | only what changed since last digest |
| `GET /read?tab=&url=` | main text of the page |
| `GET /shot?tab=&visual=1&save=path` | screenshot (JPEG) |
| `GET /tab` `POST /tab` | new tab (up to `GLEAN_MAX_TABS`) |
| `GET /tabs` `GET /close?tab=` | list / close tabs |
| `GET /plan` `POST /plan` | external step plan (kept out of the model context) |
| `GET /health` | status |

Typical agent loop: `/go` → pick an id → `/act` → act returns a fresh digest on navigation or a diff otherwise.

## Why it is cheaper

- only actionable elements, deduplicated and ranked (inputs → buttons → links);
- labels truncated, no styles, no scripts, no base64;
- resources blocked in fast mode (images/fonts/media/analytics);
- diffs for in-page changes;
- 45 s URL cache in the server;
- optional vision: one downscaled screenshot instead of the whole page.

## Robustness

- persistent profile (cookies, logins survive restarts);
- retries on navigation, rate limit per host (`GLEAN_MIN_GAP_MS`);
- shadow DOM and same-origin iframes are collected (elements are tagged with `data-glean`);
- stale ids return an explicit error instead of silently misclicking;
- dialogs auto-dismissed, downloads saved to the state dir;
- captcha presence reported as a flag (not solved).

## Config

| env | default | meaning |
|---|---|---|
| `GLEAN_PORT` | `9879` | HTTP port |
| `GLEAN_STATE_DIR` | `~/.glean` | profile, plan, downloads |
| `GLEAN_BROWSER` | auto | path to Chrome/Edge executable |
| `GLEAN_HEADLESS` | `1` | set `0` to watch the browser |
| `GLEAN_MAX_TABS` | `5` | tab pool size |
| `GLEAN_MIN_GAP_MS` | `700` | min delay between requests to one host |

## Limits

- captchas and Cloudflare challenges are detected, not solved;
- SPA diffs are coarse (changed count, not a structural diff);
- uploads need a concrete input element id;
- headless browser automation is known to sites you visit — use your own profile and respect their terms.

## License

MIT
