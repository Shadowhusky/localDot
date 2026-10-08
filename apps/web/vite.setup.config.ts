import { mergeConfig } from "vite";
import { workspaceAliases } from "../cli/scripts/build-options.mjs";
import base from "./vite.config.ts";

export default mergeConfig(base, { resolve: { alias: workspaceAliases() } });
