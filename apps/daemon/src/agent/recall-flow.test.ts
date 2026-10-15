import { afterEach, expect, it } from "vitest";
import { brainFlow } from "./testing/brain-flow.ts";

const fixtures: Awaited<ReturnType<typeof brainFlow>>[] = [];
// Reset the memory-write guard at the first model call to isolate the tested lookup.
// The provenance ledger still records startup skill-catalog reads as untrusted files.
function freshAfterFirstLook(f: Awaited<ReturnType<typeof brainFlow>>) {
  let calls = 0;
  f.controls.beforeModel = () => {
    if (calls++ === 0) f.h.session.tainted = false;
  };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

it("a recall from the brain is untrusted and the next remember is refused", async () => {
  const f = await brainFlow([
    [{ name: "recall", input: { query: "insurance" } }],
    [
      {
        name: "remember",
        input: { file: "MEMORY.md", op: "append", text: "- Insurer is Example Mutual" },
      },
    ],
    [{ name: "done", input: { summary: "Checked." } }],
  ]);
  fixtures.push(f);
  freshAfterFirstLook(f);
  f.h.tools.recall = () => [
    {
      title: "Renew the car insurance",
      day: "2026-09-03",
      kind: "summary",
      snippet: "Insurer is Example Mutual.",
    },
  ];
  expect(await f.run()).toBe("done");
  const stored = JSON.stringify(f.h.transcripts.read(f.h.session.id));
  expect(stored).toContain('<untrusted source=\\"earlier tasks\\">');
  expect(stored).toContain("Memory can only be saved");
  expect(f.h.session.tainted).toBe(true);
  expect(f.h.session.taint.kinds).toEqual(["recall"]);
  expect(f.h.events().some((e) => e.type === "memory.change")).toBe(false);
});

it("a people lookup from the brain is untrusted and the next remember is refused", async () => {
  const f = await brainFlow([
    [{ name: "people", input: { op: "find", query: "Henry" } }],
    [{ name: "remember", input: { file: "USER.md", op: "append", text: "- Henry is a friend" } }],
    [{ name: "done", input: { summary: "Checked." } }],
  ]);
  fixtures.push(f);
  freshAfterFirstLook(f);
  f.h.tools.people?.record(f.h.session.id, { name: "Henry", app: "WeChat", handle: "henry_l" });
  expect(await f.run()).toBe("done");
  const stored = JSON.stringify(f.h.transcripts.read(f.h.session.id));
  expect(stored).toContain('<untrusted source=\\"people the user reaches\\">');
  expect(stored).toContain("Memory can only be saved");
  expect(f.h.session.taint.kinds).toEqual(["memory"]);
  expect(f.h.events().some((e) => e.type === "memory.change")).toBe(false);
});
