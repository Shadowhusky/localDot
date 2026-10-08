import { mergeConfig } from "vite";
import base from "./vite.config.ts";

// A separate entry and build: the UI fixture serves it under /gallery/, and none of it reaches dist.
export default mergeConfig(base, {
  base: "/gallery/",
  build: { outDir: "dist-gallery", rolldownOptions: { input: "gallery.html" } },
});
