import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeAccountChoice } from "./account.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-account-"));
  homes.push(dir);
  return dir;
};

it("uses the Mac's account until the dot chooses its own, kept in a private folder of its home", () => {
  const dir = home();
  const choice = new ClaudeAccountChoice(dir);
  expect(choice.separate).toBe(false);
  expect(choice.folder()).toBeUndefined();
  choice.set(true);
  const folder = choice.folder();
  expect(folder).toMatch(/claude-code\/account$/);
  expect(folder?.startsWith(realpathSync(dir))).toBe(true);
  expect(statSync(folder ?? "").mode & 0o777).toBe(0o700);
  expect(new ClaudeAccountChoice(dir).separate).toBe(true);
  choice.set(false);
  expect(new ClaudeAccountChoice(dir).folder()).toBeUndefined();
  // Going back leaves the other account's folder for Claude Code; the choice alone changes.
  expect(existsSync(folder ?? "")).toBe(true);
});
