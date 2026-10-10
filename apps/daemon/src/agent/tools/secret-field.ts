import { MODEL_SCREEN, type Point, type ScreenName } from "@localdot/protocol";
import type { NativeDevice } from "../../desktopd/registry.ts";
import {
  type NativeActionIdentity,
  sameNativeIdentity,
  sameTarget,
} from "../../gateway/identity.ts";
import type { ToolCallContext, ToolDeps } from "./deps.ts";

interface Screen {
  device: NativeDevice;
  scale: 1 | 2;
  name: ScreenName;
  cellId: string;
  revision?: number;
  signal: AbortSignal;
  check(): void;
  privateInput?<T>(work: () => Promise<T>): Promise<T>;
}

// The field a secret answer is typed into, as the screen showed it when dot asked: the element
// under the point dot named (device pixels), or the one that had keyboard focus.
export interface SecretField {
  readonly screen: Pick<Screen, "name" | "cellId" | "revision">;
  readonly at?: Point;
  readonly found: NativeActionIdentity;
  readonly loginOrigin?: string;
}

const UNKNOWN: NativeActionIdentity = { target: null, window: null, point: null, unknown: true };

// The selected screen for one lookup or one delivery: a fresh lease each time, so a question
// that waits on the user holds no screen.
async function onScreen<T>(
  deps: ToolDeps,
  ctx: ToolCallContext,
  work: (screen: Screen) => Promise<T>,
): Promise<T> {
  ctx.check();
  const session = ctx.session;
  if (session.screens) {
    const lease = session.screenLease(ctx.lease);
    try {
      if (!deps.bindScreen) throw new Error("The selected screen is unavailable.");
      const binding = deps.bindScreen(session, lease);
      if (
        binding.cellId !== lease.selection.cellId ||
        binding.parentCellId !== session.cellId ||
        binding.scale !== lease.selection.geometry.scale
      )
        throw new Error("The selected screen does not match this question.");
      return await work({
        device: binding.device,
        scale: binding.scale,
        name: lease.selection.screen,
        cellId: lease.selection.cellId,
        revision: lease.selection.revision,
        signal: AbortSignal.any([ctx.signal, lease.signal]),
        privateInput: (work) => session.screens!.privateInput(lease, work),
        check: () => {
          ctx.check();
          lease.check();
        },
      });
    } finally {
      lease.finish();
    }
  }
  const device = deps.device?.(session.cellId);
  const scale = deps.scaleOf(session.cellId);
  if (!device || !scale) throw new Error("The computer is not ready for typing.");
  return work({
    device,
    scale,
    name: "desktop",
    cellId: session.cellId,
    signal: ctx.signal,
    check: ctx.check,
  });
}

// What is at `at`, or has keyboard focus without it. A lookup that failed is unknown, never
// "no element".
async function look(screen: Screen, at?: Point): Promise<NativeActionIdentity> {
  const hit = await (at ? screen.device.client.hitTest(at) : screen.device.client.focused()).catch(
    () => undefined,
  );
  screen.check();
  if (!hit) return UNKNOWN;
  return {
    target: hit.target,
    window: hit.window,
    point: at ?? hit.target?.point ?? null,
    ...(hit.windowFrame ? { windowFrame: hit.windowFrame } : {}),
    ...(hit.unknown ? { unknown: true as const } : {}),
  };
}

// The field as it is now, when dot asks; a message for dot when there is none to type into. Only a
// field that hides what is typed takes a secret: anywhere else it would show on screen and in the
// recording, run as a command, or be read back.
export function findSecretField(
  deps: ToolDeps,
  ctx: ToolCallContext,
  target: readonly number[] | undefined,
): Promise<SecretField | string> {
  return onScreen(deps, ctx, async (screen) => {
    let at: Point | undefined;
    if (target) {
      const [x = -1, y = -1] = target;
      const { width, height } = MODEL_SCREEN;
      if (!(x >= 0 && y >= 0 && x < width && y < height))
        return `The target (${x}, ${y}) is outside the ${width}x${height} screen.`;
      at = { x: Math.round(x * screen.scale), y: Math.round(y * screen.scale) };
    }
    const found = await look(screen, at);
    if (found.unknown || !found.target || found.target.editable === false)
      return at
        ? "There is no text field at that target. Take a screenshot and point at the field the answer goes into."
        : "No text field has keyboard focus. Click the field first, or give its point as target.";
    if (found.target.secret !== true)
      return at
        ? "The field at that target shows what is typed, so a secret can't go there. Point at the password box, or hand the computer to the user."
        : "The field with keyboard focus shows what is typed, so a secret can't go there. Give the password box's point as target, or hand the computer to the user.";
    let loginOrigin: string | undefined;
    if (screen.name === "browser" && screen.device.secret && found.target.url) {
      const url = new URL(found.target.url);
      if (url.protocol === "https:") {
        const info = await screen.device.secret(
          { origin: url.origin, at: at ?? found.target.point },
          screen.signal,
        );
        screen.check();
        if (info.rememberable) loginOrigin = url.origin;
      }
    }
    return {
      ...(loginOrigin ? { loginOrigin } : {}),
      screen: { name: screen.name, cellId: screen.cellId, revision: screen.revision },
      ...(at ? { at } : {}),
      found,
    };
  });
}

// Types `value` into the field through the input path the user's own control uses, only while it
// is the same field on the same screen; false, with nothing typed, when it moved, changed or could
// not be reached. A failure once typing began is thrown.
export async function typeSecret(
  deps: ToolDeps,
  ctx: ToolCallContext,
  field: SecretField,
  value: string,
  username?: string,
): Promise<boolean> {
  let typing = false;
  try {
    return await deliver(
      deps,
      ctx,
      field,
      value,
      () => {
        typing = true;
      },
      username,
    );
  } catch (error) {
    if (typing) throw error;
    ctx.check();
    return false;
  }
}

function deliver(
  deps: ToolDeps,
  ctx: ToolCallContext,
  field: SecretField,
  value: string,
  startTyping: () => void,
  username?: string,
): Promise<boolean> {
  return onScreen(deps, ctx, async (screen) => {
    if (
      screen.name !== field.screen.name ||
      screen.cellId !== field.screen.cellId ||
      screen.revision !== field.screen.revision
    )
      return false;
    const window = field.found.window ?? undefined;
    if (!sameNativeIdentity(field.found, await look(screen, field.at))) return false;
    if (screen.name === "browser") {
      if (!screen.device.secret || !field.found.target?.url)
        throw new Error("Secure browser input is unavailable.");
      const origin = new URL(field.found.target.url).origin;
      const at = field.at ?? field.found.target.point;
      const secret = screen.device.secret;
      startTyping();
      const deliver = () =>
        secret(
          {
            origin,
            at,
            text: value,
            ...(username ? { username } : {}),
          },
          screen.signal,
        );
      const result = await (screen.privateInput ? screen.privateInput(deliver) : deliver());
      screen.check();
      return result.filled;
    }
    if (field.at) {
      await screen.device.client.input(
        {
          input: { kind: "click", at: field.at, button: "left", count: 1 },
          holdMs: 0,
          injector: "xtest",
          ...(window === undefined ? {} : { window }),
        },
        screen.signal,
      );
      screen.check();
      // A hit test reports the point it was asked about, keyboard focus the element's centre.
      const focus = await look(screen);
      const was = field.found.target;
      if (
        focus.unknown ||
        !focus.target ||
        !was ||
        focus.window !== field.found.window ||
        !sameTarget({ ...was, point: focus.target.point }, focus.target)
      )
        return false;
    }
    // Whatever the field already holds, such as an earlier try, is replaced rather than added to.
    await screen.device.client.input(
      {
        input: { kind: "key", combo: ["ctrl", "a"] },
        holdMs: 0,
        injector: "xtest",
        ...(window === undefined ? {} : { window }),
      },
      screen.signal,
    );
    screen.check();
    startTyping();
    const typed = await screen.device.client.type(
      {
        text: value,
        masked: true,
        pace: { firstMs: 0, firstCount: 0, restMs: 0 },
        injector: "xtest",
        ...(window === undefined ? {} : { window }),
      },
      () => {},
      screen.signal,
    );
    screen.check();
    if (typed.count !== [...value].length)
      throw new Error("Typing the answer could not be confirmed.");
    return true;
  });
}
