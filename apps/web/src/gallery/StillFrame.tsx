import { useEffect, useRef, useState } from "react";
import still from "../../e2e/fixtures/ui-assets/frame-1.webp";

// Stands in for StageCanvas in the gallery: the stage canvas holding one recorded desktop frame,
// drawn at the canvas's device size as the stage renderer draws it, so the stage around it renders
// the same every time.
export function StillFrame() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const image = new Image();
    image.src = still;
    const observer = new ResizeObserver(() => {
      const context = target.getContext("2d");
      if (!context) return;
      target.width = Math.round(target.clientWidth * devicePixelRatio);
      target.height = Math.round(target.clientHeight * devicePixelRatio);
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, target.width, target.height);
      setDrawn(true);
    });
    image.decode().then(
      () => observer.observe(target),
      () => {},
    );
    return () => observer.disconnect();
  }, []);
  return (
    <canvas
      ref={canvas}
      className="stage-canvas"
      aria-label="The virtual computer"
      data-still={drawn ? "drawn" : "loading"}
    />
  );
}
