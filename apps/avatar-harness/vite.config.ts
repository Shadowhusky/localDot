import { fileURLToPath } from "node:url";
import { voiceDevPlugin } from "@localdot/voice/host";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const toyPack = fileURLToPath(
  new URL("../../packages/avatar-spine/fixtures/toy/pack", import.meta.url),
);
const devPack = process.env.LOCALDOT_AVATAR_PACK ?? "";
const voicedDir = fileURLToPath(new URL("../voiced", import.meta.url));

export default defineConfig({
  define: { __TOY_PACK__: JSON.stringify(toyPack), __DEV_PACK__: JSON.stringify(devPack) },
  plugins: [voiceDevPlugin({ port: 4753, voicedDir })],
  server: {
    host: "127.0.0.1",
    port: 4753,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...(devPack ? [devPack] : [])] },
  },
});
