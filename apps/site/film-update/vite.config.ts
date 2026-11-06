import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The update film's 3D layer and timeline, bundled for its HyperFrames composition. It draws dot with
// the site's own code. From apps/site: npx vite build --configLoader runner -c film-update/vite.config.ts
export default defineConfig({
  resolve: { alias: { "@app": fileURLToPath(new URL("../../web/src", import.meta.url)) } },
  publicDir: false,
  // Relative, so the outfits load wherever the composition is served from.
  base: "./",
  build: {
    target: "es2022",
    outDir: fileURLToPath(new URL("./assets", import.meta.url)),
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/main.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "stage.js",
    },
  },
});
