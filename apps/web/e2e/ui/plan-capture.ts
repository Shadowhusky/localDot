import { mkdirSync, writeFileSync } from "node:fs";
import { type Browser, type BrowserType, chromium, type Page, webkit } from "@playwright/test";
import { setupServer } from "../fixtures/setup-server.ts";

// The "before" capture: today's sign-in, installer, first run, Settings, Keys and computer states
// in Chrome and WebKit at 1440, 1280 and 390, with a probe of every visible control. It writes
// screenshots and notes.txt for reference; it asserts nothing.
const OUT = process.env.OUT ?? "e2e/out/before";
mkdirSync(OUT, { recursive: true });
const notes: string[] = [];
const note = (line: string) => {
  notes.push(line);
  console.log(line);
};

type Size = { name: string; width: number; height: number; mobile?: boolean };
const SIZES: Size[] = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844, mobile: true },
];

interface Control {
  name: string;
  disabled: boolean;
  h: number;
  described: boolean;
}

async function probeControls(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        getComputedStyle(el).visibility !== "hidden" &&
        !el.closest("[inert]")
      );
    };
    const controls = [
      ...document.querySelectorAll<HTMLElement>("button, select, input, textarea, [role=tab]"),
    ]
      .filter(visible)
      .map((h) => ({
        name: (h.getAttribute("aria-label") ?? h.textContent ?? h.getAttribute("placeholder") ?? "")
          .trim()
          .slice(0, 48),
        disabled: (h as HTMLButtonElement).disabled || h.getAttribute("aria-disabled") === "true",
        h: Math.round(h.getBoundingClientRect().height),
        described: !!h.getAttribute("aria-describedby") || !!h.title,
      }));
    const scrollers = [...document.querySelectorAll("*")]
      .filter((el) => {
        const s = getComputedStyle(el);
        return (
          visible(el) && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1
        );
      })
      .map((el) => String(el.className || el.tagName));
    const box = document.querySelector(".stage")?.getBoundingClientRect();
    return {
      controls,
      scrollers,
      stage: box && [box.x, box.y, box.width, box.height].map(Math.round),
      hscroll: document.documentElement.scrollWidth > innerWidth,
    };
  });
  const dead = report.controls.filter((c: Control) => c.disabled && !c.described);
  const heights = [...new Set(report.controls.map((c: Control) => c.h))].sort((a, b) => a - b);
  note(
    `[${label}] stage=${JSON.stringify(report.stage)} hscroll=${report.hscroll} scrollers=${JSON.stringify(report.scrollers)}`,
  );
  note(
    `[${label}] heights=${JSON.stringify(heights)} disabled-without-reason=${JSON.stringify(dead.map((c) => c.name))}`,
  );
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function run(engine: BrowserType, engineName: string) {
  const f = await setupServer();
  let browser: Browser | undefined;
  try {
    browser = await engine.launch(engineName === "chromium" ? { channel: "chrome" } : {});
    for (const size of SIZES) {
      if (engineName === "webkit" && size.name === "1280") continue;
      const tag = `${engineName}-${size.name}`;
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 2,
        isMobile: size.mobile,
        hasTouch: size.mobile,
      });
      // tsx keeps function names with a __name helper, which functions sent to the page call too.
      await context.addInitScript("globalThis.__name = (fn) => fn;");
      const page = await context.newPage();
      page.on("pageerror", (e) => note(`[${tag}] pageerror ${e.message}`));
      await page.goto(f.origin);
      await shot(page, `${tag}-01-no-token`);
      await page.goto(f.url);
      f.channel.report({
        role: "desktop",
        phase: "downloading",
        currentBytes: 50,
        totalBytes: 100,
      });
      await page.waitForTimeout(1200);
      await shot(page, `${tag}-02-installer-progress`);
      f.channel.starting();
      await page.waitForTimeout(1000);
      await page.goto(f.issue());
      await page.getByRole("heading", { name: "Set up localDot" }).waitFor({ timeout: 15000 });
      await shot(page, `${tag}-03-first-run`);
      await probeControls(page, `${tag} first-run`);
      if (size.mobile) {
        for (const pane of ["Conversation", "Activity"]) {
          await page.getByRole("tab", { name: new RegExp(`^${pane}`) }).click();
          await shot(page, `${tag}-03-first-run-${pane.toLowerCase()}`);
          await probeControls(page, `${tag} first-run ${pane}`);
        }
        await page.getByRole("tab", { name: /^Computer/ }).click();
      }
      await page.getByRole("radio", { name: "Midnight" }).check();
      await shot(page, `${tag}-04-first-run-midnight`);
      await page.getByRole("radio", { name: "Graphite" }).check();
      await page
        .getByRole("button", { name: /Choose model|Change model/ })
        .first()
        .click();
      const settings = page.getByRole("dialog", { name: "Models and settings" });
      await settings.waitFor();
      await shot(page, `${tag}-05-settings-top`);
      await probeControls(page, `${tag} settings`);
      const provider = settings.getByRole("combobox", { name: /main provider/i });
      const before = await provider.inputValue();
      try {
        await provider.selectOption({ label: "Anthropic" });
      } catch (e) {
        note(`[${tag}] selectOption Anthropic failed: ${(e as Error).message.split("\n")[0]}`);
      }
      note(
        `[${tag}] provider select ${JSON.stringify(before)} -> ${JSON.stringify(await provider.inputValue())}`,
      );
      const model = settings.getByRole("combobox", { name: /main model/i });
      note(
        `[${tag}] main model options: ${await model
          .locator("option")
          .count()
          .catch(() => -1)}`,
      );
      await shot(page, `${tag}-06-settings-provider-chosen`);
      await provider.click();
      await page.waitForTimeout(250);
      note(
        `[${tag}] after tap, focused=${await page.evaluate(() => document.activeElement?.tagName)}`,
      );
      await page.keyboard.press("Escape").catch(() => {});
      const sheetOpen = await settings.isVisible();
      note(`[${tag}] settings still open after select tap + Escape: ${sheetOpen}`);
      if (!sheetOpen) {
        await page
          .getByRole("button", { name: /Choose model|Change model/ })
          .first()
          .click();
        await settings.waitFor();
      }
      await page.evaluate(() => {
        const body = document.querySelector(".settings-body");
        body?.scrollTo(0, body.scrollHeight / 2);
      });
      await shot(page, `${tag}-07-settings-mid`);
      await page.evaluate(() => document.querySelector(".settings-body")?.scrollTo(0, 1e6));
      await shot(page, `${tag}-08-settings-bottom`);
      const addKey = settings.getByRole("button", { name: /Add key for main/ });
      if (await addKey.count())
        note(`[${tag}] Add key for main disabled=${await addKey.isDisabled()}`);
      await settings.getByRole("button", { name: "Close settings" }).click();
      const discard = settings.getByRole("button", { name: "Discard", exact: true });
      if (await discard.isVisible()) {
        await shot(page, `${tag}-08b-settings-discard`);
        await discard.click();
      }
      await page.getByTestId("keys-button").click();
      await page.waitForTimeout(400);
      await shot(page, `${tag}-09-keys`);
      await probeControls(page, `${tag} keys`);
      await page.keyboard.press("Escape");
      if (size.mobile) await page.getByRole("tab", { name: /^Conversation/ }).click();
      const send = page.locator(".composer-actions button");
      note(
        `[${tag}] composer submit label=${JSON.stringify(await send.textContent())} disabled=${await send.isDisabled()}`,
      );
      if (size.mobile) await page.getByRole("tab", { name: /^Computer/ }).click();
      const created = await f.orchestrator.create({ scale: 2 });
      const live = { ...created.stream, connection: "live" } as typeof created.stream;
      const states = [
        ["10-starting", { ...created, state: "starting" }],
        ["11-ready-live", { ...created, state: "ready", stream: live }],
        ["12-paused", { ...created, state: "ready", paused: true }],
        [
          "13-failed",
          {
            ...created,
            state: "failed",
            error: "docker unreachable on /var/run/docker.sock: connect ENOENT",
          },
        ],
        ["14-fenced", { ...created, state: "ready", fenced: { revision: 1 } }],
        ["15-stopped", { ...created, state: "stopped" }],
      ] as const;
      for (const [name, cell] of states) {
        f.orchestrator.emit(cell as typeof created);
        await page.waitForTimeout(1300);
        await shot(page, `${tag}-${name}`);
        if (name !== "11-ready-live") continue;
        await probeControls(page, `${tag} ready`);
        if (!size.mobile) continue;
        await page.getByRole("tab", { name: /^Conversation/ }).click();
        await shot(page, `${tag}-11b-ready-conversation`);
        await probeControls(page, `${tag} ready conversation`);
        await page.getByRole("tab", { name: /^Computer/ }).click();
      }
      await f.orchestrator.remove(created.id);
      await context.close();
    }
  } finally {
    await browser?.close();
    await f.close();
  }
}

for (const [engine, name] of [
  [chromium, "chromium"],
  [webkit, "webkit"],
] as const) {
  try {
    await run(engine, name);
  } catch (error) {
    note(`[${name}] run failed: ${(error as Error).stack?.split("\n").slice(0, 4).join(" | ")}`);
  }
}
writeFileSync(`${OUT}/notes.txt`, `${notes.join("\n")}\n`);
