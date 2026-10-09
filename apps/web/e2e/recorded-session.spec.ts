import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LocalDotEvent, RecordingInfo } from "@localdot/protocol";
import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import { createReadyCell } from "./cells.ts";
import { docker, type RunningDaemon, startDaemon } from "./daemon.ts";
import { type LoggedEvent, runPuppet, sessionEvents, waitForSessionEnd } from "./puppet.ts";

test.skip(process.env.LOCALDOT_DOCKER_TESTS !== "1", "needs Docker, built images and Chrome");
test.describe.configure({ mode: "serial" });

const script = JSON.parse(
  readFileSync(new URL("../../daemon/puppet/demo-multiapp.json", import.meta.url), "utf8"),
) as {
  v: number;
  title: string;
  steps: { do: string; label?: string }[];
};
let daemon: RunningDaemon;
let cellId: string;
let recordedId: string;
let events: LoggedEvent[];
let recording: ReturnType<typeof RecordingInfo.parse>;

test.beforeAll(async () => {
  daemon = await startDaemon();
  cellId = (await createReadyCell(daemon, 2)).id;
  mkdirSync("e2e/out", { recursive: true });
});
test.afterAll(async () => {
  await daemon?.stop();
  expect(docker("ps", "-a", "--filter", "name=localdot-test-", "--format", "{{.Names}}")).toBe("");
  if (cellId)
    expect(
      docker("ps", "-a", "--filter", `label=localdot.cell=${cellId}`, "--format", "{{.Names}}"),
    ).toBe("");
});

async function openReplay(page: Page, sessionId: string): Promise<void> {
  await page.goto(
    `${daemon.origin}/?replay=${sessionId}&replayProbe=1&exportProbe=1#token=${daemon.token}`,
  );
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready", undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => window.__localdot?.replay?.probe({ op: "enable" }));
}

test("records a puppet session that nobody watched", async () => {
  recordedId = await runPuppet(daemon, cellId, script);
  events = await waitForSessionEnd(daemon, recordedId);
  expect(events.findLast((event) => event.type === "session.end")?.data.reason).toBe("done");
  await expect
    .poll(async () => {
      recording = RecordingInfo.parse(
        await (await daemon.request(`/api/sessions/${recordedId}/recording`)).json(),
      );
      return recording.manifest.state;
    })
    .toBe("complete");
  expect(recording.manifest).toMatchObject({ width: 2560, height: 1600, gaps: [] });
  expect(recording.manifest.codec).toMatch(/^avc1\./);
  expect(recording.manifest.fragments).toBeGreaterThan(0);
  const steps = events.filter((event) => event.type === "step.start");
  expect(steps).toHaveLength(script.steps.length);
  for (const step of steps) {
    const ended = events.find((event) => event.type === "step.end" && event.step === step.step);
    expect(ended?.data.status).toBe("ok");
    expect(
      recording.manifest.activity.some(
        (span) => span.from <= (ended?.t ?? step.t) && span.to >= step.t,
      ),
    ).toBe(true);
  }
  const intents = events
    .map((event) => LocalDotEvent.parse(event))
    .filter((event) => event.type === "action.intent" && event.data.pointer);
  expect(intents.length).toBeGreaterThan(0);
  for (const intent of intents) {
    if (intent.type !== "action.intent" || !intent.data.pointer)
      throw new Error("Missing pointer plan.");
    const plan = intent.data.pointer;
    const target = events
      .map((event) => LocalDotEvent.parse(event))
      .find((event) => event.type === "action.target" && event.step === intent.step);
    const bounds = target?.type === "action.target" ? target.data.target.bbox : undefined;
    const width = bounds ? Math.max(32, Math.min(bounds.w, bounds.h)) : 48;
    const distance = Math.hypot(plan.to.x - plan.from.x, plan.to.y - plan.from.y);
    const expectedDuration =
      Math.min(700, Math.max(220, 150 + 100 * Math.log2(distance / width + 1))) / 2;
    expect(plan.durationMs).toBeCloseTo(expectedDuration, 3);
    expect(
      events.some((event) => event.type === "action.dispatch" && event.step === intent.step),
    ).toBe(true);
  }
  const summary = await (await daemon.request(`/api/cells/${cellId}`)).json();
  expect(summary.stream.viewers).toBe(0);
  writeFileSync(
    "e2e/out/recorded-session-evidence.json",
    JSON.stringify(
      {
        recording,
        steps: steps.length,
        pointerPlans: intents.length,
        viewers: summary.stream.viewers,
      },
      null,
      2,
    ),
  );
});

test("replays it with frames that match what the cell showed", async ({ page }) => {
  await openReplay(page, recordedId);
  const observes = events.filter((event) => event.type === "observe" && event.step);
  const steps = events.filter((event) => event.type === "step.start");
  const photographedSteps = steps.filter((_, index) => script.steps[index]?.do !== "wait");
  expect(observes.map((observe) => observe.step)).toEqual(
    photographedSteps.map((step) => step.step),
  );
  const differences: { step: string | undefined; meanRGBDifference: number }[] = [];
  for (const observe of observes) {
    await page.evaluate((tMs) => window.__localdot?.replay?.seek(tMs, "exact"), observe.t / 1000);
    const pixels = (await page.evaluate(() =>
      window.__localdot?.replay?.probe({ op: "thumb", w: 320, h: 200 }),
    )) as number[] | null;
    expect(pixels).toHaveLength(320 * 200 * 4);
    const response = await daemon.request(
      `/api/sessions/${recordedId}/thumbs/${observe.data.frameId}`,
    );
    expect(response.ok).toBe(true);
    const thumbnail = await sharp(Buffer.from(await response.arrayBuffer()))
      .resize(320, 200)
      .ensureAlpha()
      .raw()
      .toBuffer();
    let difference = 0;
    for (let offset = 0; offset < thumbnail.length; offset += 4)
      for (let channel = 0; channel < 3; channel++)
        difference += Math.abs(
          (pixels?.[offset + channel] ?? 0) - (thumbnail[offset + channel] ?? 0),
        );
    const meanRGBDifference = difference / (320 * 200 * 3);
    expect(meanRGBDifference, `step ${observe.step}`).toBeLessThan(12);
    differences.push({ step: observe.step, meanRGBDifference });
  }
  const chapterLabels = await page
    .getByTestId("replay-chapter")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("title")));
  const intents = events.filter((event) => event.type === "action.intent");
  expect(chapterLabels).toEqual(intents.map((intent) => intent.data.label));
  for (const [index, step] of script.steps.entries())
    if (step.label) expect(chapterLabels[index]).toBe(step.label);
  writeFileSync("e2e/out/recorded-frame-differences.json", JSON.stringify(differences, null, 2));
  await page.screenshot({ path: "e2e/out/recorded-replay.png" });
});

test("offers Jump to live while a session runs, and goes live from it", async ({ page }) => {
  const liveId = await runPuppet(daemon, cellId, {
    v: 1,
    title: "Replay live acceptance",
    steps: [{ do: "wait", ms: 20_000, label: "Wait for Jump to live" }],
  });
  try {
    await openReplay(page, liveId);
    await page.getByRole("button", { name: "Jump to live", exact: true }).click();
    await expect(page.locator("iframe.desktop-frame")).toHaveCount(1);
    await expect
      .poll(
        async () => Number(await page.locator("canvas[data-frames]").getAttribute("data-frames")),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(2);
    await expect(page.getByRole("main", { name: "Replay" })).toHaveCount(0);
  } finally {
    const stopped = await daemon.request(`/api/sessions/${liveId}/stop`, { method: "POST" });
    expect(stopped.ok).toBe(true);
    await waitForSessionEnd(daemon, liveId);
    expect(
      (await sessionEvents(daemon, liveId)).findLast((event) => event.type === "session.end")?.data
        .reason,
    ).toBe("stopped");
  }
});

test("exports the recorded session to an MP4 that decodes", async ({ page }) => {
  await openReplay(page, recordedId);
  await expect(page.getByRole("switch", { name: "Skip idle" })).toBeChecked();
  const playbackDurationMs = Number(
    await page.getByRole("slider", { name: "Replay timeline" }).getAttribute("data-duration-ms"),
  );
  expect(playbackDurationMs).toBeGreaterThan(0);
  const result = await page.evaluate(() =>
    window.__localdot?.exportProbe?.run({
      speed: 4,
      skipIdle: true,
      size: { w: 1920, h: 1200 },
      hashes: false,
    }),
  );
  expect(result?.frames).toBeGreaterThan(0);
  const modulePath = fileURLToPath(
    new URL("../node_modules/mediabunny/dist/bundles/mediabunny.mjs", import.meta.url),
  );
  await page.route("**/acceptance-mediabunny.mjs", (route) =>
    route.fulfill({ contentType: "text/javascript", body: readFileSync(modulePath) }),
  );
  const decoded = await page.evaluate(async () => {
    const moduleAddress = `${location.origin}/acceptance-mediabunny.mjs`;
    const media = (await import(moduleAddress)) as typeof import("mediabunny");
    const file = await (
      await (await navigator.storage.getDirectory()).getFileHandle("localdot-export-probe.mp4")
    ).getFile();
    const input = new media.Input({
      source: new media.BlobSource(file),
      formats: media.ALL_FORMATS,
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("Export contains no video.");
      const duration = await input.computeDuration();
      const sink = new media.VideoSampleSink(track);
      const first = await sink.getSample(0);
      const last = await sink.getSample(Math.max(0, duration - 1 / 30));
      try {
        return {
          width: track.displayWidth,
          height: track.displayHeight,
          codec: track.codec,
          duration,
          first: !!first,
          last: !!last,
        };
      } finally {
        first?.close();
        last?.close();
      }
    } finally {
      input.dispose();
    }
  });
  const duration = playbackDurationMs / 4000;
  expect(decoded).toMatchObject({
    width: 1920,
    height: 1200,
    codec: "avc",
    first: true,
    last: true,
  });
  expect(Math.abs(decoded.duration - duration)).toBeLessThan(1);
  writeFileSync(
    "e2e/out/recorded-export.json",
    JSON.stringify({ result, decoded, expectedDuration: duration }, null, 2),
  );
});
