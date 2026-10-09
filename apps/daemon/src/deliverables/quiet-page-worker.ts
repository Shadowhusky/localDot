import { parentPort, workerData } from "node:worker_threads";
import { quietPage } from "./quiet-page.ts";

parentPort?.postMessage(typeof workerData === "string" ? (quietPage(workerData) ?? null) : null);
