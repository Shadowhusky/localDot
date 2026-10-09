import { parsePublicOrigins } from "./guard.ts";
import { runOpenLink } from "./open-link.ts";
import { localdotHome } from "./paths.ts";
import { parsePort } from "./port.ts";

const abort = new AbortController();
const interrupt = () => abort.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.some((arg) => arg !== "--qr") || args.length > 1) {
    console.error("Usage: localdot open [--qr]");
    process.exitCode = 2;
  } else {
    process.exitCode = await runOpenLink(
      {
        home: localdotHome(),
        port: parsePort(process.env.LOCALDOT_PORT),
        signal: abort.signal,
        publicOrigins: parsePublicOrigins(process.env.LOCALDOT_PUBLIC_ORIGIN || undefined),
        qr: args.length === 1,
      },
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
