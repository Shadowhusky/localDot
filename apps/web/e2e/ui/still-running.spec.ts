import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { chatRail, composer, expect, test } from "./harness.ts";

// A task the computer still runs is never shown as cut off: not when the computer's answer about
// it and the conversation read back reach the page together just after the last task ended, nor
// when one answer leaves it out. In Studio on a wide screen and in Chat on a phone.

interface Together {
  arm(previous: string): void;
  // The conversation read is held.
  waiting: boolean;
  // Both answers are on their way to the page.
  released: boolean;
}

// Once armed: holds the conversation read that the last task's end asks for, unsent, and the
// computer's first answer naming a task other than `previous`; then sends the read and hands both
// answers over in one go, as the phone had them, a millisecond apart, once the daemon had started
// the next task.
function holdTogether() {
  type Read = { input: RequestInfo | URL; init?: RequestInit; resolve(response: Response): void };
  type Answer = { response: Response; text: string; resolve(response: Response): void };
  const send = window.fetch.bind(window);
  const state = {
    previous: "",
    armed: false,
    read: null as Read | null,
    live: null as Answer | null,
  };
  const together: Together = {
    arm(previous) {
      state.previous = previous;
      state.armed = true;
    },
    waiting: false,
    released: false,
  };
  Object.assign(window, { together });
  // The answer read whole, so the page has it at once.
  const whole = (response: Response, text: string) => {
    const copy = new Response(text || null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    copy.text = () => Promise.resolve(text);
    return copy;
  };
  const both = async () => {
    const { read, live } = state;
    if (!read || !live) return;
    state.armed = false;
    const response = await send(read.input, read.init);
    const text = await response.text();
    together.released = true;
    read.resolve(whole(response, text));
    live.resolve(whole(live.response, live.text));
  };
  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url, window.location.href).pathname;
    if (state.armed && path === "/api/conversation" && (init?.method ?? "GET") === "GET")
      return new Promise<Response>((resolve) => {
        state.read = { input, init, resolve };
        together.waiting = true;
        void both();
      });
    const response = await send(input, init);
    if (!state.armed || !path.endsWith("/live")) return response;
    const text = await response.text();
    const named = text ? (JSON.parse(text) as { sessionId?: string; current?: string }) : {};
    const task = named.current ?? named.sessionId;
    if (!task || task === state.previous) return whole(response, text);
    return new Promise<Response>((resolve) => {
      state.live = { response, text, resolve };
      void both();
    });
  };
}
const held = (page: Page, what: "waiting" | "released") =>
  page.evaluate((key) => (window as unknown as { together: Together }).together[key], what);

// From now on, notes whether the page ever says the task was cut off: the recovery card, dot's line,
// the island's status or the thread's.
async function watchCutOff(page: Page) {
  await page.evaluate(() => {
    const said: string[] = [];
    (window as unknown as { cutOff: string[] }).cutOff = said;
    const look = () => {
      const page = document.body.textContent ?? "";
      const thread = document.querySelector(".thread")?.textContent ?? "";
      for (const [words, where] of [
        ["cut off before I finished", page],
        ["Task interrupted", page],
        ["Interrupted", thread],
      ] as const)
        if (where.includes(words) && !said.includes(words)) said.push(words);
      requestAnimationFrame(look);
    };
    look();
  });
}
const cutOff = (page: Page) =>
  page.evaluate(() => (window as unknown as { cutOff: string[] }).cutOff);

// What says dot is at work on the task: the live step in Studio's thread, dot at the foot of Chat's.
const working = (rail: Locator, view: "studio" | "chat") =>
  rail.locator(view === "studio" ? ".thread .thread-work[data-live]" : ".dot-strip[data-live]");

const shownTask = async (request: APIRequestContext, origin: string) =>
  ((await (await request.get(`${origin}/__qa/state`)).json()) as { sessionId: string }).sessionId;

for (const [view, projects] of [
  ["studio", ["c14"]],
  ["chat", ["c39", "w39"]],
] as const)
  test.describe(view, () => {
    test.use({ viewStyle: view });
    test.beforeEach(() => {
      const project = test.info().project.name;
      test.skip(
        !(projects as readonly string[]).includes(project),
        `Runs at ${projects.join(" and ")}`,
      );
    });

    test("the next task stays live when the computer and the conversation name it together", async ({
      page,
      ui,
      request,
    }) => {
      await page.addInitScript(holdTogether);
      const fixture = await ui.open("running");
      const rail = await chatRail(page);
      await expect(working(rail, view)).toContainText("Checking February's net total");
      const previous = await shownTask(request, fixture.origin);
      // The next task's first words come once both answers are in.
      expect((await request.post(`${fixture.origin}/__qa/reply?ms=4000`)).ok()).toBe(true);
      await page.evaluate(
        (id) => (window as unknown as { together: Together }).together.arm(id),
        previous,
      );
      // The task ends, as Continue with another model ends a paused one.
      const stop = await request.post(
        `${fixture.origin}/api/agent/sessions/${previous}/stop?giveBack=1`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(stop.ok(), await stop.text()).toBe(true);
      await expect.poll(() => held(page, "waiting")).toBe(true);
      const form = await composer(page);
      await form
        .getByRole("textbox", { name: /^(New task|Message)$/ })
        .fill("Carry on with the chart");
      await watchCutOff(page);
      await form.getByRole("button", { name: /^(Start task|Send|Send follow-up)$/ }).click();
      await expect.poll(() => held(page, "released")).toBe(true);
      expect(await shownTask(request, fixture.origin)).not.toBe(previous);
      await expect(rail.getByText("Sample reply: I received the task.")).toBeVisible();
      await expect(working(rail, view)).toBeVisible();
      await page.waitForTimeout(2_000);
      expect(await cutOff(page)).toEqual([]);
      await expect(rail.getByRole("region", { name: "Task recovery" })).toHaveCount(0);
    });

    test("a running task left out of one answer about the computer's task stays live", async ({
      page,
      ui,
    }) => {
      await ui.open("running");
      const rail = await chatRail(page);
      const work = working(rail, view);
      await expect(work).toContainText("Checking February's net total");
      await watchCutOff(page);
      let dropped = false;
      await page.route("**/api/cells/*/live", (route) => {
        if (dropped) return route.fallback();
        dropped = true;
        return route.fulfill({ status: 204 });
      });
      await expect.poll(() => dropped, { timeout: 10_000 }).toBe(true);
      // The answers after it name the task again.
      for (let answers = 0; answers < 2; answers++)
        await page.waitForResponse((reply) => new URL(reply.url()).pathname.endsWith("/live"));
      await page.waitForTimeout(500);
      expect(await cutOff(page)).toEqual([]);
      await expect(work).toContainText("Checking February's net total");
      await expect(rail.getByRole("region", { name: "Task recovery" })).toHaveCount(0);
    });
  });
