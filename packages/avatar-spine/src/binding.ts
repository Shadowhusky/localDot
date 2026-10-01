export interface EyeBinding {
  iris: string;
  open: string[];
  state: string;
}

// Names in the built skeleton that avatar parameters drive. Data only; lives in the theme pack.
export interface SpineRigBinding {
  headX: string;
  headY: string;
  // Rolls the head; its pivot should sit near the chin so the neck stays put.
  head?: string;
  body: string;
  eyes: { left: EyeBinding; right: EyeBinding };
  brows: { left: string; right: string };
  mouth: string;
  blush?: string;
  arms?: { slot: string; variant: string; hide: string[] };
  ranges: {
    irisX: number;
    irisY: number;
    brow: number;
    bodyDeg: number;
    breath: number;
    headRollDeg?: number;
    // Physics wind on the hair at a full breeze.
    hairWind?: number;
  };
}
