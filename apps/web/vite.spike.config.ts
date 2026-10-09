import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import base from "./vite.config.ts";

// The kit spike gallery: its own entry and output, never part of dist.
export default mergeConfig(base, {
  root: fileURLToPath(new URL("./src/ui/_spike", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./e2e/out/spike", import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: {
      input: fileURLToPath(new URL("./src/ui/_spike/index.html", import.meta.url)),
    },
  },
});
