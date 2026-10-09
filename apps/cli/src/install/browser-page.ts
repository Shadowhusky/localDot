import { brandTokenCss } from "../../../../packages/protocol/src/brand-tokens.ts";

// A self-contained installer page: no remote resources, storage, HTML interpolation or task APIs.
export const PROGRESS_SCRIPT = `(() => {
  const secret = location.hash.slice(1);
  history.replaceState(null, '', '/');
  const token = /^progress=([A-Za-z0-9_-]{43})$/.exec(secret)?.[1];
  const $ = (selector) => document.querySelector(selector);
  const title = $('#title'), detail = $('#detail'), bar = $('#bar'), fill = $('#fill');
  const resume = $('#resume'), copy = $('#copy'), footer = $('#footer');
  const steps = { release: $('#release'), images: $('#images'), startup: $('#startup') };
  const glyphs = { todo: 'Not started', doing: 'In progress', done: 'Done', failed: 'Stopped' };
  const roles = { brain: 'agent', desktop: 'desktop', browser: 'browser', gate: 'network gate' };
  const verbs = { pulling: 'Fetching', downloading: 'Downloading', extracting: 'Unpacking', verifying: 'Checking', checking: 'Checking', ready: 'Checking' };
  let stopped = false, shown = 0;
  addEventListener('pagehide', () => { stopped = true; });
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const step = (name, state, value) => {
    steps[name].dataset.state = state;
    $('#' + name + ' svg').setAttribute('aria-label', glyphs[state]);
    if (value !== undefined) text($('#' + name + '-value'), value);
  };
  const released = () => { step('release', 'done'); text($('#release-label'), 'Release verified'); };
  const say = (heading, line) => { text(title, heading); text(detail, line); };
  const progress = (share) => {
    shown = Math.max(shown, share);
    // Out of the sweep, the fill starts at its share instead of easing down from the whole bar.
    const sweeping = bar.dataset.indeterminate !== undefined;
    if (sweeping) fill.style.transition = 'none';
    delete bar.dataset.indeterminate;
    fill.style.transform = 'scaleX(' + shown + ')';
    if (sweeping) { void fill.offsetWidth; fill.style.transition = ''; }
    bar.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
  };
  const stop = (heading, line, failed) => {
    say(heading, line);
    for (const name of Object.keys(steps)) if (steps[name].dataset.state === 'doing') step(name, failed ? 'failed' : 'todo', failed ? undefined : '');
    bar.dataset.stopped = '';
    progress(shown);
    resume.hidden = false; footer.hidden = true;
  };
  // A reload or a missed reply says nothing about setup itself, so no step is marked as stopped.
  const lost = () => stop('Return to your terminal', 'This page lost touch with setup. Your terminal shows where it is, or run localdot again.', false);
  const copied = (done) => {
    if (done) copy.dataset.copied = ''; else delete copy.dataset.copied;
    copy.setAttribute('aria-label', done ? 'Copied' : 'Copy');
  };
  copy.addEventListener('click', () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText('localdot').then(() => {
      copied(true);
      setTimeout(() => copied(false), 1500);
    }, () => {});
  });
  if (!navigator.clipboard) copy.hidden = true;
  async function poll() {
    if (stopped) return;
    if (!token) { lost(); return; }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/status', { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error();
      const state = await response.json();
      if (stopped) return;
      if (state.phase === 'ready') {
        if (typeof state.url !== 'string' || !/^http:\\/\\/127\\.0\\.0\\.1:([0-9]{1,5})\\/#code=[A-Za-z0-9_-]{43}$/.test(state.url)) throw new Error();
        const port = Number(new URL(state.url).port);
        if (port < 1024 || port > 65535) throw new Error();
        released(); step('images', 'done', ''); step('startup', 'done');
        progress(1);
        say('localDot is ready', 'Opening your workspace…');
        location.replace(state.url); return;
      }
      if (state.phase === 'failed' || state.phase === 'cancelled') {
        stop(state.phase === 'cancelled' ? 'Setup interrupted' : 'Setup stopped', 'Run localdot again. It picks up where it left off.', true);
        return;
      }
      if (state.phase === 'images') {
        released();
        if (typeof state.progress === 'number' && state.progress >= 0 && state.progress <= 1) progress(state.progress);
        step('images', 'doing', bar.dataset.indeterminate === undefined ? Math.floor(shown * 100) + '%' : '');
        say('Setting up localDot', (verbs[state.imagePhase] || 'Fetching') + ' the ' + (roles[state.role] || 'computer') + ' image…');
      } else if (state.phase === 'starting') {
        released(); step('images', 'done', ''); step('startup', 'doing');
        progress(1);
        say('Starting localDot', "Checking dot's computer…");
      } else {
        step('release', 'doing');
        say('Setting up localDot', 'Downloading and checking this release…');
      }
      setTimeout(poll, 750);
    } catch { if (!stopped) lost(); } finally { clearTimeout(deadline); }
  }
  void poll();
})();`;

const GLYPH = (label: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="${label}"><circle class="ring" cx="8" cy="8" r="6.25"/><path class="arc" d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"/><path class="check" d="M5.25 8.25 7.1 10.1l3.65-3.85" pathLength="1"/><path class="cross" d="m6 6 4 4m0-4-4 4"/></svg>`;

const DOT = `<svg class="dot" viewBox="0 0 16 16" width="56" height="56" aria-hidden="true"><circle class="dot-body" cx="8" cy="8" r="6.75"/><rect class="dot-eye" x="6" y="5.5" width="2" height="2.75" rx="1"/><rect class="dot-eye" x="9.5" y="5.5" width="2" height="2.75" rx="1"/></svg>`;

const COPY = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><g class="to-copy"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></g><path class="copied" d="M20 6 9 17l-5-5"/></svg>`;

const step = (id: string, label: string, state: "todo" | "doing" = "todo") =>
  `<li id="${id}" data-state="${state}">${GLYPH(state === "doing" ? "In progress" : "Not started")}<span id="${id}-label">${label}</span><span class="value" id="${id}-value"></span></li>`;

export const PROGRESS_STYLE = `:root{${brandTokenCss()};color-scheme:dark;background:var(--color-void);color:var(--color-fg-1);font:var(--text-body)/var(--text-body--line-height) var(--font-ui);font-optical-sizing:auto;-webkit-font-smoothing:antialiased}*{box-sizing:border-box;margin:0;padding:0}body{min-height:100dvh;display:grid;justify-items:center;align-content:start;padding:20vh calc(var(--spacing)*4) calc(var(--spacing)*8)}main{width:100%;max-width:calc(var(--spacing)*110);display:grid}.dot{display:block;margin-bottom:calc(var(--spacing)*5)}.dot-body{fill:var(--color-fg-1)}.dot-eye{fill:var(--dot-eye)}h1{font:600 var(--text-title-1)/var(--text-title-1--line-height) var(--font-ui);letter-spacing:var(--text-title-1--letter-spacing)}#detail{margin-top:calc(var(--spacing)*2);color:var(--color-fg-2);min-height:calc(var(--text-body--line-height)*2);overflow-wrap:anywhere}.bar{position:relative;height:var(--spacing);margin-top:calc(var(--spacing)*6);overflow:hidden;border-radius:var(--radius-full);background:var(--color-control)}#fill{position:absolute;inset:0;border-radius:inherit;background:var(--color-fg-2);transform:scaleX(0);transform-origin:left;transition:transform var(--dur-default) var(--ease-standard),background-color var(--dur-fade) var(--ease-standard)}.bar[data-indeterminate]{background:transparent}.bar[data-indeterminate]::before{content:"";position:absolute;inset:1px 0;border-radius:inherit;background:var(--color-control)}.bar[data-indeterminate] #fill{inset:1px auto 1px 0;width:30%;transform:none;animation:sweep var(--loop-sweep) var(--ease-standard) infinite}.bar[data-stopped] #fill{background:var(--color-fg-3);animation:none}@keyframes sweep{from{translate:-100% 0}to{translate:334% 0}}ol{list-style:none;margin-top:calc(var(--spacing)*4)}li{display:grid;grid-template-columns:calc(var(--spacing)*4) 1fr auto;align-items:center;column-gap:calc(var(--spacing)*3);padding-block:calc(var(--spacing)*2);color:var(--color-fg-2)}li[data-state=todo]{color:var(--color-fg-3)}li[data-state=doing]{color:var(--color-fg-1)}.value{font-variant-numeric:tabular-nums;color:var(--color-fg-2)}svg[role=img]{display:block;overflow:visible;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.arc,.check,.cross{display:none}li[data-state=doing] .ring{opacity:.25}li[data-state=doing] .arc{display:inline;transform-origin:8px 8px;animation:spin var(--loop-turn) linear infinite}li[data-state=done] .check{display:inline;stroke-dasharray:1;animation:draw var(--dur-default) var(--ease-enter)}li[data-state=failed]{color:var(--color-danger-fg)}li[data-state=failed] .cross{display:inline}@keyframes spin{to{rotate:360deg}}@keyframes draw{from{stroke-dashoffset:1}}.resume{justify-self:start;display:flex;align-items:center;gap:calc(var(--spacing)*2);margin-top:calc(var(--spacing)*5);padding:var(--spacing) var(--spacing) var(--spacing) calc(var(--spacing)*4);border-radius:var(--radius-lg);background:var(--color-raised);box-shadow:var(--shadow-raised)}.resume[hidden],[hidden]{display:none}code{font:var(--text-reading)/var(--text-reading--line-height) var(--font-mono);user-select:all}button{position:relative;display:grid;place-items:center;width:calc(var(--spacing)*7);height:calc(var(--spacing)*7);border:0;border-radius:var(--radius-md);background:transparent;color:var(--color-fg-2);cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background-color var(--dur-hover) var(--ease-standard),color var(--dur-hover) var(--ease-standard)}button::after{content:"";position:absolute;inset:calc(var(--spacing)*-2)}button svg{display:block;fill:none;stroke:currentColor;stroke-width:2.25;stroke-linecap:round;stroke-linejoin:round}button .copied,button[data-copied] .to-copy{display:none}button[data-copied] .copied{display:inline}@media (hover:hover){button:hover{background:var(--color-state-hover);color:var(--color-fg-1)}}button:active{background:var(--color-state-pressed);color:var(--color-fg-1)}button:focus-visible{outline:2px solid var(--color-fg-1);outline-offset:2px}footer{margin-top:calc(var(--spacing)*6);padding-top:calc(var(--spacing)*4);border-top:1px solid var(--color-hairline);color:var(--color-fg-3);font:var(--text-callout)/var(--text-callout--line-height) var(--font-ui)}@media (prefers-reduced-motion:reduce){#fill{transition:none}.bar[data-indeterminate] #fill{animation:none;width:100%;background:var(--color-fg-3)}li[data-state=doing] .arc{animation:none}li[data-state=done] .check{animation:none}}`;

export const PROGRESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Setting up localDot</title><style>${PROGRESS_STYLE}</style></head><body><main>${DOT}<section aria-live="polite" aria-atomic="true"><h1 id="title">Setting up localDot</h1><p id="detail">Connecting to your installer…</p></section><div class="bar" id="bar" role="progressbar" aria-label="Computer images" aria-valuemin="0" aria-valuemax="100" data-indeterminate><span id="fill"></span></div><ol>${step("release", "Checking this release", "doing")}${step("images", "Computer images")}${step("startup", "Startup checks")}</ol><div class="resume" id="resume" hidden><code>localdot</code><button id="copy" type="button" aria-label="Copy">${COPY}</button></div><footer id="footer">Keep your terminal open until setup finishes.</footer><noscript>Live progress needs JavaScript. Follow setup in your terminal instead.</noscript></main><script>${PROGRESS_SCRIPT}</script></body></html>`;
