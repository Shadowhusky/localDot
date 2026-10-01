import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", target: "es2024", sourcemap: true },
  worker: { format: "es" },
});
