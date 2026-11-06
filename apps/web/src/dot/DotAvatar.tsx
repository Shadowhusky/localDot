import { seedDraw, type Wearable } from "@localdot/protocol";
import { type CSSProperties, memo, useEffect, useState } from "react";
import { BODY_PLATES, platesIn, WEAR_PLATES, whenPlatesIn } from "./plates.ts";
import { wornInOrder } from "./render/wearables.ts";
import "./dot.css";

export interface DotAvatarProps {
  // CSS px of the whole frame; the ball is three quarters of it.
  size: number;
  wearables: readonly Wearable[];
  // Where it looks, by a small draw from this, so a list of them isn't all staring one way.
  seed?: string;
}

const EYE_W = 6.8;
const EYE_H = 12.5;

function Eye({ x, y }: { x: number; y: number }) {
  return (
    <rect
      className="dot-eye"
      x={x - EYE_W / 2}
      y={y - EYE_H / 2}
      width={EYE_W}
      height={EYE_H}
      rx={EYE_W / 2}
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
  const gx = (seedDraw(seed, "look-x") - 0.5) * 3;
  const gy = (seedDraw(seed, "look-y") - 0.5) * 1.6;
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
        <Eye x={26.5 + gx} y={27.5 + gy} />
        <Eye x={37.5 + gx} y={27.5 + gy} />
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
          />
        ))}
    </span>
  );
});
