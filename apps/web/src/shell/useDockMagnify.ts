import { type RefObject, useEffect } from "react";
import { REDUCED_MOTION, useMediaQuery } from "../ui/media.ts";
import { tokenMs } from "../ui/motion.ts";
import { lens, NAME_ROWS, nameOpacity, REACH_ROWS } from "./dock-magnify.ts";

// Only a mouse magnifies the rail: a touch screen keeps its tooltips.
export const DOCK_POINTER = "(hover: hover) and (pointer: fine)";

// The house's springs are critically damped and last 1.337 times their response (tokens.css).
const SPRING_SPAN = 1.337;

function write(element: HTMLElement, property: "scale" | "translate" | "opacity", value: string) {
  if (element.style[property] !== value) element.style[property] = value;
}

// While `on`, magnifies the marks in the rail's `list` under the mouse as the Dock does
// (dock-magnify.ts), and shows their names beside the rail, fainter further from the pointer. The
// names are for the eye; each row already carries its own. It follows the pointer on every display
// frame, reading the rows' places before it moves any, and eases in and out on the snappy spring.
// While a row's menu is open the marks hold still, unnamed, as the Dock's do. Under reduced motion
// nothing grows and only the name of the mark under the pointer shows. A mark reached from the
// keyboard shows its name.
export function useDockMagnify(list: RefObject<HTMLElement | null>, on: boolean): void {
  const still = useMediaQuery(REDUCED_MOTION);
  useEffect(() => {
    const scroller = list.current;
    const rail = scroller?.parentElement;
    if (!on || !scroller || !rail) return;
    const layer = document.createElement("div");
    layer.className = "sessions-dock";
    layer.setAttribute("aria-hidden", "true");
    rail.append(layer);
    const names = new Map<string, HTMLElement>();
    const nameOf = (id: string, title: string) => {
      let name = names.get(id);
      if (!name) {
        name = document.createElement("span");
        name.className = "sessions-dock-name";
        name.dataset.dockName = id;
        layer.append(name);
        names.set(id, name);
      }
      if (name.textContent !== title) name.textContent = title;
      return name;
    };
    const omega =
      (2 * Math.PI * SPRING_SPAN * 1000) / tokenMs(getComputedStyle(layer), "--dur-snappy", 340);
    // Whether the mouse is over the list, its height on the page, and its last place in the list.
    let inside = false;
    let pointer = 0;
    let at = 0;
    let focused: string | null = null;
    let amount = 0;
    let speed = 0;
    let then = 0;
    let frame = 0;

    const step = (now: number) => {
      frame = 0;
      const rows = [...scroller.querySelectorAll<HTMLElement>(".sessions-item[data-flip]")].map(
        (element) => ({
          element,
          id: element.dataset.flip ?? "",
          title: element.querySelector(".sessions-title")?.textContent ?? "",
          left: element.offsetLeft,
          width: element.offsetWidth,
          top: element.offsetTop,
          bottom: element.offsetTop + element.offsetHeight,
        }),
      );
      const groups = [...scroller.querySelectorAll<HTMLElement>(".sessions-group-label")].map(
        (element) => ({ element, middle: element.offsetTop + element.offsetHeight / 2 }),
      );
      const menu = scroller.querySelector("[data-menu]") !== null;
      const origin = { x: scroller.offsetLeft, y: scroller.offsetTop };
      const scrolled = scroller.scrollTop;
      const height = scroller.clientHeight;
      if (inside && !menu) at = pointer - scroller.getBoundingClientRect().top + scrolled;

      const seconds = then ? Math.min(0.064, (now - then) / 1000) : 1 / 60;
      then = now;
      const target = !still && (inside || (menu && amount > 0)) ? 1 : 0;
      const from = amount - target;
      const decay = Math.exp(-omega * seconds);
      amount = target + (from + (speed + omega * from) * seconds) * decay;
      speed = (speed - omega * (speed + omega * from) * seconds) * decay;
      const settled = Math.abs(amount - target) < 1e-3 && Math.abs(speed) < 1e-2;
      if (settled) {
        amount = target;
        speed = 0;
      }
      const mark = Math.max(1, (rows[0]?.bottom ?? 0) - (rows[0]?.top ?? 0));
      const shown = lens(
        rows,
        at,
        amount,
        { top: scrolled, bottom: scrolled + height },
        REACH_ROWS * mark,
      );
      const growing = amount > 0;
      const pointing = inside && !menu;

      rows.forEach((row, n) => {
        const look = shown.spans[n] ?? { scale: 1, offset: 0 };
        write(row.element, "scale", growing ? look.scale.toFixed(4) : "");
        write(row.element, "translate", growing ? `0 ${look.offset.toFixed(2)}px` : "");
        const near = nameOpacity(row, shown.focus, NAME_ROWS * mark);
        row.element.toggleAttribute("data-under", growing && pointing && near === 1);
        const name = nameOf(row.id, row.title);
        const hovered = pointing ? Math.floor(near) : 0;
        const middle = (row.top + row.bottom) / 2 + look.offset - scrolled;
        const opacity =
          menu || middle < 0 || middle > height
            ? 0
            : Math.max(still ? hovered : amount * near, +(row.id === focused));
        write(name, "opacity", opacity.toFixed(3));
        if (opacity > 0) {
          const x = origin.x + row.left + row.width * look.scale;
          write(name, "translate", `${x.toFixed(2)}px ${(origin.y + middle).toFixed(2)}px`);
        }
      });
      const ids = new Set(rows.map((row) => row.id));
      for (const [id, name] of names)
        if (!ids.has(id)) {
          name.remove();
          names.delete(id);
        }
      for (const group of groups)
        write(
          group.element,
          "translate",
          growing ? `0 ${shown.move(group.middle).toFixed(2)}px` : "",
        );
      layer.toggleAttribute("data-magnify", growing || target > 0);
      if (!settled) frame = requestAnimationFrame(step);
      else then = 0;
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(step);
    };

    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      inside = true;
      pointer = event.clientY;
      // The list reaches past the rail before the first frame grows a mark beyond it.
      if (!still) layer.toggleAttribute("data-magnify", true);
      kick();
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      inside = false;
      kick();
    };
    const focus = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      focused = target?.matches(":focus-visible")
        ? (target.closest<HTMLElement>("[data-flip]")?.dataset.flip ?? null)
        : null;
      kick();
    };
    const blur = () => {
      focused = null;
      kick();
    };
    scroller.addEventListener("pointerenter", move);
    scroller.addEventListener("pointermove", move);
    scroller.addEventListener("pointerleave", leave);
    scroller.addEventListener("focusin", focus);
    scroller.addEventListener("focusout", blur);
    scroller.addEventListener("scroll", kick, { passive: true });
    // Rows that come, go or move, a row's menu opening or closing, and a list that changes height
    // place the marks again.
    const rows = new MutationObserver(kick);
    rows.observe(scroller, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ["data-menu"],
    });
    const size = typeof ResizeObserver === "function" ? new ResizeObserver(kick) : null;
    size?.observe(scroller);
    kick();
    return () => {
      cancelAnimationFrame(frame);
      rows.disconnect();
      size?.disconnect();
      scroller.removeEventListener("pointerenter", move);
      scroller.removeEventListener("pointermove", move);
      scroller.removeEventListener("pointerleave", leave);
      scroller.removeEventListener("focusin", focus);
      scroller.removeEventListener("focusout", blur);
      scroller.removeEventListener("scroll", kick);
      for (const element of scroller.querySelectorAll<HTMLElement>(
        ".sessions-item[data-flip], .sessions-group-label",
      )) {
        element.style.scale = "";
        element.style.translate = "";
        element.removeAttribute("data-under");
      }
      layer.remove();
    };
  }, [list, on, still]);
}
