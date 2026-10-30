import "@localdot/protocol/csp";
import "./ui/stack.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { followAppearance } from "./onboarding/appearance.ts";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
followAppearance();
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
