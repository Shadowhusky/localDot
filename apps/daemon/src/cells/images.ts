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

// A gate image that takes a desktop's traffic (cells/gate/gate.sh, link.sh) carries this label; an
// older one only relays, and its computers reach out through the proxy alone.
export const CAPTURE_LABEL = "localdot.capture";

export interface ImageInspect {
  Config?: { Labels?: Record<string, string> | null } | null;
}

export const gateCaptures = (image: ImageInspect | undefined) =>
  image?.Config?.Labels?.[CAPTURE_LABEL] === "1";
