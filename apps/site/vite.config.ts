import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { legacyLayer } from "../web/vite.config.ts";
import { PROVIDER_COUNT, ringHtml, rolesHtml } from "./src/story/content.ts";

const APP = fileURLToPath(new URL("../web/src", import.meta.url));

// The site shows the app's own components, so it builds them the way the app does.
export default defineConfig({
  plugins: [
    legacyLayer(),
    tailwindcss(),
    react(),
    {
      // The story's words that come from the app: its dots, and the models it can use.
      name: "localdot:story",
      transformIndexHtml: (html) =>
        html
          .replace("<!-- roles -->", rolesHtml())
          .replace("<!-- ring -->", ringHtml())
          .replace("<!-- provider-count -->", String(PROVIDER_COUNT)),
    },
  ],
  resolve: {
    alias: { "@app": APP },
    dedupe: ["react", "react-dom"],
  },
  css: { transformer: "lightningcss", lightningcss: { drafts: { customMedia: true } } },
  build: {
    target: "es2022",
    rolldownOptions: {
      input: { index: "index.html" },
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three";
        },
      },
    },
  },
  server: { fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
