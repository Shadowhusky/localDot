import { Wearable } from "@localdot/protocol";
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

type Sizes = readonly (readonly [width: number, url: string])[];

export const PLATE_FILES: Record<BodyPlate, Sizes> = {
  neutral: [
    [48, neutral48],
    [96, neutral96],
    [192, neutral192],
    [448, neutral448],
  ],
  xenon: [
    [48, xenon48],
    [96, xenon96],
    [192, xenon192],
    [448, xenon448],
  ],
  dim: [
    [48, dim48],
    [96, dim96],
    [192, dim192],
    [448, dim448],
  ],
};

// The contact shadow is soft, so two sizes cover every view that shows it.
export const SHADOW_FILES: Sizes = [
  [96, shadow96],
  [192, shadow192],
];

const srcset = (sizes: Sizes) => sizes.map(([w, url]) => `${url} ${w}w`).join(", ");

export const BODY_PLATES: Record<BodyPlate, string> = {
  neutral: srcset(PLATE_FILES.neutral),
  xenon: srcset(PLATE_FILES.xenon),
  dim: srcset(PLATE_FILES.dim),
};

export const SHADOW_PLATE = srcset(SHADOW_FILES);

const WEAR_FILES = import.meta.glob<string>("./plates/wear-*.webp", {
  eager: true,
  query: "?no-inline",
  import: "default",
});

// What dot wears, rendered over the same body at the body's sizes (build_wearables.py).
export const WEAR_PLATES = Object.fromEntries(
  Wearable.options.map((name) => [
    name,
    srcset(
      [48, 96, 192, 448].flatMap((px) => {
        const url = WEAR_FILES[`./plates/wear-${name}-${px}.webp`];
        return url ? [[px, url] as const] : [];
      }),
    ),
  ]),
) as Record<Wearable, string>;

// The file a canvas draws a dot of this many pixels from: the smallest at least that wide.
export function plateFile(sizes: Sizes, px: number): string {
  return (sizes.find(([width]) => width >= px) ?? sizes.at(-1))?.[1] ?? "";
}

// A slow plate shouldn't keep dot off the page for good.
const PLATE_WAIT_MS = 3000;
const decoded = new Set<string>();

const plateKey = (plate: string, px: number) => `${px} ${plate}`;
const canDecode = () =>
  typeof HTMLImageElement === "function" && !!HTMLImageElement.prototype.decode;

// Whether all these plates have been decoded at this size, so they draw in the frame they go on the
// page.
export const platesDecoded = (plates: readonly string[], px: number) =>
  canDecode() && plates.every((plate) => decoded.has(plateKey(plate, px)));

// Whether what shows these plates at this size needn't wait for them.
export const platesIn = (plates: readonly string[], px: number) =>
  !canDecode() || platesDecoded(plates, px);

// A new size makes an image start again, which cancels its decode: then it is drawn when it loads.
function drawable(img: HTMLImageElement): Promise<boolean> {
  return img.decode().then(
    () => true,
    () =>
      img.complete
        ? img.naturalWidth > 0
        : new Promise((done) => {
            img.addEventListener("load", () => done(true), { once: true });
            img.addEventListener("error", () => done(false), { once: true });
          }),
  );
}

// Waits until these images, showing a set of plates at this size, can all be drawn, so what they make
// up shows whole and not piece by piece; at once if they can already. One that fails is left to show
// that itself.
export function whenImagesIn(
  images: readonly HTMLImageElement[],
  px: number,
  then: () => void,
): void {
  if (
    platesIn(
      images.map((img) => img.srcset),
      px,
    )
  ) {
    then();
    return;
  }
  void Promise.race([
    Promise.all(
      images.map((img) =>
        drawable(img).then((can) => {
          if (can) decoded.add(plateKey(img.srcset, px));
        }),
      ),
    ),
    new Promise((give) => setTimeout(give, PLATE_WAIT_MS)),
  ]).then(then);
}

// The same for plates not on the page yet.
export function whenPlatesIn(plates: readonly string[], px: number, then: () => void): void {
  whenImagesIn(
    plates.map((plate) => {
      const img = new Image();
      img.sizes = `${px}px`;
      img.srcset = plate;
      return img;
    }),
    px,
    then,
  );
}
