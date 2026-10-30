import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin, type Rolldown } from "vite";

const SRC = fileURLToPath(new URL("./src/", import.meta.url));
const KIT = `${SRC}ui/`;
const LAYERS = "@layer theme, base, components, kit, utilities;";
const CUSTOM_MEDIA = /^@custom-media [^;]+;$/gm;
const APPEARANCE = `${SRC}onboarding/appearance.ts`;
const APPEARANCE_BOOT = `${SRC}onboarding/appearance-boot.ts`;

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

// The appearance is set by a script in the page's head, ahead of the stylesheets and the app, so no
// frame is drawn in another one: a module runs only after the page is parsed, and the page's policy
// refuses inline script. The export page is the daemon's own and takes none.
export function appearanceBoot(): Plugin {
  let base = "/";
  let script: { fileName: string; code: string } | undefined;
  return {
    name: "localdot:appearance-boot",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    async buildStart() {
      this.addWatchFile(APPEARANCE);
      this.addWatchFile(APPEARANCE_BOOT);
      const built = (await build({
        configFile: false,
        logLevel: "warn",
        publicDir: false,
        build: {
          write: false,
          target: "es2024",
          rolldownOptions: { input: APPEARANCE_BOOT, output: { format: "iife" } },
        },
      })) as Rolldown.RolldownOutput;
      const code = built.output[0].code;
      const hash = createHash("sha256").update(code).digest("hex").slice(0, 8);
      script = { fileName: `assets/appearance-${hash}.js`, code };
    },
    generateBundle() {
      if (script) this.emitFile({ type: "asset", fileName: script.fileName, source: script.code });
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!script || context.filename.endsWith("export.html")) return html;
        const tag = `<script src="${base}${script.fileName}"></script>\n    `;
        return html.replace(/<script type="module"|<link rel="stylesheet"/, (first) => tag + first);
      },
    },
  };
}

export default defineConfig({
  plugins: [legacyLayer(), appearanceBoot(), tailwindcss(), react()],
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
