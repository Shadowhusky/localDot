import { appendFileSync, mkdirSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { setupServer } from "../fixtures/setup-server.ts";

// The "before" capture of the computer's lifecycle in Chrome at 1440 and 390: from first run
// through starting, live, reconnecting, paused, failed, fenced and stopped, logging the stage box,
// its classes, the HUD status and the caption at each step to notes-states.txt.
const OUT = process.env.OUT ?? "e2e/out/before";
mkdirSync(OUT, { recursive: true });
const log = (line: string) => {
  console.log(line);
  appendFileSync(`${OUT}/notes-states.txt`, `${line}\n`);
};

async function stageBox(page: Page, label: string) {
  const box = await page.evaluate(() => {
    const stage = document.querySelector(".stage");
    const r = stage?.getBoundingClientRect();
    return {
      stage: r && [r.x, r.y, r.width, r.height].map(Math.round),
      classes: stage?.className,
      hud: document.querySelector("[data-testid=hud-status]")?.textContent,
      caption: document.querySelector(".narration")?.textContent,
      title: document.title,
      rim: !!document.querySelector(".rim"),
    };
  });
  log(`${label} ${JSON.stringify(box)}`);
}

const f = await setupServer();
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const size of [
    { n: "1440", w: 1440, h: 900, phone: false },
    { n: "390", w: 390, h: 844, phone: true },
  ]) {
    const context = await browser.newContext({
      viewport: { width: size.w, height: size.h },
      deviceScaleFactor: 2,
      isMobile: size.phone,
      hasTouch: size.phone,
    });
    // tsx keeps function names with a __name helper, which functions sent to the page call too.
    await context.addInitScript("globalThis.__name = (fn) => fn;");
    const page = await context.newPage();
    page.on("pageerror", (e) => log(`[${size.n}] pageerror ${e.message}`));
    const shot = (name: string) => page.screenshot({ path: `${OUT}/states-${size.n}-${name}.png` });
    await page.goto(f.issue());
    await page.getByRole("heading", { name: "Your computer is off" }).waitFor({ timeout: 15000 });
    await stageBox(page, `[${size.n}] first-run`);
    await page.getByRole("button", { name: "Turn on" }).first().click();
    await page.waitForTimeout(1500);
    const cell = f.orchestrator.list().at(-1);
    log(`[${size.n}] created cell ${cell?.id} ${cell?.state}`);
    if (!cell) continue;
    await shot("a-starting");
    await stageBox(page, `[${size.n}] starting`);
    const live = { ...cell.stream, connection: "live" } as typeof cell.stream;
    f.orchestrator.emit({ ...cell, state: "ready", stream: live });
    await page.waitForTimeout(1500);
    await shot("b-live");
    await stageBox(page, `[${size.n}] live`);
    if (size.phone) {
      await page.getByRole("tab", { name: /^Conversation/ }).click();
      await page.waitForTimeout(300);
      await shot("b2-live-conversation");
      await page.getByRole("tab", { name: /^Activity/ }).click();
      await page.waitForTimeout(300);
      await shot("b3-live-activity");
      await page.getByRole("tab", { name: /^Computer/ }).click();
    }
    const send = page.locator(".composer-actions button");
    log(
      `[${size.n}] live composer submit=${JSON.stringify(await send.textContent())} disabled=${await send.isDisabled()}`,
    );
    const states = [
      ["c-reconnecting", { ...cell, state: "ready", stream: { ...live, connection: "stalled" } }],
      ["d-paused", { ...cell, state: "ready", paused: true, stream: live }],
      [
        "e-failed",
        {
          ...cell,
          state: "failed",
          error: "docker unreachable on /var/run/docker.sock: connect ENOENT",
        },
      ],
      ["f-fenced", { ...cell, state: "ready", fenced: { revision: 1 }, stream: live }],
      ["g-stopped", { ...cell, state: "stopped" }],
    ] as const;
    for (const [name, next] of states) {
      f.orchestrator.emit(next as typeof cell);
      await page.waitForTimeout(1200);
      await shot(name);
      await stageBox(page, `[${size.n}] ${name.slice(2)}`);
    }
    await f.orchestrator.remove(cell.id);
    await context.close();
  }
} finally {
  await browser.close();
  await f.close();
}
