import dim48 from "./plates/body-dim-48.webp?no-inline";
import dim96 from "./plates/body-dim-96.webp?no-inline";
import dim192 from "./plates/body-dim-192.webp?no-inline";
import dim448 from "./plates/body-dim-448.webp?no-inline";
import neutral48 from "./plates/body-neutral-48.webp?no-inline";
import neutral96 from "./plates/body-neutral-96.webp?no-inline";
import neutral192 from "./plates/body-neutral-192.webp?no-inline";
import neutral448 from "./plates/body-neutral-448.webp?no-inline";
import xenon48 from "./plates/body-xenon-48.webp?no-inline";
import xenon96 from "./plates/body-xenon-96.webp?no-inline";
import xenon192 from "./plates/body-xenon-192.webp?no-inline";
import xenon448 from "./plates/body-xenon-448.webp?no-inline";
import shadow96 from "./plates/shadow-96.webp?no-inline";
import shadow192 from "./plates/shadow-192.webp?no-inline";

// Blender renders of the body (tools/dot-plates). Each plate covers the whole 64-unit frame, so an
// N px plate is an N px dot, and the browser picks a size by the dot's CSS size and pixel ratio.
export type BodyPlate = "neutral" | "xenon" | "dim";

const srcset = (sizes: [number, string][]) => sizes.map(([w, url]) => `${url} ${w}w`).join(", ");

export const BODY_PLATES: Record<BodyPlate, string> = {
  neutral: srcset([
    [48, neutral48],
    [96, neutral96],
    [192, neutral192],
    [448, neutral448],
  ]),
  xenon: srcset([
    [48, xenon48],
    [96, xenon96],
    [192, xenon192],
    [448, xenon448],
  ]),
  dim: srcset([
    [48, dim48],
    [96, dim96],
    [192, dim192],
    [448, dim448],
  ]),
};

// The contact shadow is soft, so two sizes cover every view that shows it.
export const SHADOW_PLATE = srcset([
  [96, shadow96],
  [192, shadow192],
]);
