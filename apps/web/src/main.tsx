import "@localdot/protocol/csp";
import "./ui/stack.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { localeChoice, resolveLocale, setLocale } from "./i18n/index.ts";
import { followAppearance } from "./onboarding/appearance.ts";
import { rememberArrival } from "./shell/localdot-handoff.ts";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
followAppearance();
// Before the app reads the address: the localDot the user switched here from, and how it looks.
rememberArrival();
// The language before the app's modules load, so words they fix as they load are in it too.
const locale = resolveLocale(localeChoice());
if (locale !== "en") {
  try {
    setLocale(locale, (await import("./i18n/zh-CN/index.ts")).zhCN);
  } catch {
    // A catalog that couldn't load leaves the app in English, not blank.
  }
}
const { App } = await import("./App.tsx");
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
