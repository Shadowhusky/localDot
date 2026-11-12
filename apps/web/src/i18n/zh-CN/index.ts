import type { Catalog } from "../index.ts";
import { agent } from "./agent.ts";
import { common } from "./common.ts";
import { library } from "./library.ts";
import { settings } from "./settings.ts";
import { shell } from "./shell.ts";
import { ui } from "./ui.ts";

// Simplified Chinese, one file per part of the app, so each part's words stay together and a
// message is in one file only (catalog.test.ts checks).
export const PARTS = { common, agent, settings, shell, ui, library } as const;
export const zhCN: Catalog = Object.assign({}, ...Object.values(PARTS));
