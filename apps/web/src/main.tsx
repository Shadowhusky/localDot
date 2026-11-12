import "@localdot/protocol/csp";
import "./ui/stack.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { followAppearance } from "./onboarding/appearance.ts";
import { rememberArrival } from "./shell/localdot-handoff.ts";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
followAppearance();
// Before the app reads the address: the localDot the user switched here from, and how it looks.
rememberArrival();
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
