import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserProfileTooNewError, refuseNewerProfile } from "./profile-version.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function profile(lastVersion?: string): string {
  const folder = mkdtempSync(join(tmpdir(), "profile-version-"));
  folders.push(folder);
  if (lastVersion !== undefined) writeFileSync(join(folder, "Last Version"), lastVersion);
  return folder;
}
const answers = (text: string) => async () => text;

describe("an older browser and a newer profile", () => {
  it("refuses a profile a newer major version opened, without touching it", async () => {
    await expect(
      refuseNewerProfile(profile("157.0.8103.38"), "/x", answers("Chromium 154.0.8037.57 \n")),
    ).rejects.toBeInstanceOf(BrowserProfileTooNewError);
    await expect(
      refuseNewerProfile(profile("157.0.8103.38"), "/x", answers("Chromium 154.0.8037.57 \n")),
    ).rejects.toThrow(/Chromium 154\.0\.8037\.57.*157\.0\.8103\.38/u);
  });

  it("opens a profile from the same major version or an older one", async () => {
    for (const last of ["154.0.8037.99", "154.0.8037.57", "153.0.1.1"])
      await expect(
        refuseNewerProfile(profile(last), "/x", answers("Chromium 154.0.8037.57")),
      ).resolves.toBeUndefined();
  });

  it("reads Chrome's own version line", async () => {
    await expect(
      refuseNewerProfile(profile("157.0.1.1"), "/x", answers("Google Chrome 156.0.8078.79 \n")),
    ).rejects.toThrow(/Google Chrome 156/u);
  });

  it("doesn't ask the browser about a profile nothing has opened", async () => {
    const asked = () => {
      throw new Error("asked");
    };
    await expect(refuseNewerProfile(profile(), "/x", asked)).resolves.toBeUndefined();
  });

  it("leaves an unreadable version line to the browser", async () => {
    await expect(
      refuseNewerProfile(profile("not a version"), "/x", answers("Chromium 1.0.0.0")),
    ).resolves.toBeUndefined();
  });

  it("refuses when the browser can't say what it is", async () => {
    await expect(
      refuseNewerProfile(profile("157.0.1.1"), "/x", answers("something else")),
    ).rejects.toThrow(/version/u);
  });
});
