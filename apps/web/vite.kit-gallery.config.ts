import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import base from "./vite.config.ts";

// The atoms page on its own until it joins the T01 gallery; never part of dist.
export default mergeConfig(base, {
  root: fileURLToPath(new URL("./src/ui/gallery", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./e2e/out/kit-gallery", import.meta.url)),
    emptyOutDir: true,
  },
});
