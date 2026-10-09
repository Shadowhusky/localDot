import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotFeed } from "../dot/dot-feed.ts";
import { DotEngine } from "../dot/engine/engine.ts";
import { LINE_HOLD_MS, LINE_OUT_MS } from "../shell/narration.ts";
import type { StageTheme } from "../stage/theme.ts";

const drawn = vi.hoisted(() => ({
  bubbles: [] as { x: number; y: number; w: number; h: number }[],
  uploads: 0,
}));
vi.mock("pixi.js", () => {
  class Container {
    alpha = 1;
    visible = true;
    children: unknown[] = [];
    position = {
      x: 0,
      y: 0,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
      copyFrom() {},
    };
    scale = { set() {}, copyFrom() {} };
    addChild(...children: unknown[]) {
      this.children.push(...children);
    }
  }
  class Graphics extends Container {
    clear() {
      return this;
    }
    rect() {
      return this;
    }
    circle() {
      return this;
    }
    roundRect(x: number, y: number, w: number, h: number) {
      drawn.bubbles.push({ x, y, w, h });
      return this;
    }
    fill() {
      return this;
    }
    stroke() {
      return this;
    }
  }
  class Sprite extends Container {}
  class Text extends Container {
    text = "";
    get width() {
      return this.text.length * 10;
    }
    get height() {
      return 22;
    }
  }
  class Texture {
    source: { update(): void };
    constructor({ source }: { source: { update(): void } }) {
      this.source = source;
    }
  }
  class CanvasSource {
    update() {
      drawn.uploads++;
    }
  }
  return {
    CanvasSource,
    CanvasTextMetrics: { measureText: () => ({ lines: ["one"] }) },
    Container,
    Graphics,
    Sprite,
    Text,
    TextStyle: class {},
    Texture,
  };
});

const { ExportDot } = await import("./export-dot.ts");

// A 2D context that takes every call and remembers nothing.
function context(): unknown {
  const gradient = { addColorStop() {} };
  return new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "createRadialGradient" || key === "createLinearGradient"
          ? () => gradient
          : () => {},
      set: () => true,
    },
  );
}

const color = (value: number) => ({ color: value, alpha: 1 });
const theme = {
  font: "system-ui",
  xenon: color(0x3fb5de),
  attention: color(0xe9b44c),
  hudSolid: color(0x0e0f12),
  text: color(0xeeeff1),
  void: color(0x0a0b0d),
} as StageTheme;

const feed = (patch: Partial<DotFeed> = {}): DotFeed => ({
  state: "thinking",
  control: true,
  attention: false,
  focus: null,
  dispatched: null,
  done: false,
  ...patch,
});

function make(placement: "under" | "over" = "under", line = "Opening the report.") {
  return new ExportDot({
    theme,
    size: placement === "under" ? { w: 1024, h: 752 } : { w: 1024, h: 640 },
    placement,
    plates: null,
    seed: 7,
    t: 0,
    first: { feed: feed(), line },
  });
}

beforeEach(() => {
  drawn.bubbles.length = 0;
  drawn.uploads = 0;
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return context();
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dot in an exported video", () => {
  it("follows the recording's states and control on the video's clock, drawing every frame", () => {
    const setState = vi.spyOn(DotEngine.prototype, "setState");
    const setControl = vi.spyOn(DotEngine.prototype, "setControl");
    const dot = make();
    dot.update(0, { feed: feed(), line: "Opening the report." });
    dot.update(33, { feed: feed({ state: "acting" }), line: "Opening the report." });
    dot.update(67, {
      feed: feed({ state: "acting", control: false }),
      line: "Opening the report.",
    });
    expect(setState.mock.calls).toEqual([["acting", 33]]);
    expect(setControl.mock.calls).toEqual([[false, 67]]);
    expect(drawn.uploads).toBe(3);
  });

  it("looks toward the action point on the picture, up and to the right of its dock", () => {
    const setFocus = vi.spyOn(DotEngine.prototype, "setFocus");
    const dot = make();
    dot.update(0, { feed: feed({ focus: { x: 0.8, y: 0.2 } }), line: "" });
    dot.update(16, { feed: feed({ focus: { x: 0.8, y: 0.2 } }), line: "" });
    const looks = setFocus.mock.calls.filter(([point]) => point !== null);
    expect(looks).toHaveLength(1);
    const [point] = looks[0] ?? [];
    expect(point?.x).toBeGreaterThan(0);
    expect(point?.y).toBeLessThan(0);
  });

  it("nods once for each action sent, celebrates a finish once, and talks with each new line", () => {
    const react = vi.spyOn(DotEngine.prototype, "react");
    const say = vi.spyOn(DotEngine.prototype, "say");
    const dot = make();
    expect(say).toHaveBeenCalledTimes(1);
    const sent = feed({ state: "acting", dispatched: "a1" });
    dot.update(10, { feed: sent, line: "Opening the report." });
    dot.update(20, { feed: sent, line: "Opening the report." });
    dot.update(30, { feed: feed({ done: true }), line: "Done." });
    dot.update(40, { feed: feed({ done: true }), line: "Done." });
    expect(react.mock.calls.map(([name]) => name)).toEqual(["dispatch", "success"]);
    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[1]?.[0]).toBe(30);
  });

  it("shows each line as the band does, and puts it on glass only on the picture", () => {
    const dot = make("over", "Opening the report.");
    dot.update(0, { feed: feed(), line: "Opening the report." });
    expect(drawn.bubbles).toHaveLength(1);
    const words = dot.children.at(-1) as unknown as { alpha: number; children: { text: string }[] };
    expect(words.children[1]?.text).toBe("Opening the report.");
    dot.update(500, { feed: feed(), line: "Saving it." });
    expect(words.children[1]?.text).toBe("Opening the report.");
    dot.update(LINE_HOLD_MS + LINE_OUT_MS, { feed: feed(), line: "Saving it." });
    expect(words.children[1]?.text).toBe("Saving it.");
    expect(words.alpha).toBe(0);
    expect(drawn.bubbles).toHaveLength(2);
    drawn.bubbles.length = 0;
    const under = make("under");
    under.update(0, { feed: feed(), line: "Opening the report." });
    expect(drawn.bubbles).toEqual([]);
  });
});
