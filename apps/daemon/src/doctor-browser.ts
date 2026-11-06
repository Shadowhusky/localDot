import { readBrowserEngine } from "./cells/browser-engine.ts";
import { browserIdentity, verifyChromeImage } from "./cells/chrome-image.ts";
import type { DockerClient } from "./cells/docker.ts";
import { NAME_PREFIX } from "./cells/spec.ts";
import type { DoctorCheck } from "./doctor.ts";

const name = "browser-in-use";

// Says which browser dot's web browser runs. Advisory: Chromium is always a working answer, so
// this never fails the doctor. The release's pinned browser image has its own digest check.
export async function browserInUseCheck(
  docker: Pick<DockerClient, "request">,
  home: string,
  base: string,
): Promise<DoctorCheck> {
  const record = readBrowserEngine(home);
  try {
    if (record?.choice === "chrome" && record.chrome && record.handOver === "done") {
      const { chrome } = record;
      if (await verifyChromeImage(docker, chrome, base))
        return {
          name,
          ok: true,
          detail: `Google Chrome ${chrome.version}, installed on this computer from Google on ${chrome.installedAt.slice(0, 10)}, on the release's browser image. Accepted Google's terms on ${record.acceptedAt?.slice(0, 10) ?? "an unknown date"}.`,
        };
      return {
        name,
        ok: true,
        detail:
          "Google Chrome was chosen, but its image is missing or was made for another release. localDot installs it again when the web browser next starts.",
      };
    }
    const identity = await browserIdentity(docker, base, NAME_PREFIX);
    if (!identity)
      return { name, ok: true, detail: "The browser image couldn't say which browser it holds." };
    if (identity.engine === "chrome")
      return {
        name,
        ok: true,
        detail: `Google Chrome ${identity.version ?? ""}, built into this browser image.`.replace(
          "  ",
          " ",
        ),
      };
    const reason =
      record?.choice === "chrome"
        ? (record.problem?.text ?? "Google Chrome is being prepared.")
        : record?.choice === "chromium"
          ? "You chose it over Google Chrome."
          : "Google Chrome is available in Settings → Accounts.";
    return {
      name,
      ok: true,
      detail: `Chromium ${identity.version ?? ""}. ${reason}`.replace("  ", " "),
    };
  } catch {
    return { name, ok: true, detail: "Docker couldn't say which browser is in use." };
  }
}
