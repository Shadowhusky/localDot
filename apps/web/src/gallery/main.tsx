import "@localdot/protocol/csp";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gallery } from "./Gallery.tsx";
import "../theme.css";
import "../app.css";
import "./gallery.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
