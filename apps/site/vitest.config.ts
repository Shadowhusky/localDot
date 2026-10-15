import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests import the app's code like the site does; they need none of the page's build plugins.
export default defineConfig({
  resolve: {
    alias: { "@app": fileURLToPath(new URL("../web/src", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
