import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { assembledProcess } from "./fixtures/assembled-process.ts";
import {
  answerTable,
  approveCurrent,
  fixtureRequest,
  showPane,
  startSafetyTask,
} from "./fixtures/safety-flow.ts";

// Public browser controls make decisions. The fixture observes actual effects only.
test("bound approvals, private handoff, atomic Pause, queued changes and repeated native input", async ({
  page,
}, info) => {
  const f = await assembledProcess(info, { pending: "shell", scenario: "safety" });
  const errors: string[] = [];
  const failures: unknown[] = [];
  try {
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      const events: { at: number; kind: string; focus: boolean; hidden: boolean }[] = [];
      Object.assign(window, { localdotSafetyFocusEvents: events });
      for (const kind of ["focus", "blur", "visibilitychange"])
        window.addEventListener(kind, () =>
          events.push({
            at: performance.now(),
            kind,
            focus: document.hasFocus(),
            hidden: document.hidden,
          }),
        );
    });
    const owner = await startSafetyTask(page, f),
      request = fixtureRequest(page, f);
    await approveCurrent(page, f); // the explicitly reviewed synthetic HTML file
    await expect(page.locator(".approval-card")).toContainText("Work in its computer");
    const initial = (await f.state(owner))[0];
    const card = initial?.approval;
    if (!card) throw new Error("The public card is missing.");
    expect((await f.effects())[0]?.sendCount).toBe(0);
    const answer = {
      approvalId: card.approvalId,
      generation: card.generation,
      revision: card.revision,
      decision: "approve",
    };
    expect(
      (
        await request(`/api/agent/sessions/${owner}/approvals/answer`, "POST", {
          ...answer,
          generation: card.generation + 1,
        })
      ).status(),
    ).toBe(409);
    expect((await f.effects())[0]?.sendCount).toBe(0);
    await approveCurrent(page, f);
    await expect.poll(async () => (await f.effects())[0]?.sendCount).toBe(1);
    expect(
      (await request(`/api/agent/sessions/${owner}/approvals/answer`, "POST", answer)).status(),
    ).toBe(409);
    expect((await f.effects())[0]?.sendCount).toBe(1);
    await approveCurrent(page, f); // launch the synthetic page
    await answerTable(page);
    // dot hands the computer over from the island; it is the user's once they take it.
    const take = page.getByRole("button", { name: "Take control", exact: true });
    await expect(take).toBeEnabled({ timeout: 30000 });
    const beforeManual = (await f.state(owner))[0];
    await take.click();
    const handBack = page.getByRole("button", { name: "Hand back", exact: true });
    await expect(handBack).toBeEnabled();
    await page
      .getByRole("toolbar", { name: "Computer controls", exact: true })
      .getByRole("button", { name: /^Type text/ })
      .click();
    const paste = page.getByLabel("Text to type on the computer", { exact: true });
    await paste.fill("task14-private-manual-sentinel");
    await paste.press("Enter");
    await expect(paste).toHaveCount(0);
    const held = (await f.state(owner))[0];
    expect(held?.provider.length).toBe(beforeManual?.provider.length);
    expect(JSON.stringify(held?.events)).not.toContain("task14-private-manual-sentinel");
    await handBack.click();
    await approveCurrent(page, f); // a finite current atomic command
    await expect
      .poll(
        async () =>
          (await f.state(owner))[0]?.events.some(
            (e) => e.type === "tool.output" && String(e.data.chunk).includes("task14 waiting"),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    await page.getByRole("button", { name: "Pause after this step", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toBeDisabled();
    await expect
      .poll(async () => (await f.state(owner))[0]?.pause?.phase, { timeout: 45000 })
      .toBe("paused");
    const paused = (await f.state(owner))[0];
    expect(paused?.pause?.atStepBoundary).toBe(true);
    expect(paused?.provider).toHaveLength(8);
    expect((await f.effects())[0]?.atomicWritten).toBe(true);
    expect(
      paused?.events.some(
        (e) => e.type === "tool.output" && String(e.data.chunk).includes("atomic output complete"),
      ),
    ).toBe(true);
    expect(
      (
        await request(`/api/agent/sessions/${owner}/messages`, "POST", {
          kind: "followup",
          text: "task14 follow-up: keep the synthetic task paused.",
        })
      ).status(),
    ).toBe(202);
    expect(
      (await request(`/api/agent/sessions/${owner}/budget`, "POST", { budgetUSD: 0.1 })).status(),
    ).toBe(204);
    const pause = paused?.pause;
    if (!pause) throw new Error("The authoritative Pause is missing.");
    expect(
      (
        await request(`/api/agent/sessions/${owner}/resume`, "POST", {
          requestId: pause.requestId,
          revision: pause.revision + 1,
        })
      ).status(),
    ).toBe(409);
    await page.reload();
    await showPane(page, "Computer");
    await expect(page.getByRole("button", { name: "Resume task", exact: true })).toBeEnabled({
      timeout: 30000,
    });
    expect((await f.state(owner))[0]?.provider).toHaveLength(8);
    await page.evaluate(() => {
      type Fiber = {
        memoizedProps?: Record<string, unknown>;
        memoizedState?: Hook;
        return?: Fiber;
      };
      type Hook = { memoizedState?: unknown; next?: Hook };
      const samples: unknown[] = [];
      const capture = () => {
        const element = document.querySelector(".safety-controls");
        if (!element) return;
        const key = Object.keys(element).find((k) => k.startsWith("__reactFiber"));
        if (!key) return;
        let fiber = (element as unknown as Record<string, Fiber>)[key];
        let controls: Record<string, unknown> | undefined;
        let input: Record<string, unknown> | undefined;
        let focusRefs: unknown[] = [];
        while (fiber) {
          if (fiber.memoizedProps?.safety) controls = fiber.memoizedProps;
          for (let hook = fiber.memoizedState; hook; hook = hook.next) {
            const value = hook.memoizedState as { current?: Record<string, unknown> } | null;
            if (value?.current?.selectReady && value.current.feed && value.current.agent) {
              input = value.current;
              focusRefs = [hook.next?.memoizedState, hook.next?.next?.memoizedState];
            }
          }
          fiber = fiber.return;
        }
        const safety = controls?.safety as Record<string, unknown> | undefined;
        const agent = input?.agent as Record<string, unknown> | undefined;
        const snapshot = agent?.snapshot as Record<string, unknown> | undefined;
        const feed = (input?.feed as { read(): Record<string, unknown> } | undefined)?.read();
        const model = feed?.model as Record<string, unknown> | undefined;
        samples.push({
          at: performance.now(),
          focused: document.hasFocus(),
          hidden: document.hidden,
          canResume: safety?.canResume,
          pending: safety?.pending,
          error: safety?.error,
          agentFresh: agent?.fresh,
          availability: agent?.availability,
          epoch: agent?.authorityEpoch,
          cell: input?.cell,
          blocked: input?.blocked,
          visible: input?.visible,
          snapshotStatus: snapshot?.status,
          snapshotPause: snapshot?.pause,
          feedEpoch: feed?.epoch,
          connection: feed?.connection,
          replayed: feed?.replayed,
          streamError: feed?.streamError,
          modelPause: model?.safetyPause,
          focusRefs,
          askAligned: (snapshot?.pendingAsk ?? null) === model?.pendingAsk,
          takeoverAligned: (snapshot?.pendingTakeover ?? null) === model?.pendingTakeover,
          approvalAligned:
            JSON.stringify(snapshot?.approval ?? null) === JSON.stringify(model?.approval ?? null),
          pauseAligned:
            JSON.stringify(snapshot?.pause ?? null) === JSON.stringify(model?.safetyPause ?? null),
        });
      };
      capture();
      const timer = setInterval(capture, 100);
      Object.assign(window, {
        localdotSafetyResumeSamples: samples,
        localdotSafetyResumeTimer: timer,
      });
    });
    const resumeButton = page.getByRole("button", { name: "Resume task", exact: true });
    const resumeBounds = await resumeButton.boundingBox();
    if (!resumeBounds) throw new Error("The Resume control is outside the visible panel.");
    const resumed = page.waitForRequest(
      (r) =>
        r.method() === "POST" &&
        new URL(r.url()).pathname === `/api/agent/sessions/${owner}/resume`,
    );
    // This is a real user click after the desktop iframe takes focus. The disabled control
    // must allow the pointer to return to this panel before admitting the matching request.
    await page.mouse.click(
      resumeBounds.x + resumeBounds.width / 2,
      resumeBounds.y + resumeBounds.height / 2,
    );
    expect((await resumed).postDataJSON()).toEqual({
      requestId: pause.requestId,
      revision: pause.revision,
    });
    await expect.poll(async () => (await f.state(owner))[0]?.pause, { timeout: 10000 }).toBeNull();
    const reconciled = (await f.state(owner))[0];
    expect(
      reconciled?.events.some(
        (e) =>
          e.type === "safety.pause" &&
          (e.data.pause as { requestId?: string; phase?: string } | undefined)?.requestId ===
            pause.requestId &&
          (e.data.pause as { phase?: string }).phase === "resuming",
      ),
    ).toBe(true);
    // Careful mode still authorizes each call. The third input is blocked, but the model gets
    // recovery guidance with no question or pause. Ignoring that guidance twice exhausts recovery.
    for (let n = 0; n < 3; n++) await approveCurrent(page, f);
    await expect.poll(async () => (await f.state(owner))[0]?.provider.length).toBe(12);
    const recovering = (await f.state(owner))[0];
    expect(recovering?.pause).toBeNull();
    expect(recovering?.events.filter((e) => e.type === "ask.request")).toHaveLength(1); // table choice only
    for (let n = 0; n < 2; n++) await approveCurrent(page, f);
    await expect
      .poll(async () => (await f.state(owner))[0]?.pause?.reason, { timeout: 30000 })
      .toBe("repeated_action");
    await expect
      .poll(async () => (await f.state(owner))[0]?.pause?.phase, { timeout: 30000 })
      .toBe("paused");
    const repeated = (await f.state(owner))[0];
    expect(repeated?.provider).toHaveLength(13);
    const nativeKeys = repeated?.events.filter(
      (e) =>
        e.type === "action.dispatch" &&
        (e.data.input as { kind?: string } | undefined)?.kind === "key",
    );
    expect(nativeKeys).toHaveLength(2);
    expect(repeated?.provider.every((p) => !p.manualSentinelPresent)).toBe(true);
    await showPane(page, "Conversation");
    await expect(page.getByText(/I paused because I kept retrying/).first()).toBeVisible();
    await expect(page.getByText(/What should I change before continuing/)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("safety-repeated-paused.png"), fullPage: true });
    const stop = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        /\/api\/sessions\/[^/]+\/stop$/.test(new URL(r.url()).pathname),
    );
    await page.keyboard.press("Control+Shift+.");
    const stopped = await stop;
    expect(stopped.status()).toBe(202);
    const outcome = await stopped.json();
    expect(outcome.revoked).toBe(true);
    expect(outcome.paused || (outcome.closed && outcome.stopped)).toBe(true);
    expect(errors).toEqual([]);
    writeFileSync(
      info.outputPath("safety-acceptance-proof.json"),
      JSON.stringify(
        {
          highRiskEffectCount: 1,
          staleAndDuplicateRefused: true,
          manualPrivate: true,
          atomicPause: paused?.pause,
          queuedChangesStayedPaused: true,
          reloadDidNotResume: true,
          repeatedDispatches: nativeKeys?.length,
          repeatedPause: repeated?.pause,
          stop: outcome,
          errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failures.push(error);
  }
  // Diagnostics and retirement must each run even when the other fails.
  try {
    if (!page.isClosed()) {
      const diagnostics = await page.evaluate(() => {
        const state = window as unknown as Record<string, unknown>;
        clearInterval(state.localdotSafetyResumeTimer as number | undefined);
        return {
          focus: state.localdotSafetyFocusEvents,
          samples: state.localdotSafetyResumeSamples,
        };
      });
      writeFileSync(
        info.outputPath("resume-state-diagnostics.json"),
        JSON.stringify(diagnostics, null, 2),
      );
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await f.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Safety acceptance and cleanup failed.");
});
