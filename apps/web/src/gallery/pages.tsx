import type { ComponentType } from "react";
import { Dot } from "../dot/Dot.tsx";
import type { DotState } from "../dot/engine/states.ts";
import { Glyph } from "../dot/Glyph.tsx";
import { StageColumn } from "../shell/StageColumn.tsx";
import { FeedbackPage } from "../ui/gallery/FeedbackPage.tsx";
import { OverlaysPage } from "../ui/gallery/OverlaysPage.tsx";
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

// Every dot takes this seed, so adding a state leaves the others as they were.
const SEED = 1;

function DotPage() {
  return (
    <div className="gallery-grid">
      {DOT_STATES.map((state) => (
        <figure key={state} className="gallery-dot">
          <Dot size={96} state={state} seed={SEED} />
          <Dot size={24} state={state} seed={SEED} />
          <figcaption>{state}</figcaption>
        </figure>
      ))}
      <figure className="gallery-dot">
        <Dot size={96} state="acting" control seed={SEED} />
        <Dot size={24} state="acting" control seed={SEED} />
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
  { label: "dot has control", caption: "Select the Net total cell", control: true },
  { label: "Waiting for you", caption: "Waiting for your OK." },
  { label: "Paused", caption: "Paused.", paused: true },
];

// The real StageColumn around a still frame. The frame stands in for Stage, so the rim Stage draws
// while dot has control is drawn here.
function StagePage() {
  return (
    <div className="gallery-stages">
      {STAGES.map(({ label, caption, control = false, paused = false }) => (
        <figure key={label}>
          <StageColumn live frozen={paused} control={control} caption={caption}>
            <StillFrame />
            {control && <div className="rim" aria-hidden="true" />}
          </StageColumn>
          <figcaption>{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export const GALLERY_PAGES: GalleryPage[] = [
  { id: "dot", title: "dot", about: "Every state at hero and badge size", Page: DotPage },
  { id: "stage", title: "Stage", about: "The lit stage around a still frame", Page: StagePage },
  {
    id: "overlays",
    title: "Overlays",
    about: "The kit's sheet, menu, popover and dialog",
    Page: OverlaysPage,
  },
  {
    id: "feedback",
    title: "Feedback",
    about: "The kit's toasts, banners, progress, meters, skeletons and empty states",
    Page: FeedbackPage,
  },
];
