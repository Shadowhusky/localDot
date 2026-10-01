import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const toyPack = fileURLToPath(
  new URL("../../packages/avatar-spine/fixtures/toy/pack", import.meta.url),
);
const devPack = process.env.LOCALDOT_AVATAR_PACK ?? "";

export default defineConfig({
  define: { __TOY_PACK__: JSON.stringify(toyPack), __DEV_PACK__: JSON.stringify(devPack) },
  server: {
    host: "127.0.0.1",
    port: 4753,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...(devPack ? [devPack] : [])] },
  },
});
