import type { DesktopdClient } from "../../desktopd/client.ts";
import { maskFrame } from "../../gateway/mask.ts";
import type { WindowOwners } from "../../gateway/window-owners.ts";
import { hiddenParts } from "../../gateway/window-owners.ts";
import { raster } from "../../raster.ts";

// dot's own frames are this fresh while it looks; a new look isn't worth taking then.
const FRESH_ENOUGH_MS = 15_000;

export interface FreshLookDeps {
  sessionId: string;
  cellId: string;
  // The task is running, its screen is the desktop and the computer isn't the user's right now.
  // The web browser's look takes a permit from dot's turn and one observation at a time, so a look
  // from here could fail dot's own: there, dot's last frame is what a side question sees.
  onDesktop(): boolean;
  // Someone is acting on the computer: dot's next frame is a moment away.
  acting(): boolean;
  device(): { client: Pick<DesktopdClient, "observe"> } | undefined;
  owners(): Pick<WindowOwners, "foreign" | "known">;
  scale(): number;
}

// A new look at the desktop, covered as dot's observations are: other tasks' windows, and windows
// too new to tell whose they are. It holds no turn and raises no window; its frame isn't saved, and
// nothing in the task hears of it. Undefined when the computer can't be looked at without getting
// in anyone's way.
export async function freshDesktopLook(
  deps: FreshLookDeps,
  newestAgeMs: number | undefined,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  if (newestAgeMs !== undefined && newestAgeMs < FRESH_ENOUGH_MS) return undefined;
  if (!deps.onDesktop() || deps.acting()) return undefined;
  const device = deps.device();
  if (!device) return undefined;
  const look = await device.client.observe(signal);
  const owners = deps.owners();
  const hidden = hiddenParts(
    look.windows,
    (id) => owners.foreign(deps.sessionId, id) || !owners.known(id),
  );
  const image = await maskFrame(Buffer.from(look.image, "base64"), hidden, deps.scale());
  return (await raster(image)).png({ compressionLevel: 6 }).toBuffer();
}
