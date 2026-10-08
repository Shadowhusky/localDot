export interface Images {
  desktop: string;
  gate: string;
}

export interface BrowserImages {
  browser: string;
  gate: string;
}

export function browserImagesFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserImages {
  return {
    browser: env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev",
    gate: env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev",
  };
}

export function imagesFromEnv(env: NodeJS.ProcessEnv = process.env): Images {
  return {
    desktop: env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev",
    gate: env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev",
  };
}
