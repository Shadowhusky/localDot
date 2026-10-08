import "./spike.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gallery } from "./Gallery.tsx";
import { KitProvider } from "./KitProvider.tsx";

// ?inline-styles lets Base UI render its <style> elements again: the negative control showing the
// CSP check would catch them.
const inlineStyles = new URLSearchParams(location.search).has("inline-styles");
const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <KitProvider>
      {inlineStyles ? (
        <CSPProvider disableStyleElements={false}>
          <Gallery />
        </CSPProvider>
      ) : (
        <Gallery />
      )}
    </KitProvider>
  </StrictMode>,
);
