export interface CanvasPoint {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Spine's bone inherit modes: which parts of the parents' transforms a bone takes on.
export const INHERIT_MODES = [
  "normal",
  "onlyTranslation",
  "noRotationOrReflection",
  "noScale",
  "noScaleOrReflection",
] as const;
export type Inherit = (typeof INHERIT_MODES)[number];

export interface BoneSpec {
  name: string;
  parent?: string;
  at: CanvasPoint;
  depth?: number;
  inherit?: Inherit;
}

export interface MeshSpec {
  cols: number;
  rows: number;
  bulge?: number;
}

export interface TipSpec {
  bone: string;
  from: number;
}

export interface VariantSpec {
  image: string;
  bbox: Box;
}

export interface PartSpec {
  name: string;
  bone: string;
  image: string;
  bbox: Box;
  mesh?: MeshSpec;
  tip?: TipSpec;
  variants?: Record<string, VariantSpec>;
  hidden?: boolean;
}

export interface PhysicsSpec {
  bone: string;
  rotate?: number;
  x?: number;
  inertia?: number;
  strength?: number;
  damping?: number;
  mass?: number;
  gravity?: number;
}

// Canvas coordinates are y-down pixels of the layered art; `root` becomes the skeleton origin.
export interface RigDescription {
  name: string;
  canvas: { w: number; h: number };
  root: CanvasPoint;
  images: string;
  headTurn: { x: number; y: number };
  bones: BoneSpec[];
  parts: PartSpec[];
  physics?: PhysicsSpec[];
}

export const SPINE_VERSION = "4.3.26";
export const HEAD_X = "head-x";
export const HEAD_Y = "head-y";
