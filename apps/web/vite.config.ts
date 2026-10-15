import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const SRC = fileURLToPath(new URL("./src/", import.meta.url));
const KIT = `${SRC}ui/`;
const LAYERS = "@layer theme, base, components, kit, utilities;";
const CUSTOM_MEDIA = /^@custom-media [^;]+;$/gm;

// Stylesheets written before the Tailwind stack join its components layer, so the kit's utilities
// win over them and the reset stays beneath them. Each restates the layer order, so the order holds
// whichever stylesheet the bundle meets first. @custom-media has to stay at the top level.
// The website (apps/site) shows the app's components, so it builds them with this too.
export function legacyLayer(): Plugin {
  return {
    name: "localdot:legacy-layer",
    enforce: "pre",
    transform: {
      filter: { id: /\.css$/ },
      handler(code, id) {
        if (!id.startsWith(SRC) || id.startsWith(KIT)) return null;
        const media = code.match(CUSTOM_MEDIA) ?? [];
        const rules = code.replace(CUSTOM_MEDIA, "");
        return {
          code: `${LAYERS}\n${media.join("\n")}\n@layer components {\n${rules}\n}\n`,
          map: null,
        };
      },
    },
  };
}

export default defineConfig({
  plugins: [legacyLayer(), tailwindcss(), react()],
  resolve: { tsconfigPaths: true },
  // Lightning CSS compiles @custom-media, so a breakpoint is named once like any other token.
  css: { transformer: "lightningcss", lightningcss: { drafts: { customMedia: true } } },
  build: {
    outDir: "dist",
    target: "es2024",
    sourcemap: true,
    // export.html is the daemon's own page: its headless browser makes videos there.
    rolldownOptions: { input: { index: "index.html", export: "export.html" } },
  },
  worker: { format: "es" },
});
