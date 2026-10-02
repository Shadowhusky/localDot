import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Lightning CSS compiles @custom-media, so a breakpoint is named once like any other token.
  css: { transformer: "lightningcss", lightningcss: { drafts: { customMedia: true } } },
  build: { outDir: "dist", target: "es2024", sourcemap: true },
  worker: { format: "es" },
});
