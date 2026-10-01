export interface Images {
  desktop: string;
  gate: string;
}

export function imagesFromEnv(env: NodeJS.ProcessEnv = process.env): Images {
  return {
    desktop: env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev",
    gate: env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev",
  };
}
