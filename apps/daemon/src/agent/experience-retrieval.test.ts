import { expect, it } from "vitest";
import type { LearnedExperience } from "../../../../packages/protocol/src/experience.ts";
import {
  experienceText,
  parseExperience,
  relevantExperience,
  selectExperience,
} from "./experience.ts";
import type { StoredEntry } from "./memory.ts";
import { memoryTokens } from "./memory-budget.ts";

// Hand-authored retrieval regression corpus, not a live-model or public benchmark.
// Lesson cues are written once; queries include alternate phrasings and distractors.
const skills: [string, LearnedExperience][] = [
  [
    "auth",
    {
      scope: "Browser authentication",
      when: "An additional verification screen follows sign-in",
      procedure:
        "Read the verification prompt and request the required input; preserve the current page instead of restarting sign-in.",
      recheck: "Confirm that the account page is visible.",
      cues: ["login code", "sign in", "登录验证"],
    },
  ],
  [
    "qr",
    {
      scope: "QR authorization",
      when: "A scannable challenge is visible",
      procedure:
        "Show the challenge and wait for the user to scan; a waiting page is not proof of an unresponsive app.",
      recheck: "Observe whether the challenge expires or the app advances.",
      cues: ["scan barcode", "二维码"],
    },
  ],
  [
    "csv",
    {
      scope: "Spreadsheet import",
      when: "Delimited records include leading-zero identifiers",
      procedure:
        "Import identifier columns as text, then compare row counts and representative identifiers.",
      recheck: "Check the first and last identifier against the source.",
      cues: ["CSV account numbers", "表格导入"],
    },
  ],
  [
    "sources",
    {
      scope: "Research provenance",
      when: "Several articles repeat a claim",
      procedure:
        "Trace the claim to its original source; syndicated copies are not independent confirmation.",
      recheck: "Check authors, dates and the original evidence.",
      cues: ["independent sources", "cross check claims"],
    },
  ],
  [
    "pdf",
    {
      scope: "PDF pagination",
      when: "Long tables span several pages",
      procedure: "Repeat column headers and inspect the first, middle and last exported page.",
      recheck: "Look for clipped rows and missing headers.",
      cues: ["report page breaks", "print tables"],
    },
  ],
  [
    "calendar",
    {
      scope: "Calendar scheduling",
      when: "Participants use different time zones",
      procedure:
        "Check each location's daylight-saving offset for the meeting date before proposing a time.",
      recheck: "Confirm the displayed local time for each participant.",
      cues: ["meeting time zones", "安排会议"],
    },
  ],
  [
    "mail",
    {
      scope: "Email attachments",
      when: "Sending a message with a document",
      procedure:
        "Confirm the correct recipient and that the attachment finished uploading before sending.",
      recheck: "Inspect the attachment name and recipient immediately before send.",
      cues: ["send document", "mail attachment"],
    },
  ],
  [
    "code",
    {
      scope: "Northstar client generation",
      when: "Node 24 workspace",
      procedure:
        "Generate the client before tests; dependency installation alone does not produce the generated code.",
      recheck: "Read current repository instructions and run the tests.",
      cues: ["northstar tests", "constellation workspace"],
    },
  ],
  [
    "archive",
    {
      scope: "Archive extraction",
      when: "A nested directory appears after unpacking",
      procedure:
        "Inspect the extracted root before operating on paths; archive names need not equal their directory names.",
      recheck: "List the actual extracted directory.",
      cues: ["unpack zip", "compressed folder"],
    },
  ],
];
const cases: [string, string | null][] = [
  ["Browser authentication on this website", "auth"],
  ["Enter the login code the site requires", "auth"],
  ["帮我完成登录验证", "auth"],
  ["QR authorization in the messaging app", "qr"],
  ["Show the 二维码 to connect the app", "qr"],
  ["Spreadsheet import from a bank file", "csv"],
  ["Keep the account numbers when reading this CSV", "csv"],
  ["检查表格导入后的数据", "csv"],
  ["Research provenance for this claim", "sources"],
  ["Find independent sources for the announcement", "sources"],
  ["Check the report page breaks", "pdf"],
  ["Calendar scheduling next week", "calendar"],
  ["Choose meeting time zones for the participants", "calendar"],
  ["帮我安排会议", "calendar"],
  ["Send this document to the recipient", "mail"],
  ["Fix northstar tests", "code"],
  ["Daily automation in the constellation workspace", "code"],
  ["Unpack this zip into a folder", "archive"],
  ["What is the weather tomorrow?", null],
  ["Compose a birthday poem", null],
  ["Import browser bookmarks", null],
  ["Export calendar events", "calendar"],
];
const entries: StoredEntry[] = skills.map(([id, value]) => ({
  id,
  text: experienceText(value, "01M4KDYHMT8CCSRZW9C8BJA8AV"),
  file: "notes/2026-10-10.md",
  source: { kind: "task", sessionId: "01M4KER0K90QRRK6NWRVC7E9HG" },
  at: "2026-10-10",
  pinned: false,
  revision: "test",
}));
// Frozen pre-change scope-overlap baseline. Cues are deliberately ignored, as they were then.
function baseline(task: string) {
  const common = new Set(
    "the this that with from have will please task work test app repo project setup run make check using local code my our your for and into about again".split(
      " ",
    ),
  );
  const terms = (s: string) =>
    new Set(
      (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]+/gu) ?? []).filter((w) => !common.has(w)),
    );
  const query = terms(task);
  return entries
    .flatMap((entry, index) => {
      const value = parseExperience(entry.text);
      if (!value) throw new Error("Invalid fixture");
      const scope = [...terms(value.scope)];
      const matches = scope.filter((word) => query.has(word)).length;
      if (!matches) return [];
      return [
        {
          id: entry.id,
          score:
            matches / Math.max(1, scope.length) +
            [...terms(value.when)].filter((word) => query.has(word)).length / 20,
          index,
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((r) => r.id);
}

it("compares bounded cross-domain recall against the previous scope-only selector", () => {
  let before = 0,
    after = 0,
    beforeHits = 0,
    afterHits = 0,
    beforeRelevant = 0,
    afterRelevant = 0;
  const rows = cases.map(([query, expected]) => {
    const old = baseline(query);
    const next = selectExperience(entries, query).map((row) => row.entry.id);
    before += Number(expected ? old[0] === expected : old.length === 0);
    after += Number(expected ? next[0] === expected : next.length === 0);
    beforeHits += old.length;
    afterHits += next.length;
    beforeRelevant += Number(expected !== null && old.includes(expected));
    afterRelevant += Number(expected !== null && next.includes(expected));
    expect(memoryTokens(relevantExperience(entries, query))).toBeLessThanOrEqual(900);
    return { query, expected, before: old, after: next };
  });
  const result = {
    cases: cases.length,
    beforeTop1OrAbstention: before,
    afterTop1OrAbstention: after,
    beforePrecision: beforeRelevant / beforeHits,
    afterPrecision: afterRelevant / afterHits,
    rows,
  };
  console.info(JSON.stringify(result, null, 2));
  expect(after).toBeGreaterThan(before);
  expect(after).toBeGreaterThanOrEqual(20);
});
