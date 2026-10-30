// @vitest-environment jsdom
import { DEFAULT_AUTONOMY } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSheet, type SettingsSheetProps } from "./SettingsSheet.tsx";
import { SECTIONS } from "./sections.ts";
import { knownFixture } from "./testing.ts";

// A row's title is one line in a 600 px sheet and on a 390 px phone; the line under it explains.
// The kit ellipsises a longer one, so a title past this length is a title to shorten.
const MAX_TITLE = 30;
const TITLES =
  ".ui-group-row-label, .ui-group-row .ui-choice-label, .ui-group-row .ui-field-label, .ui-radio-card .ui-choice-label";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function onPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width < 700px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const everything = (): SettingsSheetProps => ({
  open: true,
  choices: {
    main: { provider: "openai", model: "sample-large", key: "openai-key" },
    fast: { provider: "openai", model: "sample-large", key: "openai-key" },
  },
  providers: [
    {
      id: "openai",
      models: [
        {
          id: "sample-large",
          name: "Sample Large",
          tier: "vision-tools",
          computer: "generic",
          coords: "pixels",
          note: "Uses localDot's computer tool",
          contextTokens: 1000,
          inputUSDPerMTok: 3,
          outputUSDPerMTok: 15,
        },
      ],
    },
  ],
  keys: [{ id: "openai-key", kind: "llm", provider: "openai" }],
  keyLayer: "online",
  catalog: "ready",
  dirty: false,
  onClose: vi.fn(),
  onChange: vi.fn(),
  onKeys: vi.fn(),
  autonomy: DEFAULT_AUTONOMY,
  onAutonomy: vi.fn(),
  purposeCheck: { on: true, change: vi.fn(), judge: "fast", addJevKey: vi.fn() },
  checkIns: {
    value: {
      steps: { on: true, value: "50" },
      failures: { on: true, value: "3" },
      actions: { on: true, value: "200" },
    },
    change: vi.fn(),
  },
  spending: { value: { on: true, task: "3", day: "" }, change: vi.fn() },
  spent: { taskUSD: 0.21, dayUSD: 1.39, estimated: true },
  appearance: { value: "graphite", dark: "graphite", saved: true, change: vi.fn() },
  showDot: { value: true, saved: true, change: vi.fn() },
  knowledge: {
    skills: [{ name: "sample-tables", description: "Reads tables.", source: "builtin" }],
    skillsPhase: "ready",
    memory: { user: "", memory: "" },
    memoryPhase: "ready",
    reloadSkills: vi.fn(),
    rereadMemory: vi.fn(),
  },
  known: knownFixture({ dir: "/Users/someone/Library/Application Support/localdot/memory" }),
  recentActivity: { on: true, change: vi.fn() },
  accounts: {
    phase: "ready",
    sites: [{ site: "google.com", hosts: ["accounts.google.com", "mail.google.com"], cookies: 4 }],
    pending: null,
    failure: null,
    reload: vi.fn(),
    signOut: vi.fn(),
    clearAll: vi.fn(async () => true),
  },
  stop: { label: "Shut down", enabled: true, run: vi.fn() },
  update: { available: true, busy: false, error: null, run: vi.fn() },
  freshStart: { available: true, busy: false, error: null, run: vi.fn() },
  stream: { value: "auto", saved: true, change: vi.fn() },
  stopAll: { run: vi.fn(), running: false },
  startAtLogin: { state: "off", busy: false, set: vi.fn() },
});

function titles(scope: ParentNode = document.body): string[] {
  return [...scope.querySelectorAll(TITLES)].map((title) => title.textContent?.trim() ?? "");
}

it("keeps every row title in the wide sheet short enough for one line", () => {
  render(<SettingsSheet {...everything()} />);
  const shown = [...titles()];
  for (const button of within(
    screen.getByRole("navigation", { name: "Settings sections" }),
  ).getAllByRole("button")) {
    fireEvent.click(button);
    shown.push(...titles());
  }
  expect(shown).toEqual(expect.arrayContaining(["Start fresh", "Open at login"]));
  expect(shown.filter((title) => title.length > MAX_TITLE)).toEqual([]);
});

it("keeps every row title on a phone's pages short enough for one line", () => {
  onPhone();
  render(
    <SettingsSheet
      {...everything()}
      stop={{ label: "Stop", enabled: true, run: vi.fn(), task: true }}
      stopNote={{ line: "Stopped. Your computer is paused." }}
    />,
  );
  const long: string[] = [];
  const pages = [...screen.getAllByRole("button")]
    .filter((row) => row.hasAttribute("data-link"))
    .map((row) => row.querySelector(".ui-group-row-label")?.textContent ?? "");
  long.push(...titles().filter((title) => title.length > MAX_TITLE));
  for (const page of pages) {
    const root = screen.getByRole("dialog", { name: "Settings" });
    fireEvent.click(within(root).getByRole("button", { name: new RegExp(`^${page}`) }));
    const open = screen.getByRole("dialog", { name: page });
    long.push(...titles(open).filter((title) => title.length > MAX_TITLE));
    fireEvent.click(within(open).getByRole("button", { name: "Settings" }));
  }
  expect(pages).toContain("Your computer");
  expect(long).toEqual([]);
});

it("names each section in a word or two", () => {
  expect(SECTIONS.filter((section) => section.title.length > 16)).toEqual([]);
});
