import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { createServer } from "vite";

// Render the actual app mascot (Blender plate and procedural face), not the tiny favicon.
// Run when its artwork changes: node apps/web/scripts/pwa-icons.mjs
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(web, "public", "icons");
mkdirSync(out, { recursive: true });
const css = readFileSync(join(web, "src/dot/dot.css"), "utf8");
const server = await createServer({
  root: web,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "mascot-icon",
      configureServer(server) {
        server.middlewares.use("/render-icon", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(`<!doctype html><style>${css}
          html, body { margin: 0; background: #0a0b0d; }
          #icon { width: 512px; height: 512px; }
        </style><div id="icon"><span id="dot" class="dot" style="--dot-size:512px"></span></div>
        <script type="module">
          import { DotView } from '/src/dot/render/DotView.ts';
          const host = document.getElementById('dot');
          window.iconView = new DotView(host, { size: 512, state: 'idle', control: false, reducedMotion: true, seed: 1 });
        </script>`);
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await page.goto(`http://127.0.0.1:${address.port}/render-icon`);
  await page.waitForSelector('.dot[data-skin="plate"]');
  await page.evaluate(async () => {
    await Promise.all(
      [...document.images].filter((image) => image.currentSrc).map((image) => image.decode()),
    );
    await new Promise(requestAnimationFrame);
  });
  const rendered = await page.locator("#icon").screenshot({ animations: "disabled" });
  for (const [name, size] of [
    ["apple-touch-icon.png", 180],
    ["apple-touch-icon-mascot-2.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
  ]) {
    // The rendered sphere occupies 75% of the square, inside the maskable safe circle.
    await sharp(rendered).resize(size, size).removeAlpha().png().toFile(join(out, name));
  }
} finally {
  await browser?.close();
  await server.close();
}
