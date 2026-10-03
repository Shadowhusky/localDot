import { config } from "zod";

// Browser entry points load this before any schemas. Zod otherwise probes Function() when
// constructing its first object schema, which violates the page/worker CSP even when caught.
// The interpreter performs the same validation without generated code.
config({ jitless: true });
