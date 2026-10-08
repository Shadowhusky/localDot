// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { activityRows } from "../agent/activity.ts";
import { createApi } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import { stepRows } from "../session/session-view.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";

const event = (seq: number, type: string, data: unknown, step: string) =>
  LocalDotEvent.parse({
    v: 1,
    id: String(seq).padStart(26, "0"),
    seq,
    t: seq * 1000,
    agent: "main",
    type,
    data,
    step,
  });
afterEach(cleanup);

function rowFor(delivered: boolean) {
  const step = "click-name-box";
  const events = [
    event(1, "step.start", { kind: "gui" }, step),
    event(2, "action.intent", { verb: "click", label: 'Click "Name Box"', risk: "none" }, step),
    ...(delivered
      ? [
          event(
            3,
            "action.dispatch",
            {
              input: { kind: "click", button: "left", count: 1, at: { x: 100, y: 200 } },
              pressT: 3000,
              ringAt: 3000,
              injector: "xtest",
            },
            step,
          ),
          event(4, "action.result", { ok: true }, step),
        ]
      : [event(3, "action.cancel", { reason: "stale" }, step)]),
    event(5, "step.end", { status: delivered ? "ok" : "cancelled" }, step),
  ];
  const model = foldEvents(emptyModel(), events);
  const rows = timelineRows(stepRows(model), model.keyUses);
  const joined = activityRows(rows);
  return { model, rows, joined };
}
describe("recorded GUI delivery survives the actual row/render chain", () => {
  it.each([true, false])(
    "retains native dispatch=%s rather than inferring from completion or label",
    (delivered) => {
      const { rows, joined } = rowFor(delivered);
      expect(rows[0]).toMatchObject({ delivery: delivered ? "delivered" : "proposed" });
      expect(joined[0]).toMatchObject({
        computer: { delivery: delivered ? "delivered" : "proposed" },
      });
      render(
        <ActivityRail
          rows={rows}
          sessionId="00000000000000000000000000"
          scale={2}
          api={createApi("fixture", { origin: "http://inert.invalid" })}
          asOfMs={10}
        />,
      );
      const row = within(screen.getByTestId("step-row"));
      // Only input that never reached the computer is called out; delivered input says nothing.
      expect(row.queryAllByText("Not sent", { exact: true })).toHaveLength(delivered ? 0 : 1);
      expect(
        row.getByText(delivered ? 'Clicked "Name Box"' : 'Click "Name Box"', { exact: true }),
      ).toBeTruthy();
    },
  );
});
