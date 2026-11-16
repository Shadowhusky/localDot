export type Tool = "pen" | "arrow" | "box";
export interface Point {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
// One mark, in the picture's own pixels: a pen's path, or an arrow's or a box's two corners.
export interface Mark {
  tool: Tool;
  colour: string;
  width: number;
  points: readonly Point[];
}

// The picture shown whole in the room, a margin all round, never larger than its own size.
export function fitBox(
  picture: { w: number; h: number },
  room: { w: number; h: number },
  margin = 0,
) {
  const scale = Math.min(
    1,
    Math.max(0, room.w - margin * 2) / picture.w,
    Math.max(0, room.h - margin * 2) / picture.h,
  );
  const w = Math.round(picture.w * scale);
  const h = Math.round(picture.h * scale);
  return { x: Math.round((room.w - w) / 2), y: Math.round((room.h - h) / 2), w, h };
}

// A line that reads at any size the picture is shown: thicker on a bigger picture.
export const widthFor = (picture: { w: number; h: number }) =>
  Math.max(3, Math.round(Math.hypot(picture.w, picture.h) * 0.004));

// The copy's name: the picture's own, said to be marked up, as a PNG.
export function markedName(name: string): string {
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim() || "picture";
  return `${stem} marked up.png`;
}

// Draws one mark at `scale` canvas pixels for each of the picture's.
export function drawMark(context: CanvasRenderingContext2D, mark: Mark, scale: number): void {
  const points = mark.points.map((point) => ({ x: point.x * scale, y: point.y * scale }));
  const [first] = points;
  const last = points.at(-1);
  if (!first || !last) return;
  const width = mark.width * scale;
  context.save();
  context.strokeStyle = mark.colour;
  context.fillStyle = mark.colour;
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (mark.tool === "pen") {
    if (points.length === 1) {
      context.arc(first.x, first.y, width / 2, 0, Math.PI * 2);
      context.fill();
      context.restore();
      return;
    }
    // Through the midpoints of each pair, curving at the points themselves, so it reads as a stroke.
    context.moveTo(first.x, first.y);
    for (let at = 1; at < points.length - 1; at++) {
      const point = points[at];
      const next = points[at + 1];
      if (!point || !next) continue;
      context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    }
    context.lineTo(last.x, last.y);
    context.stroke();
  } else if (mark.tool === "box") {
    const x = Math.min(first.x, last.x);
    const y = Math.min(first.y, last.y);
    const w = Math.abs(last.x - first.x);
    const h = Math.abs(last.y - first.y);
    const radius = Math.min(width, w / 2, h / 2);
    context.roundRect(x, y, w, h, radius);
    context.stroke();
  } else {
    // The head's two barbs, each a few lines long, at 28° either side of the shaft.
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const length = Math.min(width * 4 + 6 * scale, Math.hypot(last.x - first.x, last.y - first.y));
    context.moveTo(first.x, first.y);
    context.lineTo(last.x, last.y);
    for (const side of [-1, 1]) {
      const turn = angle + Math.PI - (side * (28 * Math.PI)) / 180;
      context.moveTo(last.x, last.y);
      context.lineTo(last.x + Math.cos(turn) * length, last.y + Math.sin(turn) * length);
    }
    context.stroke();
  }
  context.restore();
}
