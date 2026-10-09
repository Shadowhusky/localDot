import { clipText, type PageElement, type WireElement } from "@localdot/protocol";

export const ELEMENTS_HEADER =
  "Interactive elements on screen, for browser_act by ref; boxes are [left, top, right, bottom] in the computer tool's coordinates:";

// desktopd's element in device pixels, as browser_read lists it in model pixels.
export function pageElement(wire: WireElement, scale: number): PageElement | undefined {
  if (!wire.node || !wire.bbox) return undefined;
  const box = wire.bbox;
  return {
    ref: `e${wire.node}`,
    role: clipText(wire.role ?? "", 64),
    name: clipText(wire.name ?? "", 200),
    box: { x: box.x / scale, y: box.y / scale, w: box.w / scale, h: box.h / scale },
    ...(wire.state?.value !== undefined && !wire.secret
      ? { value: clipText(wire.state.value, 200) }
      : {}),
    ...(wire.state?.checked ? { checked: wire.state.checked } : {}),
    ...(wire.state?.disabled ? { disabled: true as const } : {}),
    ...(wire.state?.expanded !== undefined ? { expanded: wire.state.expanded } : {}),
    ...(wire.secret ? { secret: true as const } : {}),
  };
}

const CHECKED = { true: "checked", false: "unchecked", mixed: "partly checked" } as const;

export function corners(box: PageElement["box"]): string {
  return `[${[box.x, box.y, box.x + box.w, box.y + box.h].map(Math.round).join(", ")}]`;
}

// One line per element: its ref, role, name, what it shows and its box.
export function elementLine(e: PageElement): string {
  const state = [
    ...(e.secret ? ["password"] : []),
    ...(e.value !== undefined ? [`value ${JSON.stringify(e.value)}`] : []),
    ...(e.checked ? [CHECKED[e.checked]] : []),
    ...(e.expanded === undefined ? [] : [e.expanded ? "expanded" : "collapsed"]),
    ...(e.disabled ? ["disabled"] : []),
  ];
  return `${e.ref} ${e.role || "element"} ${JSON.stringify(e.name)}${state.length ? ` ${state.join(" ")}` : ""} ${corners(e.box)}`;
}
