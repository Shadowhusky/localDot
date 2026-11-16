import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { attachToComposer } from "../../actions/actions.ts";
import { t } from "../../i18n/index.ts";
import { announce } from "../../ui/Announcer.tsx";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { isApple } from "../../ui/Kbd.tsx";
import {
  type Box,
  drawMark,
  fitBox,
  type Mark,
  markedName,
  type Point,
  type Tool,
  widthFor,
} from "./markup-draw.ts";

const TOOLS: readonly { tool: Tool; icon: "pencil" | "move-up-right" | "square"; label: string }[] =
  [
    { tool: "pen", icon: "pencil", label: t`Pen` },
    { tool: "arrow", icon: "move-up-right", label: t`Arrow` },
    { tool: "box", icon: "square", label: t`Box` },
  ];
// The tags' colours, which read on light and dark pictures alike.
const INKS = [
  { ink: "red", label: t`Red` },
  { ink: "yellow", label: t`Yellow` },
  { ink: "green", label: t`Green` },
  { ink: "blue", label: t`Blue` },
  { ink: "purple", label: t`Purple` },
] as const;
type Ink = (typeof INKS)[number]["ink"];
const colourOf = (ink: Ink) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--color-tag-${ink}`).trim();
// The longest side a marked-up copy keeps: plenty to read, and an upload of a few megabytes at most.
const MAX_SIDE = 4096;

// Marks drawn over a picture with a pen, an arrow or a box, undone and redone, then attached to the
// message as a copy of the picture with the marks on it. The picture itself never changes.
export function Markup({
  src,
  name,
  onDone,
}: {
  src: string;
  name: string;
  // Called with true once the marked copy is in the message box, false to put the marks away.
  onDone(attached: boolean): void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [ink, setInk] = useState<Ink>("red");
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  const [undone, setUndone] = useState<readonly Mark[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const drawing = useRef<{ id: number; mark: Mark } | null>(null);

  // Where the picture sits in the stage, shown whole.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !natural) return;
    const measure = () =>
      setBox(fitBox(natural, { w: stage.clientWidth, h: stage.clientHeight }, 16));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [natural]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !box || !natural) return;
    const ratio = window.devicePixelRatio || 1;
    const w = Math.round(box.w * ratio);
    const h = Math.round(box.h * ratio);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, w, h);
    const scale = (box.w * ratio) / natural.w;
    const live = drawing.current?.mark;
    for (const mark of live ? [...marks, live] : marks) drawMark(context, mark, scale);
  }, [box, natural, marks]);
  useLayoutEffect(paint, [paint]);

  // A pointer's place on the picture, in the picture's own pixels.
  const at = (event: { clientX: number; clientY: number }): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas || !natural) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * natural.w,
      y: ((event.clientY - rect.top) / rect.height) * natural.h,
    };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.stopPropagation();
    if (drawing.current || !natural || (event.pointerType === "mouse" && event.button !== 0))
      return;
    const point = at(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = {
      id: event.pointerId,
      mark: { tool, colour: colourOf(ink), width: widthFor(natural), points: [point] },
    };
    setProblem(null);
    paint();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.stopPropagation();
    const now = drawing.current;
    if (!now || now.id !== event.pointerId) return;
    // Every point the pointer passed since the last frame, so a quick line stays smooth.
    const passed = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    const points = passed.flatMap((each) => at(each) ?? []);
    if (!points.length) return;
    const { mark } = now;
    now.mark =
      mark.tool === "pen"
        ? { ...mark, points: [...mark.points, ...points] }
        : { ...mark, points: [mark.points[0] ?? points[0] ?? { x: 0, y: 0 }, ...points.slice(-1)] };
    paint();
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.stopPropagation();
    const now = drawing.current;
    if (!now || now.id !== event.pointerId) return;
    drawing.current = null;
    const [first, last] = [now.mark.points[0], now.mark.points.at(-1)];
    // A tap draws a dot with the pen; an arrow or a box needs some length to it.
    const long = first && last && Math.hypot(last.x - first.x, last.y - first.y) >= now.mark.width;
    if (event.type !== "pointercancel" && (now.mark.tool === "pen" || long)) {
      setMarks((was) => [...was, now.mark]);
      setUndone([]);
    } else paint();
  };

  const undo = useCallback(() => {
    const last = marks.at(-1);
    if (!last) return;
    setMarks(marks.slice(0, -1));
    setUndone((was) => [...was, last]);
  }, [marks]);
  const redo = useCallback(() => {
    const next = undone.at(-1);
    if (!next) return;
    setUndone(undone.slice(0, -1));
    setMarks((was) => [...was, next]);
  }, [undone]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!(isApple() ? event.metaKey : event.ctrlKey) || (key !== "z" && key !== "y")) return;
      event.preventDefault();
      if (key === "y" || event.shiftKey) redo();
      else undo();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const attach = async () => {
    const image = imageRef.current;
    if (!image || !natural) return;
    const fit = Math.min(1, MAX_SIDE / Math.max(natural.w, natural.h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(natural.w * fit));
    canvas.height = Math.max(1, Math.round(natural.h * fit));
    const context = canvas.getContext("2d");
    if (!context) return setProblem(t`This picture can't be marked up here.`);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const mark of marks) drawMark(context, mark, fit);
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob(resolve, "image/png");
      } catch {
        resolve(null);
      }
    });
    if (!blob) return setProblem(t`This picture can't be marked up here.`);
    const why = attachToComposer([new File([blob], markedName(name), { type: "image/png" })]);
    if (why) return setProblem(why);
    announce("composer", t`The marked-up picture is attached to your message.`);
    onDone(true);
  };

  return (
    <>
      <div className="viewer-bar markup-bar">
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggles, not a form's fieldset. */}
        <div className="markup-group" role="group" aria-label={t`Draw with`}>
          {TOOLS.map((each) => (
            <IconButton
              key={each.tool}
              icon={each.icon}
              size={32}
              label={each.label}
              aria-pressed={tool === each.tool}
              onClick={() => setTool(each.tool)}
            />
          ))}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: as above. */}
        <div className="markup-group markup-inks" role="group" aria-label={t`Colour`}>
          {INKS.map((each) => (
            <Button
              key={each.ink}
              variant="quiet"
              className="markup-ink"
              data-ink={each.ink}
              aria-label={each.label}
              aria-pressed={ink === each.ink}
              onClick={() => setInk(each.ink)}
            >
              <span className="markup-ink-swatch" aria-hidden="true" />
            </Button>
          ))}
        </div>
      </div>
      <div ref={stageRef} className="viewer-stage markup-stage">
        {failed ? (
          <p className="markup-note">{t`Couldn't show this picture`}</p>
        ) : (
          <>
            <img
              ref={imageRef}
              src={src}
              alt={name}
              draggable={false}
              className="markup-picture"
              style={box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
              data-ready={box ? "" : undefined}
              onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth > 0)
                  setNatural({ w: image.naturalWidth, h: image.naturalHeight });
                else setFailed(true);
              }}
              onError={() => setFailed(true)}
            />
            <canvas
              ref={canvasRef}
              className="markup-canvas"
              aria-label={t`Drawing over ${name}`}
              style={box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onLostPointerCapture={onPointerEnd}
            />
          </>
        )}
      </div>
      <div className="markup-foot">
        {problem && (
          <p className="markup-problem" role="alert">
            {problem}
          </p>
        )}
        <IconButton
          icon="undo-2"
          size={32}
          label={t`Undo`}
          disabledReason={marks.length ? undefined : t`Nothing to undo`}
          onClick={undo}
        />
        <IconButton
          icon="redo-2"
          size={32}
          label={t`Redo`}
          disabledReason={undone.length ? undefined : t`Nothing to redo`}
          onClick={redo}
        />
        <span className="markup-foot-gap" />
        <Button variant="quiet" onClick={() => onDone(false)}>
          {t`Cancel`}
        </Button>
        <Button
          variant="primary"
          icon="paperclip"
          disabledReason={
            failed
              ? t`Couldn't show this picture`
              : !natural
                ? t`Loading picture`
                : marks.length
                  ? undefined
                  : t`Draw on the picture first`
          }
          onClick={() => void attach()}
        >
          {t`Add to message`}
        </Button>
      </div>
    </>
  );
}
