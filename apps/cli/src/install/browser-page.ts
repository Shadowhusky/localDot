// A self-contained installer page: no remote resources, storage, HTML interpolation or task APIs.
export const PROGRESS_SCRIPT = `(() => {
  const secret = location.hash.slice(1);
  history.replaceState(null, '', '/');
  const token = /^progress=([A-Za-z0-9_-]{43})$/.exec(secret)?.[1];
  const title = document.querySelector('#title');
  const detail = document.querySelector('#detail');
  const badge = document.querySelector('#badge');
  const roles = { brain: 'Agent', desktop: 'Desktop', browser: 'Browser', gate: 'Network gate' };
  const phases = { pulling: 'Preparing', downloading: 'Downloading', extracting: 'Unpacking', verifying: 'Verifying', checking: 'Checking', ready: 'Ready' };
  let stopped = false;
  addEventListener('pagehide', () => { stopped = true; });
  const fail = () => {
    title.textContent = 'Return to your terminal';
    detail.textContent = 'Setup is no longer connected. Check the terminal for the result or run localdot again.';
    badge.textContent = 'Connection ended';
  };
  async function poll() {
    if (stopped) return;
    if (!token) { fail(); return; }
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
        title.textContent = 'localDot is ready'; detail.textContent = 'Opening your workspace…'; badge.textContent = 'Ready';
        location.replace(state.url); return;
      }
      if (state.phase === 'failed' || state.phase === 'cancelled') {
        title.textContent = state.phase === 'cancelled' ? 'Setup interrupted' : 'Setup needs attention';
        detail.textContent = 'Check your terminal, then run localdot again to resume safely.';
        badge.textContent = 'Not completed'; return;
      }
      if (state.phase === 'images') {
        title.textContent = 'Preparing your computer';
        detail.textContent = (phases[state.imagePhase] || 'Preparing') + ' ' + (roles[state.role] || 'components') + '…';
        if (Number.isSafeInteger(state.currentBytes) && Number.isSafeInteger(state.totalBytes) && state.totalBytes > 0 && state.currentBytes >= 0 && state.currentBytes <= state.totalBytes) {
          detail.textContent += ' ' + Math.floor(state.currentBytes / state.totalBytes * 100) + '% of this layer';
        }
        badge.textContent = 'Computer images';
      } else if (state.phase === 'starting') {
        title.textContent = 'Starting localDot'; detail.textContent = 'Checking local services and the isolated computer environment…'; badge.textContent = 'Startup checks';
      } else {
        title.textContent = 'Preparing localDot'; detail.textContent = 'Downloading and verifying this release. Keep the terminal open.'; badge.textContent = 'Verified release';
      }
      setTimeout(poll, 750);
    } catch { if (!stopped) fail(); } finally { clearTimeout(deadline); }
  }
  void poll();
})();`;

export const PROGRESS_STYLE = `:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0e1116;color:#edf1f7}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:560px;padding:40px;border:1px solid #303743;border-radius:24px;background:#171c24;box-shadow:0 24px 80px #0005}.brand{display:flex;align-items:center;gap:10px;font-size:15px;color:#bfc9da}.dot{height:12px;width:12px;border-radius:50%;background:#a0baf5;box-shadow:0 0 20px #9bbafa33}h1{font-size:clamp(26px,5vw,36px);letter-spacing:-.035em;line-height:1.15;margin:44px 0 16px}p{color:#c0cad9;line-height:1.65;margin:0;overflow-wrap:anywhere}#badge{display:inline-block;margin-top:28px;padding:8px 12px;border:1px solid #3c4657;border-radius:999px;color:#d0dfff;font-size:13px}footer{margin-top:36px;padding-top:20px;border-top:1px solid #303743;font-size:13px;color:#a9b5c7}@media(max-width:420px){main{padding:28px 24px}body{padding:16px}}`;

export const PROGRESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Setting up localDot</title><style>${PROGRESS_STYLE}</style></head><body><main><div class="brand"><span class="dot" aria-hidden="true"></span>localDot</div><section aria-live="polite" aria-atomic="true"><h1 id="title">Preparing localDot</h1><p id="detail">Connecting to your installer…</p><span id="badge">Setup</span></section><footer>This window follows setup on your Mac. Keep your terminal open until setup finishes.</footer><noscript>JavaScript is required for live progress. Follow setup in your terminal instead.</noscript></main><script>${PROGRESS_SCRIPT}</script></body></html>`;
