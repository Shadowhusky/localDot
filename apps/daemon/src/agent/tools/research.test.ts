import { afterEach, describe, expect, it } from "vitest";
import { ResearchLog } from "../research.ts";
import { toolHarness } from "../testing/harness.ts";
import { pdfCommand, reportPdfCommand, shellQuote } from "./research.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});
function harness(budget = { sources: 3, minutes: 30 }) {
  const h = toolHarness();
  fixtures.push(h);
  h.session.research = new ResearchLog(budget, (type, data) => h.session.append(type, data));
  return h;
}
const textOf = (res: { body: { content: { text?: string }[] } }) =>
  res.body.content.map((c) => c.text ?? "").join("\n");
const read = async (h: ReturnType<typeof harness>, url: string, title = "Page") => {
  h.desktop.page = { url, title, text: "Body", outline: "", truncated: false };
  return h.call("browser_read", {});
};

describe("research mode's sources", () => {
  it("numbers each public page dot reads, but no results page or local page", async () => {
    const h = harness({ sources: 10, minutes: 30 });
    const first = await read(h, "https://heat.example.org/cop", "COP study");
    expect(textOf(first)).toMatch(
      /^Source \[1\] \(1 of about 10 sources, 0 of 30 minutes\)\.\n<untrusted/,
    );
    expect(textOf(await read(h, "https://www.google.com/search?q=cop"))).not.toContain("Source [");
    expect(textOf(await read(h, "http://localhost:8000/"))).not.toContain("Source [");
    expect(textOf(await read(h, "https://heat.example.org/cop#fig"))).toContain("Source [1]");
    expect(
      h
        .events()
        .filter((e) => e.type === "research.source")
        .map((e) => e.data),
    ).toEqual([{ n: 1, url: "https://heat.example.org/cop", title: "COP study", passages: 0 }]);
  });
  it("is a plain read outside research mode", async () => {
    const h = toolHarness();
    fixtures.push(h);
    h.desktop.page = {
      url: "https://a.example.org/",
      title: "A",
      text: "x",
      outline: "",
      truncated: false,
    };
    expect(textOf(await h.call("browser_read", {}))).toMatch(/^<untrusted/);
    expect(
      (await h.call("research", { op: "source", url: "https://a.example.org/" })).body,
    ).toMatchObject({
      ok: false,
      content: [{ text: expect.stringContaining("Research mode is off") }],
    });
  });
  it("records the passages dot relies on and gives the number to cite", async () => {
    const h = harness();
    const key = `sk-proj-${"k".repeat(40)}`;
    const res = await h.call("research", {
      op: "source",
      url: "https://data.example.org/table",
      title: "Table 4",
      passages: ["Sales rose 12% in 2025.", `token ${key}`],
    });
    expect(textOf(res)).toContain(
      "Source [1]: added, 2 passages recorded (2 in all). Cite it as [1].",
    );
    expect(h.session.research?.source(1)?.passages).toEqual([
      "Sales rose 12% in 2025.",
      "token [redacted]",
    ]);
    const again = await h.call("research", {
      op: "source",
      url: "https://data.example.org/table",
      passages: ["Sales rose 12% in 2025."],
    });
    expect(textOf(again)).toContain("Source [1]: already listed.");
  });
});

describe("the research budget", () => {
  it("stops new gathering gracefully once reached, but lets dot reopen its sources and write", async () => {
    const h = harness({ sources: 3, minutes: 30 });
    await read(h, "https://a.example.org/1");
    await read(h, "https://a.example.org/2");
    const third = await read(h, "https://a.example.org/3");
    expect(textOf(third)).toContain("The research budget (3 sources) is reached.");
    expect(h.events().find((e) => e.type === "research.budget")?.data).toEqual({
      sources: 3,
      minutes: 30,
      stopped: "sources",
    });
    const blocked = await h.call("browser_navigate", { url: "https://b.example.org/" });
    expect(blocked.body.ok).toBe(false);
    expect(textOf(blocked)).toContain("write the report now with the sources you have");
    const pdf = await h.call("research", { op: "pdf", url: "https://b.example.org/x.pdf" });
    expect(pdf.body.ok).toBe(false);
    expect(h.desktop.shellCalls).toEqual([]);
    const reopened = await h.call("browser_navigate", { url: "https://a.example.org/1" });
    expect(reopened.body.ok).toBe(true);
    const unlisted = await read(h, "https://c.example.org/");
    expect(unlisted.body.ok).toBe(false);
    expect(textOf(unlisted)).toContain("Stop gathering");
    const written = await h.call("files", { op: "write", path: "notes.md", content: "x" });
    expect(textOf(written)).not.toContain("Stop gathering");
    const report = await h.call("research", {
      op: "report",
      title: "Partial",
      summary: "What the three sources say [1].",
      body: "Only three sources were read [1][2][3].",
    });
    expect(report.body.ok).toBe(true);
    expect(textOf(report)).not.toContain("Stop gathering");
  });
  it("hears the user's wrap-up at its next gathering step", async () => {
    const h = harness({ sources: 20, minutes: 30 });
    h.session.research?.wrapUp();
    const shell = await h.call("shell", { command: "ls" });
    expect(textOf(shell)).toContain("The user asked you to wrap up.");
  });
});

describe("reading a PDF", () => {
  it("downloads it in the computer, lists it as a source and returns its text as untrusted", async () => {
    const h = harness();
    h.desktop.shellOutput = [
      { stream: "stdout", chunk: "@title Annual report 2025\n@pages 64\n@text\nRevenue grew." },
    ];
    const res = await h.call("research", { op: "pdf", url: "https://ir.example.org/ar.pdf" });
    expect(res.body.ok).toBe(true);
    const out = textOf(res);
    expect(out).toMatch(/^Source \[1\]/);
    expect(out).toContain('<untrusted source="PDF https://ir.example.org/ar.pdf">');
    expect(out).toContain("Pages: 64 (text of the first 40)");
    expect(out).toContain("Revenue grew.");
    expect(h.session.research?.source(1)?.title).toBe("Annual report 2025");
    expect(h.session.tainted).toBe(true);
    expect(h.desktop.shellCalls[0]).toContain("'https://ir.example.org/ar.pdf'");
  });
  it("says what went wrong when it is no PDF", async () => {
    const h = harness();
    h.desktop.shellOutput = [{ stream: "stdout", chunk: "@error The link is not a PDF.\n" }];
    const res = await h.call("research", { op: "pdf", url: "https://ir.example.org/page" });
    expect(res.body).toMatchObject({ ok: false, content: [{ text: "The link is not a PDF." }] });
    expect(h.session.research?.sources).toHaveLength(0);
  });
  it("quotes the address so it can never become a command", () => {
    expect(shellQuote("https://x.example.org/a'b;rm -rf ~")).toBe(
      "'https://x.example.org/a'\\''b;rm -rf ~'",
    );
    expect(pdfCommand("https://x.example.org/it's.pdf")).toContain(
      "-o in.pdf 'https://x.example.org/it'\\''s.pdf' 2>err",
    );
    expect(() => reportPdfCommand("x'; rm -rf ~")).toThrow("invalid report name");
  });
});

describe("writing the report", () => {
  it("writes Markdown with numbered citations, makes the PDF and marks what it cites", async () => {
    const h = harness({ sources: 10, minutes: 30 });
    await read(h, "https://a.example.org/1", "First");
    await read(h, "https://b.example.org/2", "Second");
    const res = await h.call("research", {
      op: "report",
      title: "Heat pumps",
      summary: "They work [2].",
      body: "## Cost\nIt depends [2][1].",
    });
    expect(res.body.ok).toBe(true);
    const markdown = h.desktop.files.get("Reports/heat-pumps.md") ?? "";
    expect(markdown).toContain("They work [1].");
    expect(markdown).toContain("It depends [1][2].");
    expect(markdown).toContain("1. [Second](<https://b.example.org/2>) · b.example.org");
    expect(h.desktop.shellCalls[0]).toContain("'heat-pumps.md'");
    expect(textOf(res)).toContain(
      "Report written: ~/Reports/heat-pumps.md and ~/Reports/heat-pumps.pdf. It cites 2 of 2 sources",
    );
    expect(
      h.events().flatMap((e) => (e.type === "research.source" && e.data.cited ? [e.data.n] : [])),
    ).toEqual([2, 1]);
    expect(h.events().some((e) => e.type === "file.change")).toBe(true);
  });
  it("hands over the Markdown alone when the PDF can't be made", async () => {
    const h = harness();
    h.desktop.shellDone = { exitCode: 1 };
    const res = await h.call("research", {
      op: "report",
      title: "Nothing found",
      summary: "No sources answered the question.",
      body: "Searches turned up nothing relevant.",
      file: "empty.md",
    });
    expect(h.desktop.files.has("Reports/empty.md")).toBe(true);
    expect(textOf(res)).toContain("The PDF could not be made: hand over the Markdown file alone.");
  });
  it("refuses a report that cites none of the sources dot read", async () => {
    const h = harness();
    await read(h, "https://a.example.org/1");
    const res = await h.call("research", {
      op: "report",
      title: "T",
      summary: "S.",
      body: "No citations here.",
    });
    expect(res.body.ok).toBe(false);
    expect(textOf(res)).toContain("The report cites no sources.");
    expect([...h.desktop.files.keys()]).toEqual([]);
  });
});
