import "../stack.css";
import "./gallery.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gallery } from "./Gallery.tsx";

if (new URLSearchParams(location.search).get("appearance") === "midnight") {
  document.documentElement.dataset.appearance = "midnight";
}
const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
