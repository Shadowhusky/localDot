import { localdotHome } from "./paths.ts";
import { parsePort } from "./port.ts";
import { runStop } from "./stop.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
let cellId: string | undefined,
  valid = true;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--cell") valid = false;
  else cellId = args[1];
}
const abort = new AbortController();
const interrupt = () => abort.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  if (!valid) {
    console.error("Usage: localdot stop [--cell <computer-id>]");
    process.exitCode = 2;
  } else
    process.exitCode = await runStop(
      {
        home: localdotHome(),
        cellId,
        port: parsePort(process.env.LOCALDOT_PORT),
        signal: abort.signal,
      },
      { out: (message) => console.log(message), err: (message) => console.error(message) },
    );
} catch {
  console.error("Stop could not start. Check the local daemon configuration.");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
