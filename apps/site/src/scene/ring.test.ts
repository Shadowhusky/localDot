import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { Ring } from "./ring.ts";

describe("Ring", () => {
  it("shows its names again after being hidden, even at the very same place", () => {
    const list = document.createElement("ul");
    list.innerHTML = "<li>Anthropic</li><li>OpenAI</li><li>Ollama</li>";
    const ring = new Ring(list);
    const camera = new PerspectiveCamera(30, 1, 0.05, 200);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const toStage = (p: Vector3) => [p.x * 100, -p.y * 100] as const;
    const show = (visible: number) =>
      ring.update(visible, 0.4, new Vector3(), 1, camera, toStage, false);
    show(1);
    show(0);
    show(1);
    for (const item of list.querySelectorAll("li")) expect(item.style.visibility).toBe("visible");
  });
});
