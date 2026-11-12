// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { count } from "../copy/format.ts";
import { deviceLocale, plural, rich, setLocale, t, tr } from "./index.ts";

afterEach(() => setLocale("en"));

describe("the app's words", () => {
  it("are the English as written until a language is chosen", () => {
    const files = 3;
    expect(t`Saved ${files} files`).toBe("Saved 3 files");
    expect(tr("Done")).toBe("Done");
    expect(count(1, "step", "steps")).toBe("1 step");
    expect(count(2, "step", "steps")).toBe("2 steps");
  });

  it("come from the catalog of the language chosen, values in their places", () => {
    setLocale("zh-CN", {
      "Saved {0} files to {1}": "已将 {0} 个文件保存到 {1}",
      Done: "完成",
      "step|steps": "# 个步骤",
      "Open {0} to unlock": "打开{0}以解锁",
    });
    const [files, place] = [3, "Downloads"];
    expect(t`Saved ${files} files to ${place}`).toBe("已将 3 个文件保存到 Downloads");
    expect(tr("Done")).toBe("完成");
    expect(plural(1, "step", "steps")).toBe("1 个步骤");
    expect(count(12, "step", "steps")).toBe("12 个步骤");
    // What the catalog doesn't have stays in English.
    expect(t`Not translated`).toBe("Not translated");
    render(<p>{rich`Open ${<b>Keys</b>} to unlock`}</p>);
    expect(screen.getByText("Keys").tagName).toBe("B");
    expect(document.querySelector("p")?.textContent).toBe("打开Keys以解锁");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("follow the device's own language when it has one the app knows", () => {
    expect(deviceLocale(["zh-CN", "en"])).toBe("zh-CN");
    expect(deviceLocale(["zh-Hant-TW"])).toBe("zh-CN");
    expect(deviceLocale(["fr-FR", "en-GB"])).toBe("en");
    expect(deviceLocale(["de"])).toBe("en");
  });
});
