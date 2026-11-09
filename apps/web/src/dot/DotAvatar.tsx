import { seedDraw, type Wearable } from "@localdot/protocol";
import { type CSSProperties, memo, useEffect, useState } from "react";
import { EYE_ANCHORS, eyeFrame } from "./engine/sphere.ts";
import { BODY_PLATES, platesIn, WEAR_PLATES, whenPlatesIn } from "./plates.ts";
import { EYE_H, EYE_W } from "./render/eye-geometry.ts";
import { LOD_DETAIL, lodFor } from "./render/lod.ts";
import { eyeScaleLimit, plateOrigin, plateTransform, wornInOrder } from "./render/wearables.ts";
import "./dot.css";

export interface DotAvatarProps {
  // CSS px of the whole frame; the ball is three quarters of it.
  size: number;
  wearables: readonly Wearable[];
  // Where it looks, by a small draw from this, so a list of them isn't all staring one way.
  seed?: string;
}

function Eye({ x, y, scale }: { x: number; y: number; scale: number }) {
  const width = EYE_W * scale;
  const height = EYE_H * scale;
  return (
    <rect
      className="dot-eye"
      x={32 + x - width / 2}
      y={32 + y - height / 2}
      width={width}
      height={height}
      rx={width / 2}
    />
  );
}

const platesOf = (wearables: readonly Wearable[]) => [
  BODY_PLATES.neutral,
  ...wearables.map((name) => WEAR_PLATES[name]),
];

// The look to draw: this one once all its plates are in, until then the last that was, or none.
function useLoadedLook(wearables: readonly Wearable[], size: number) {
  const [loaded, setLoaded] = useState<readonly Wearable[] | null>(null);
  const words = wearables.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the outfit's words say when it changed.
  useEffect(() => {
    let current = true;
    whenPlatesIn(platesOf(wearables), size, () => {
      if (current) setLoaded(wearables);
    });
    return () => {
      current = false;
    };
  }, [words, size]);
  return platesIn(platesOf(wearables), size) ? wearables : loaded;
}

// dot as a small still picture: its body, its face and what it wears, with no engine, timer or
// canvas behind it, so a long list costs a few elements a row and each plate is fetched once.
export const DotAvatar = memo(function DotAvatar({ size, wearables, seed = "" }: DotAvatarProps) {
  const look = useLoadedLook(wearables, size);
  const gaze = {
    x: (seedDraw(seed, "look-x") - 0.5) * 3,
    y: (seedDraw(seed, "look-y") - 0.5) * 1.6,
  };
  const scale = Math.min(LOD_DETAIL[lodFor(size)].eyeScale, eyeScaleLimit(look ?? []));
  const px = `${size}px`;
  return (
    <span
      className="dot-avatar"
      aria-hidden="true"
      data-loading={look ? undefined : ""}
      style={{ "--dot-size": px } as CSSProperties}
    >
      {look && (
        <img
          className="dot-plate"
          alt=""
          decoding="sync"
          draggable={false}
          sizes={px}
          srcSet={BODY_PLATES.neutral}
        />
      )}
      <svg className="dot-face" viewBox="0 0 64 64" aria-hidden="true">
        {EYE_ANCHORS.map((anchor) => {
          const { cx, cy } = eyeFrame(anchor, gaze.x, gaze.y, 0);
          return <Eye key={anchor[0]} x={cx} y={cy} scale={scale} />;
        })}
      </svg>
      {look &&
        wornInOrder(look).map((name) => (
          <img
            key={name}
            className="dot-wear"
            alt=""
            decoding="sync"
            draggable={false}
            data-wear={name}
            sizes={px}
            srcSet={WEAR_PLATES[name]}
            style={{
              transformOrigin: plateOrigin(name),
              transform: plateTransform(name, { gaze, roll: 0 }, size / 64),
            }}
          />
        ))}
    </span>
  );
});
