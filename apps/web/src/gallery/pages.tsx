import type { ComponentType } from "react";
import { Dot } from "../dot/Dot.tsx";
import type { DotState } from "../dot/engine/states.ts";
import { Glyph } from "../dot/Glyph.tsx";
import { Caption } from "../shell/Caption.tsx";
import { StillFrame } from "./StillFrame.tsx";

export interface GalleryPage {
  id: string;
  title: string;
  about: string;
  Page: ComponentType;
}

const DOT_STATES: DotState[] = [
  "idle",
  "listening",
  "thinking",
  "acting",
  "waiting",
  "your-turn",
  "resting",
  "sleeping",
  "offline",
  "error",
];

function DotPage() {
  return (
    <div className="gallery-grid">
      {DOT_STATES.map((state) => (
        <figure key={state} className="gallery-dot">
          <Dot size={96} state={state} />
          <Dot size={24} state={state} />
          <figcaption>{state}</figcaption>
        </figure>
      ))}
      <figure className="gallery-dot">
        <Dot size={96} state="acting" control />
        <Dot size={24} state="acting" control />
        <figcaption>acting, with control</figcaption>
      </figure>
      <figure className="gallery-dot">
        <Glyph size={16} />
        <figcaption>glyph</figcaption>
      </figure>
    </div>
  );
}

const STAGES = [
  {
    label: "dot has control",
    classes: "stage lit control",
    rim: true,
    caption: "Select the Net total cell",
  },
  { label: "Waiting for you", classes: "stage lit", rim: false, caption: "Waiting for your OK." },
  { label: "Paused", classes: "stage lit frozen", rim: false, caption: "Paused." },
];

function StagePage() {
  return (
    <div className="gallery-stages">
      {STAGES.map((stage) => (
        <figure key={stage.label} className="stage-col">
          <div className={stage.classes}>
            <StillFrame />
            {stage.rim && <div className="rim" aria-hidden="true" />}
          </div>
          <Caption text={stage.caption} />
          <figcaption>{stage.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export const GALLERY_PAGES: GalleryPage[] = [
  { id: "dot", title: "dot", about: "Every state at hero and badge size", Page: DotPage },
  { id: "stage", title: "Stage", about: "The lit stage around a still frame", Page: StagePage },
];
