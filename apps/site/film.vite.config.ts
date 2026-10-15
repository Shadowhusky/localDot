import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The film's 3D layer and timeline, bundled for its HyperFrames composition (film/index.html). It
// draws dot with the site's own code.
export default defineConfig({
  resolve: { alias: { "@app": fileURLToPath(new URL("../web/src", import.meta.url)) } },
  publicDir: false,
  // Relative, so the outfits load wherever the composition is served from.
  base: "./",
  build: {
    target: "es2022",
    outDir: "film/assets",
    emptyOutDir: false,
    lib: { entry: "src/film/main.ts", formats: ["es"], fileName: () => "stage.js" },
  },
});
