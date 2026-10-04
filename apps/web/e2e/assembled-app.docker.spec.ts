import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { assembledProcess } from "./fixtures/assembled-process.ts";

const CANARY = "task15-local-canary-never-real";
for (const pending of ["wait", "shell"] as const)
  test(`sealed key, live desktop and ${pending} Stop with fenced recovery`, async ({
    page,
  }, info) => {
    const f = await assembledProcess(info, { pending });
    const errors: string[] = [],
      external: string[] = [],
      csp: { surface: string; directive: string; blockedURI: string }[] = [],
      savedBodies: string[] = [],
      streams: { path: string; urlSHA256: string; closed: boolean }[] = [];
    let owner: string | undefined;
    let phase = "open";
    let complete = false;
    let workFailure: unknown;
    let workFailed = false;
    const retirementFailures: unknown[] = [];
    const run = async () => {
      const origin = new URL(f.url).origin;
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (["http:", "https:"].includes(url.protocol) && url.origin !== origin)
          external.push(request.url());
        if (request.method() === "POST" && url.pathname === "/api/keys")
          savedBodies.push(request.postData() ?? "");
      });
      page.on("websocket", (ws) => {
        const item = {
          path: new URL(ws.url()).pathname,
          urlSHA256: createHash("sha256").update(ws.url()).digest("hex"),
          closed: false,
        };
        streams.push(item);
        ws.on("close", () => {
          item.closed = true;
        });
      });
      await page.exposeFunction(
        "recordAcceptanceCsp",
        (value: { surface: string; directive: string; blockedURI: string }) => csp.push(value),
      );
      await page.addInitScript(() =>
        document.addEventListener("securitypolicyviolation", (event) => {
          void (
            window as unknown as {
              recordAcceptanceCsp: (value: {
                surface: string;
                directive: string;
                blockedURI: string;
              }) => Promise<void>;
            }
          ).recordAcceptanceCsp({
            surface: window === window.top ? "theatre" : "decoder",
            directive: event.violatedDirective,
            blockedURI: event.blockedURI,
          });
        }),
      );
      const phone = (page.viewportSize()?.width ?? 1440) < 1100;
      const showPane = async (name: "Computer" | "Conversation" | "Activity") => {
        const tab = page.getByRole("tab", { name, exact: true });
        if (await tab.isVisible()) await tab.click();
      };
      const ticketHash = (value: string) => createHash("sha256").update(value).digest("hex");
      const checkpoint = (name: string) => {
        phase = name;
        writeFileSync(
          info.outputPath("checkpoint.json"),
          JSON.stringify({ phase, at: new Date().toISOString() }),
        );
      };
      await page.goto(f.url);
      await expect(page.getByRole("button", { name: "Start computer", exact: true })).toBeEnabled();
      checkpoint("sealed-key");
      await page.getByTestId("keys-button").click();
      const keys = page.getByRole("dialog", { name: "Keys", exact: true });
      await expect(keys.getByRole("button", { name: "Save key", exact: true })).toBeEnabled();
      await keys.getByLabel("Name", { exact: true }).fill("fixture");
      await keys.getByLabel("Provider", { exact: true }).selectOption("openai-compatible");
      await keys.getByLabel("Base URL", { exact: true }).fill("https://provider.example.test/v1");
      await keys.getByLabel("Key", { exact: true }).fill(CANARY);
      await keys.getByRole("button", { name: "Save key", exact: true }).click();
      await expect(keys).toContainText("Saved fixture.");
      expect(savedBodies).toHaveLength(1);
      expect(savedBodies[0]).not.toContain(CANARY);
      await expect(keys.getByLabel("Key", { exact: true })).toHaveValue("");
      await keys.getByRole("button", { name: "Close keys", exact: true }).click();
      checkpoint("settings");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "Models and settings", exact: true });
      await settings.getByLabel("main provider", { exact: true }).selectOption("openai-compatible");
      await settings.getByLabel("main model", { exact: true }).selectOption("fixture-assembled-v1");
      await settings.getByLabel("main key", { exact: true }).selectOption("fixture");
      await settings.getByLabel("main Input — USD per million tokens", { exact: true }).fill("1");
      await settings.getByLabel("main Output — USD per million tokens", { exact: true }).fill("1");
      await settings
        .getByRole("checkbox", { name: "Use the configured default", exact: true })
        .uncheck();
      await settings.getByLabel("Task ceiling — USD", { exact: true }).fill("0.05");
      await expect(
        settings.getByRole("button", { name: "Save settings", exact: true }),
      ).toBeEnabled();
      await settings.getByRole("button", { name: "Save settings", exact: true }).click();
      await expect(settings).toContainText("Saved choices");
      await settings.getByRole("button", { name: "Close settings", exact: true }).click();
      checkpoint("start-computer");
      await page.getByRole("button", { name: "Start computer", exact: true }).click();
      await showPane("Conversation");
      await expect(page.getByRole("textbox", { name: "New task", exact: true })).toBeEnabled({
        timeout: 120_000,
      });
      await page
        .getByRole("textbox", { name: "New task", exact: true })
        .fill(
          "task14 assembled synthetic acceptance: export the sample table after a local fake sign-in.",
        );
      await showPane("Computer");
      await expect(page.getByLabel("The virtual computer", { exact: true })).toHaveAttribute(
        "data-frames",
        /^[1-9][0-9]*$/,
        { timeout: 30_000 },
      );
      await showPane("Conversation");
      checkpoint("start-task");
      const startReply = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /^\/api\/cells\/[^/]+\/agent$/.test(new URL(response.url()).pathname),
      );
      await page.getByRole("button", { name: "Start task", exact: true }).click();
      const started = await startReply;
      expect(started.status()).toBe(202);
      owner = (await started.json()).sessionId;
      expect(owner).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      await expect(
        page.getByText("Which synthetic table should I export?", { exact: true }).first(),
      ).toBeVisible({ timeout: 25_000 });
      checkpoint("question");
      const beforeAsk = (await f.state())[0];
      owner = beforeAsk?.sessionId ?? undefined;
      expect(owner).toBeTruthy();
      expect(beforeAsk?.provider.map((p) => p.tool)).toEqual([
        "update_plan",
        "files",
        "shell",
        "computer",
        "ask_user",
      ]);
      await expect(page.getByRole("button", { name: "Send answer", exact: true })).toBeEnabled();
      await page.getByText("The sample table", { exact: true }).click();
      await expect(
        page.getByRole("radio", { name: "The sample table", exact: true }),
      ).toBeChecked();
      await page.getByRole("button", { name: "Send answer", exact: true }).click();
      await showPane("Computer");
      const manual = page.getByRole("region", { name: "Manual control", exact: true });
      await expect(manual).toBeVisible({ timeout: 30_000 });
      checkpoint("manual");
      const beforeManual = (await f.state(owner))[0];
      expect(beforeManual?.provider).toHaveLength(6);
      await manual
        .getByLabel("Text for the computer", { exact: true })
        .fill("task14-private-manual-sentinel");
      await manual.getByRole("button", { name: "Type text", exact: true }).click();
      await expect(manual.getByLabel("Text for the computer", { exact: true })).toHaveValue("");
      await expect(
        manual.getByRole("button", { name: "Return control to dot", exact: true }),
      ).toBeEnabled();
      const held = (await f.state(owner))[0];
      expect(held?.provider).toHaveLength(6);
      expect(JSON.stringify(held?.events)).not.toContain("task14-private-manual-sentinel");
      await page.screenshot({
        path: info.outputPath("assembled-manual-desktop.png"),
        fullPage: true,
      });
      await manual
        .getByLabel("Optional note for dot", { exact: true })
        .fill("The fake local sign-in interaction is complete.");
      await manual.getByRole("button", { name: "Return control to dot", exact: true }).click();
      await expect
        .poll(
          async () => {
            const state = (await f.state(owner))[0];
            return state?.events.some((e) =>
              pending === "shell"
                ? e.type === "tool.output" && String(e.data.chunk).includes("task14 waiting")
                : e.type === "action.intent" && e.data.verb === "wait",
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      checkpoint("stop-pending");
      const beforeStop = (await f.state(owner))[0];
      expect(beforeStop?.cell.stream.connection).toBe("live");
      const oldTicketSrc = await page
        .locator('iframe[title="Desktop stream client"]')
        .getAttribute("src");
      expect(oldTicketSrc).toBeTruthy();
      const oldTicketPath = (oldTicketSrc as string).split("#")[0] as string;
      expect((await page.request.get(origin + oldTicketPath)).status()).toBe(200);
      const stopSheet = phone ? "Keys" : "Models and settings";
      checkpoint(phone ? "keys-stop" : "settings-stop");
      if (phone) await page.getByTestId("keys-button").click();
      else await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByTestId("hud-stop-session")).toBeVisible();
      const stopButton = page
        .getByRole("dialog", { name: stopSheet, exact: true })
        .getByRole("button", { name: "Stop", exact: true });
      if (pending === "wait") {
        const stopPath = `${origin}/api/sessions/${owner}/stop`;
        let intercepted = 0;
        await page.route(stopPath, async (route) => {
          intercepted++;
          await route.fulfill({ status: 503, body: "owned Stop transport unavailable" });
        });
        await stopButton.click();
        await expect(page.getByRole("dialog", { name: stopSheet, exact: true })).toContainText(
          "Could not confirm stopped.",
        );
        expect(intercepted).toBe(1);
        const uncertain = (await f.state(owner))[0];
        expect(uncertain?.cell.paused).not.toBe(true);
        expect(uncertain?.provider).toHaveLength(7);
        expect((await page.request.get(origin + oldTicketPath)).status()).toBe(200);
        writeFileSync(
          info.outputPath("stop-uncertainty-proof.json"),
          JSON.stringify({ intercepted, uncertain, optimisticStop: false }, null, 2),
        );
        await page.unroute(stopPath);
        await expect(stopButton).toBeEnabled();
      }
      await stopButton.click();
      await expect
        .poll(
          async () => {
            const state = (await f.state(owner))[0];
            return state?.cell.paused === true;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const stopped = (await f.state(owner))[0];
      expect(stopped?.cell.state).toBe("ready");
      expect(stopped?.cell.paused).toBe(true);
      await expect(page.locator('iframe[title="Desktop stream client"]')).toHaveCount(0);
      expect((await page.request.get(origin + oldTicketPath)).status()).toBe(403);
      await page
        .getByRole("button", { name: phone ? "Close keys" : "Close settings", exact: true })
        .click();
      await showPane("Computer");
      await expect(
        page.getByRole("button", { name: "Resume computer", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("assembled-paused-desktop.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Resume computer", exact: true }).click();
      await expect
        .poll(
          async () => {
            const s = (await f.state(owner))[0];
            return !!s && !s.cell.paused && s.cell.state === "ready";
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      checkpoint("task-resume");
      const resumed = (await f.state(owner))[0];
      await expect(page.locator('iframe[title="Desktop stream client"]')).toHaveCount(1);
      const newTicketSrc = await page
        .locator('iframe[title="Desktop stream client"]')
        .getAttribute("src");
      expect(newTicketSrc).not.toBe(oldTicketSrc);
      expect((await page.request.get(origin + oldTicketPath)).status()).toBe(403);
      await expect(page.getByLabel("The virtual computer", { exact: true })).toHaveAttribute(
        "data-frames",
        /^[1-9][0-9]*$/,
        { timeout: 30_000 },
      );
      await showPane("Conversation");
      // Stop retires the task. Resuming the desktop must not re-authorize its old
      // generation. Complete the export only after an explicit new task through UI.
      await expect(page.getByRole("region", { name: "Task recovery", exact: true })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "New task", exact: true })).toBeEnabled();
      await page
        .getByRole("textbox", { name: "New task", exact: true })
        .fill("task14 explicitly continue after confirmed Stop: export the sample table.");
      const nextReply = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /^\/api\/cells\/[^/]+\/agent$/.test(new URL(response.url()).pathname),
      );
      await page.getByRole("button", { name: "Start task", exact: true }).click();
      const next = await nextReply;
      if (pending === "shell") {
        expect(next.status()).toBe(409);
        const cellId = (await f.state(owner))[0]?.cell.id;
        const refusalReply = await page.request.post(`${origin}/api/cells/${cellId}/agent`, {
          headers: {
            authorization: `Bearer ${new URL(f.url).hash.slice("#token=".length)}`,
            origin,
          },
          data: { task: "task14 explicit blocked-cell negative probe" },
        });
        expect(refusalReply.status()).toBe(409);
        const refusal = await refusalReply.text();
        expect(refusal).toContain("task or computer is not ready for this request");
        await expect(page.getByText(/The daemon refused this message/)).toBeVisible();
        const fenced = (await f.state(owner))[0];
        expect(fenced?.provider).toHaveLength(7);
        expect(
          fenced?.events.some((e) => e.type === "session.end" && e.data.reason === "stopped"),
        ).toBe(true);
        writeFileSync(
          info.outputPath("shell-containment-proof.json"),
          JSON.stringify(
            {
              syntheticModel: true,
              expectedRefusal: refusal,
              beforeStop,
              stopped,
              resumed,
              fenced,
              futureRecovery:
                "An explicitly replaced computer is required before further authority; no old shell is automatically re-authorized.",
            },
            null,
            2,
          ),
        );
        complete = true;
        return;
      }
      expect(next.status(), await next.text()).toBe(202);
      const nextOwner = (await next.json()).sessionId;
      expect(nextOwner).not.toBe(owner);
      const retired = (await f.state(owner))[0];
      expect(
        retired?.events.some((e) => e.type === "session.end" && e.data.reason === "stopped"),
      ).toBe(true);
      owner = nextOwner;
      await showPane("Activity");
      await expect(
        page.getByRole("button", { name: "Download assembled.csv", exact: true }),
      ).toBeEnabled({ timeout: 60_000 });
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download assembled.csv", exact: true }).click();
      const received = await download;
      const path = info.outputPath("assembled.csv");
      await received.saveAs(path);
      const rows = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(","));
      expect(rows).toEqual([
        ["item", "quantity", "unit_price", "total"],
        ["Alpha", "3", "4.50", "13.50"],
        ["Beta", "2", "6.25", "12.50"],
        ["TOTAL", "", "", "26.00"],
      ]);
      const total = rows.slice(1, 3).reduce((sum, row) => sum + Number(row[1]) * Number(row[2]), 0);
      expect(total).toBe(Number(rows[3]?.[3]));
      checkpoint("export");
      const finished = (await f.state(owner))[0];
      expect(finished?.provider).toHaveLength(9);
      expect(finished?.provider.every((p) => !p.manualSentinelPresent)).toBe(true);
      expect(JSON.stringify(finished?.events)).not.toContain(CANARY);
      expect(
        await page.evaluate(() =>
          JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
        ),
      ).not.toContain(CANARY);
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
      expect(
        csp.every(
          (event) =>
            event.surface === "decoder" &&
            event.directive === "style-src-elem" &&
            event.blockedURI === "inline",
        ),
      ).toBe(true);
      expect(csp.filter((event) => event.surface === "theatre")).toEqual([]);
      await expect
        .poll(async () => (await f.state(owner))[0]?.status, { timeout: 15_000 })
        .toBe("idle");
      await showPane("Conversation");
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("task14 follow-up: change Alpha quantity to 4 and export the updated table.");
      await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
      await showPane("Activity");
      await expect(
        page.getByText("Follow-up updated Alpha quantity to 4; total 30.50.", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      const followupDownload = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download assembled.csv", exact: true })
        .last()
        .click();
      const followupPath = info.outputPath("assembled-followup.csv");
      await (await followupDownload).saveAs(followupPath);
      const followupRows = readFileSync(followupPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(","));
      expect(followupRows).toEqual([
        ["item", "quantity", "unit_price", "total"],
        ["Alpha", "4", "4.50", "18.00"],
        ["Beta", "2", "6.25", "12.50"],
        ["TOTAL", "", "", "30.50"],
      ]);
      expect(
        followupRows.slice(1, 3).reduce((sum, row) => sum + Number(row[1]) * Number(row[2]), 0),
      ).toBe(Number(followupRows[3]?.[3]));
      const followup = (await f.state(owner))[0];
      expect(followup?.sessionId).toBe(owner);
      expect(followup?.provider).toHaveLength(11);
      expect(
        followup?.provider.every(
          (entry) => entry.model === "fixture-assembled-v1" && !entry.manualSentinelPresent,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("assembled-result-desktop.png"),
        fullPage: true,
      });
      writeFileSync(
        info.outputPath("assembly-proof.json"),
        JSON.stringify(
          {
            syntheticModel: true,
            realComponents: [
              "browser",
              "daemon",
              "agent-runner",
              "keyd-admin",
              "keyd-gateway",
              "vault",
              "budget",
              "brain-container",
              "desktop-container",
              "desktopd",
              "stream",
            ],
            viewport: page.viewportSize(),
            stopSheet,
            images: f.images,
            owner,
            beforeManual,
            held,
            beforeStop,
            stopped,
            resumed,
            streamTickets: {
              beforeSHA256: ticketHash(oldTicketSrc as string),
              afterSHA256: ticketHash(newTicketSrc as string),
              staleHTTP: 403,
            },
            finished,
            followup,
            followupRows,
            streams,
            rows,
            total,
            errors,
            external,
            csp,
            realAccount: "not-run",
            realPaidModel: "not-run",
            actualModelGuiCapability: "unverified",
          },
          null,
          2,
        ),
      );
      complete = true;
    };
    try {
      await run();
    } catch (error) {
      workFailed = true;
      workFailure = error;
    } finally {
      const attempt = async (work: () => unknown | Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          retirementFailures.push(error);
        }
      };
      // Diagnostics and each owner retire independently; one failure cannot skip another.
      await attempt(async () => {
        if (!complete && !page.isClosed())
          writeFileSync(
            info.outputPath("last-page.txt"),
            await page
              .locator("body")
              .innerText()
              .catch(() => "Page unavailable"),
          );
      });
      await attempt(async () => {
        if (!complete && !page.isClosed())
          await page.screenshot({ path: info.outputPath(`last-${phase}.png`), fullPage: true });
      });
      await attempt(async () => {
        if (!complete)
          writeFileSync(
            info.outputPath("last-state.json"),
            JSON.stringify(await f.state(owner).catch(() => []), null, 2),
          );
      });
      await attempt(() => page.close());
      await attempt(() => f.close());
    }
    if (retirementFailures.length)
      throw new AggregateError(
        [...(workFailed ? [workFailure] : []), ...retirementFailures],
        `Acceptance retirement or capture failed: ${retirementFailures.map((error) => String(error)).join("; ")}`,
      );
    if (workFailed) throw workFailure;
  });
