import { startBootstrappedBrowser } from "./bootstrap.ts";
import { BrowserRuntime } from "./runtime.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

const config = browserRuntimeConfig(process.env);
const runtime = new BrowserRuntime(config);
const startup = new AbortController();
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  startup.abort();
  void runtime.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
void runtime.retired.catch(() => process.exit(1));
try {
  await startBootstrappedBrowser(process.stdin, config, startup.signal, () => runtime.start());
} catch {
  await runtime.close().catch(() => {});
  if (!closing) process.exit(1);
}
