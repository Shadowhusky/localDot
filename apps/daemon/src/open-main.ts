import { runOpenLink } from "./open-link.ts";
import { localdotHome } from "./paths.ts";
import { parsePort } from "./port.ts";

const abort = new AbortController();
const interrupt = () => abort.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  if (process.argv.slice(2).some((arg) => arg !== "--")) {
    console.error("Usage: localdot open");
    process.exitCode = 2;
  } else {
    process.exitCode = await runOpenLink(
      { home: localdotHome(), port: parsePort(process.env.LOCALDOT_PORT), signal: abort.signal },
      {
        out: (message) => console.log(message),
        err: (message) => console.error(message),
      },
    );
  }
} catch {
  console.error("Sign-in link could not start. Check the local daemon configuration.");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
