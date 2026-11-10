import type { ConversationEntry, OverviewTile, Wearable } from "@localdot/protocol";
import { useState } from "react";
import chart from "../../e2e/fixtures/ui-assets/overview/screen-chart.webp";
import code from "../../e2e/fixtures/ui-assets/overview/screen-code.webp";
import mail from "../../e2e/fixtures/ui-assets/overview/screen-mail.webp";
import map from "../../e2e/fixtures/ui-assets/overview/screen-map.webp";
import poster from "../../e2e/fixtures/ui-assets/overview/screen-poster.webp";
import shop from "../../e2e/fixtures/ui-assets/overview/screen-shop.webp";
import terminal from "../../e2e/fixtures/ui-assets/overview/screen-terminal.webp";
import travel from "../../e2e/fixtures/ui-assets/overview/screen-travel.webp";
import { conversationRows } from "../agent/conversation-list.ts";
import { OverviewGrid } from "../overview/OverviewGrid.tsx";
import type { TilePictureProps } from "../overview/OverviewTile.tsx";
import type { OverviewDensity, OverviewFilter } from "../overview/overview-model.ts";

const NOW = new Date("2026-10-08T09:01:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const id = (n: number) => `01M6K1VH23AAAAAAAAAAAAAA${String(n).padStart(2, "0")}`;

interface Sample {
  title: string;
  picture: string;
  look: Wearable[];
  minutes: number;
  state?: "working" | "needs-you" | "waiting-for-computer" | "paused" | "idle";
  ended?: "done" | "error" | "stopped";
  onScreen?: boolean;
  activity?: string;
  line?: string;
  tag?: ConversationEntry["tag"];
  pinned?: boolean;
  tile: Omit<OverviewTile, "sessionId" | "frame">;
}

const SAMPLES: Sample[] = [
  {
    title: "Plan three autumn days in Kyoto",
    picture: travel,
    look: ["mortarboard", "round-glasses", "star-pin"],
    minutes: 4,
    state: "working",
    onScreen: true,
    activity: "Reading about Higashiyama's temples",
    tile: {
      screen: "browser",
      steps: 14,
      plan: { done: 1, total: 4, current: "Check hours and entry fees" },
    },
  },
  {
    title: "Reply to the boiler engineer",
    picture: mail,
    look: ["suit", "bow"],
    minutes: 2,
    state: "needs-you",
    tag: "blue",
    tile: {
      screen: "browser",
      steps: 6,
      needs: { reason: "approval", text: "Send the reply to Tom Hartley" },
    },
  },
  {
    title: "Breakout, starring dot",
    picture: code,
    look: ["hoodie", "sunglasses"],
    minutes: 6,
    state: "working",
    activity: "Playing a round to check the score",
    tile: { screen: "desktop", steps: 31, plan: { done: 3, total: 5, current: "Test the bricks" } },
  },
  {
    title: "Find a plumber near me with good reviews",
    picture: map,
    look: ["beanie", "monocle"],
    minutes: 1,
    state: "needs-you",
    tile: {
      screen: "browser",
      steps: 9,
      needs: { reason: "question", text: "Weekday mornings or Saturday?" },
    },
  },
  {
    title: "A poster for Blue Hour",
    picture: poster,
    look: ["beret", "scarf"],
    minutes: 3,
    state: "waiting-for-computer",
    pinned: true,
    tile: { screen: "desktop", steps: 12 },
  },
  {
    title: "Where my money went",
    picture: chart,
    look: ["suit", "bow-tie"],
    minutes: 12,
    state: "idle",
    tag: "green",
    tile: { screen: "browser", steps: 22, plan: { done: 4, total: 4 } },
  },
  {
    title: "Standing desks under £400",
    picture: shop,
    look: ["cowboy-hat", "lei"],
    minutes: 95,
    ended: "done",
    line: "The best five are in a table, cheapest first.",
    tile: { screen: "browser", steps: 18 },
  },
  {
    title: "Clean up my Downloads folder",
    picture: terminal,
    look: ["propeller-cap", "overalls"],
    minutes: 180,
    ended: "error",
    line: "The disk filled up before I could move the installers.",
    tile: { screen: "desktop", steps: 7 },
  },
];

const ENTRIES: ConversationEntry[] = SAMPLES.map((sample, at) => ({
  sessionId: id(at),
  sessions: [id(at)],
  title: sample.title,
  said: sample.title,
  startedAt: minutesAgo(sample.minutes + 10),
  ended: sample.ended ?? null,
  look: sample.look,
  ...(sample.line ? { line: sample.line } : {}),
  ...(sample.tag ? { tag: sample.tag } : {}),
  ...(sample.pinned ? { pinned: true } : {}),
  ...(sample.state
    ? {
        live: {
          state: sample.state,
          since: minutesAgo(sample.minutes),
          onScreen: !!sample.onScreen,
          ...(sample.activity ? { activity: sample.activity } : {}),
        },
      }
    : {}),
}));

const ROWS = conversationRows(ENTRIES, { live: null, needsYou: new Set() });
const TILES = new Map(
  SAMPLES.map((sample, at) => [id(at), { sessionId: id(at), frame: id(at), ...sample.tile }]),
);
const PICTURES = new Map(SAMPLES.map((sample, at) => [id(at), sample.picture]));

function StillPicture({ sessionId }: TilePictureProps) {
  return (
    <img
      className="overview-picture-image"
      src={PICTURES.get(sessionId)}
      alt=""
      draggable={false}
    />
  );
}

function Specimen({
  density: initial,
  width,
  height,
  heading,
}: {
  density: OverviewDensity;
  width: number;
  height: number;
  heading?: boolean;
}) {
  const [density, setDensity] = useState(initial);
  const [filter, setFilter] = useState<OverviewFilter>("all");
  return (
    <figure className="gallery-overview" data-width={width}>
      <div className="gallery-overview-frame" data-size={`${width}x${height}`}>
        <OverviewGrid
          rows={ROWS}
          tiles={TILES}
          now={NOW}
          density={density}
          filter={filter}
          onDensity={setDensity}
          onFilter={setFilter}
          Picture={StillPicture}
          shown
          current={null}
          heading={
            heading ? (
              <div className="overview-heading">
                <h1 className="overview-heading-title">Overview</h1>
              </div>
            ) : undefined
          }
          onOpen={() => {}}
          onInView={() => {}}
          onHand={() => {}}
        />
      </div>
      <figcaption>{`${width} × ${height}, ${density.toUpperCase()}`}</figcaption>
    </figure>
  );
}

// The overview with eight conversations in every state, at a desktop's width in each size and at a
// phone's, for the eye.
export function OverviewPage() {
  return (
    <div className="gallery-overviews">
      <Specimen density="m" width={1160} height={760} />
      <Specimen density="s" width={1160} height={520} />
      <Specimen density="l" width={1160} height={760} />
      <Specimen density="m" width={390} height={844} heading />
      <Specimen density="s" width={390} height={844} heading />
    </div>
  );
}
