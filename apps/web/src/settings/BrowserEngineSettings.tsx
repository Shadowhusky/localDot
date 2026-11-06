import { useRef, useState } from "react";
import { CHROME_TERMS_LINKS } from "../../../../packages/protocol/src/browser-engine.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Group, GroupRow, IconTile } from "../ui/Group.tsx";
import type { BrowserEngineView } from "./useBrowserEngine.ts";

// Where Chrome comes from and whose terms it is under, wherever the choice is offered.
export function ChromeTerms() {
  return (
    <>
      Google Chrome comes from Google, not localDot, and is downloaded from Google to this computer.
      Choosing it means you accept{" "}
      <a href={CHROME_TERMS_LINKS.terms} target="_blank" rel="noopener noreferrer">
        Google's Terms of Service
      </a>{" "}
      and{" "}
      <a href={CHROME_TERMS_LINKS.additional} target="_blank" rel="noopener noreferrer">
        Chrome's Additional Terms
      </a>
      .
    </>
  );
}

const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function engineLine(view: BrowserEngineView): string {
  const { status } = view;
  if (!status) return "";
  if (status.installing)
    return "Installing Google Chrome. Chromium keeps working until it's ready.";
  if (status.choice === "chrome" && status.engine === "chromium")
    return status.problem
      ? `Using Chromium. ${status.problem}`
      : status.restartNeeded
        ? "Google Chrome is ready. It opens next time the web browser starts."
        : "";
  if (status.engine === "chrome")
    return status.restartNeeded
      ? "A new version is ready. It opens next time the web browser starts."
      : (status.problem ?? "");
  return status.choice === "chromium"
    ? "You chose Chromium. You can switch to Google Chrome any time."
    : "";
}

// Which browser dot's web browser runs, and the way back from Chrome.
export function BrowserEngineSettings({ view }: { view: BrowserEngineView }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const backTrigger = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  const [goingBack, setGoingBack] = useState(false);
  const { status, pending, failure } = view;
  if (!status) return null;
  const onChrome = status.engine === "chrome";
  const name = onChrome ? "Google Chrome" : "Chromium";
  const failed = status.choice === "chrome" && !onChrome && !!status.problem;
  const line = failure ?? engineLine(view);
  const back = status.backup;
  return (
    <Group>
      <GroupRow
        className="settings-engine"
        leading={<IconTile icon="globe" />}
        label="Web browser"
        detail={`${name}${status.version ? ` ${status.version.split(".")[0]}` : ""}${
          status.builtIn ? ", built into this version" : ""
        }`}
        trailing={
          status.offered && !onChrome && !status.installing ? (
            <Button
              ref={trigger}
              size="sm"
              busy={pending === "chrome"}
              onClick={() => setAsking(true)}
            >
              {failed ? "Try again…" : "Use Google Chrome…"}
            </Button>
          ) : status.offered && onChrome && !back ? (
            <Button
              size="sm"
              variant="quiet"
              busy={pending === "chromium"}
              onClick={() => void view.choose({ choice: "chromium" })}
            >
              Use Chromium
            </Button>
          ) : undefined
        }
      >
        {(line || back) && (
          <div className="settings-engine-body">
            {line && (
              <p className="settings-lede" role="status">
                {line}
              </p>
            )}
            {back && (
              <>
                <p className="settings-lede">
                  Your sign-ins from {dayOf(back.at)}, before Chrome opened them, are kept in a
                  backup.
                </p>
                <div className="settings-engine-actions">
                  <Button
                    ref={backTrigger}
                    size="sm"
                    busy={pending === "restore"}
                    onClick={() => setGoingBack(true)}
                  >
                    Go back to Chromium…
                  </Button>
                  <Button
                    size="sm"
                    variant="quiet"
                    busy={pending === "delete"}
                    onClick={view.deleteBackup}
                  >
                    Delete backup
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </GroupRow>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        anchor={trigger}
        title="Use Google Chrome?"
        description={
          <span className="settings-chrome-terms">
            <ChromeTerms />
          </span>
        }
        body={
          <p className="settings-lede">
            Your sign-ins are backed up first. Chrome updates them in a way Chromium can't read, so
            going back later means returning to that backup. When Chrome is ready, dot's web browser
            restarts, and a task using it loses its open pages.
          </p>
        }
      >
        <Button variant="quiet" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setAsking(false);
            void view.choose({ choice: "chrome", acceptGoogleTerms: true, restart: true });
          }}
        >
          Accept and install
        </Button>
      </Dialog>
      <Dialog
        open={goingBack}
        onClose={() => setGoingBack(false)}
        anchor={backTrigger}
        title="Go back to Chromium?"
        description={
          back
            ? `dot's web browser restarts on Chromium with your sign-ins as they were on ${dayOf(back.at)}. Anything you signed in to or saved since then is lost.`
            : ""
        }
      >
        <Button variant="quiet" onClick={() => setGoingBack(false)}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            setGoingBack(false);
            view.restoreBackup();
          }}
        >
          Go back
        </Button>
      </Dialog>
    </Group>
  );
}
