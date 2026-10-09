import "@localdot/protocol/csp";
import "../ui/stack.css";
import "../theme.css";
import { startExport } from "./exporter.ts";
import { createExportHost } from "./host-page.ts";

// The daemon adds this binding before it opens the page; it is the page's only way out.
const binding = () => (globalThis as { localdotExport?: (payload: string) => void }).localdotExport;

window.__localdotExportHost = createExportHost({
  send: (message) => binding()?.(JSON.stringify(message)),
  start: startExport,
  origin: location.origin,
});
