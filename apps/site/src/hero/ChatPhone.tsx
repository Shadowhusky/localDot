import "@app/ui/phone-layout.css";
import { clock } from "@app/agent/activity.ts";
import type { AgentSessionView } from "@app/agent/useAgentSession.ts";
import { Dot } from "@app/dot/Dot.tsx";
import { ChatThread } from "@app/shell/ChatThread.tsx";
import { DotStrip } from "@app/shell/DotStrip.tsx";
import { NarratorBand } from "@app/shell/NarratorBand.tsx";
import { PhoneBar } from "@app/shell/PhoneBar.tsx";
import type { Wearable } from "@localdot/protocol";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n.ts";

const nothing = () => {};
// A thumbnail needs few frames, and the recording is already playing beside it.
const THUMB_MS = 200;

// The computer's small live picture at the foot of the chat, drawn from the window's own recording.
function useThumb(video: HTMLVideoElement | null) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!slot || !video) return;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    slot.replaceChildren(canvas);
    const draw = () => {
      if (video.readyState >= 2) canvas.getContext("2d")?.drawImage(video, 0, 0, 160, 100);
    };
    draw();
    const timer = window.setInterval(draw, THUMB_MS);
    return () => {
      window.clearInterval(timer);
      slot.replaceChildren();
    };
  }, [slot, video]);
  return setSlot;
}

// The task on show as Chat has it, on a phone beside the window: the app's own bar, bubbles and foot,
// fed by the same recording. A picture of the app, so nothing in it can be pressed.
export function ChatPhone({
  title,
  agent,
  rows,
  live,
  api,
  line,
  idle,
  look,
  video,
  elapsedMs,
  working,
  start,
  composer,
}: {
  title: string;
  agent?: AgentSessionView;
  rows: ComponentProps<typeof ChatThread>["rows"];
  live: ComponentProps<typeof ChatThread>["live"];
  api: ComponentProps<typeof ChatThread>["api"];
  line: string;
  idle: boolean;
  look?: readonly Wearable[];
  video: HTMLVideoElement | null;
  elapsedMs: number;
  working: boolean;
  start?: ReactNode;
  composer: ReactNode;
}) {
  const monitor = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const setThumb = useThumb(video);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the band comes and goes with the task
  useEffect(() => {
    setDock(root.current?.querySelector<HTMLElement>(".narrator-dock") ?? null);
  }, [agent]);
  return (
    <div ref={root} className="site-chat" data-layout="phone">
      <PhoneBar
        title={title}
        back={{ label: t("Back"), icon: "chevron-left", onPress: nothing }}
        onDetails={nothing}
        lamp={working}
        monitorRef={monitor}
        onComputer={nothing}
        moreRef={more}
        menu={null}
      />
      <aside className="phone-thread">
        <ChatThread
          chat
          pinned
          agent={agent}
          api={api}
          rows={rows}
          live={live}
          start={start}
          foot={
            agent && (
              <DotStrip
                live={working}
                hidden={false}
                band={<NarratorBand line={line} speaker="dot" showDot idle={idle} />}
                thumb={
                  working
                    ? {
                        light: "dot",
                        time: clock(elapsedMs),
                        slotRef: setThumb,
                        onOpen: nothing,
                      }
                    : undefined
                }
              />
            )
          }
          composer={composer}
        />
      </aside>
      {dock && createPortal(<Dot size={44} state="idle" wearables={look} />, dock)}
    </div>
  );
}
