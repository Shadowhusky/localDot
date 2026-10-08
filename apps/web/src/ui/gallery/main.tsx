import "../stack.css";
import "../../theme.css";
import "../../app.css";
import "./shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AtomsPage } from "./AtomsPage.tsx";

// A stand-in for the T01 gallery until it lands here, loading the same legacy styles it does.
const midnight = new URLSearchParams(location.search).get("appearance") === "midnight";
if (midnight) document.documentElement.dataset.appearance = "midnight";
const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <main className="atoms-shell">
      <header className="atoms-head">
        <div>
          <h1>Actions and atoms</h1>
          <p>Every state of the kit's buttons, tooltips, keys, badges and glyphs.</p>
        </div>
        <nav className="atoms-appearance" aria-label="Appearance">
          <a href="?" aria-current={midnight ? undefined : "page"}>
            Graphite
          </a>
          <a href="?appearance=midnight" aria-current={midnight ? "page" : undefined}>
            Midnight
          </a>
        </nav>
      </header>
      <AtomsPage />
    </main>
  </StrictMode>,
);
