import { type DotJob, type DotSummary, sealPassphrase } from "@localdot/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Progress } from "../ui/Progress.tsx";
import { Select } from "../ui/Select.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  COPY_CHOICES,
  chosenCopy,
  defaultCopy,
  dotNameProblem,
  passphraseProblem,
  toggled,
} from "./dot-copy.ts";
import {
  addDot,
  cancelDotJob,
  dotProblem,
  dotSignIn,
  sendPassphrase,
  waitForJob,
} from "./dots-api.ts";

// Copy from nothing: a new dot that starts empty.
const EMPTY = "";

type Phase = "form" | "working" | "passphrase" | "done";

export interface AddDotSheetProps {
  open: boolean;
  api: ApiClient;
  dots: readonly DotSummary[];
  returnFocus?: RefObject<HTMLElement | null>;
  onClose(): void;
  // The list changed: the new dot is there.
  onAdded(): void;
  navigate?(url: string): void;
}

export function AddDotSheet({
  open,
  api,
  dots,
  returnFocus,
  onClose,
  onAdded,
  navigate = (url) => window.location.assign(url),
}: AddDotSheetProps) {
  const self = dots.find((dot) => dot.self);
  const [name, setName] = useState("");
  const [source, setSource] = useState(self?.id ?? EMPTY);
  const [copy, setCopy] = useState(defaultCopy);
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [job, setJob] = useState<DotJob | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [passTried, setPassTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const watching = useRef<AbortController | null>(null);
  const added = useRef("");

  // A fresh form each time it opens; a job left running keeps going without this page. Only opening
  // starts over: the list refreshing under it must not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!open) return;
    setName("");
    setSource(dots.find((dot) => dot.self)?.id ?? EMPTY);
    setCopy(defaultCopy());
    setTried(false);
    setPhase("form");
    setJob(null);
    setPassphrase("");
    setAgain("");
    setPassTried(false);
    setProblem(null);
    setOpening(false);
    return () => watching.current?.abort();
  }, [open]);

  const nameProblem = dotNameProblem(name);
  const passProblem = passphraseProblem(passphrase, again);
  const copying = source !== EMPTY;

  // Each attempt follows its job until the sheet closes or another attempt starts.
  const attempt = () => {
    watching.current?.abort();
    const controller = new AbortController();
    watching.current = controller;
    return controller.signal;
  };

  const follow = async (started: DotJob, signal: AbortSignal) => {
    setJob(started);
    const settled = await waitForJob(api, started, { signal, onUpdate: setJob });
    setJob(settled);
    if (settled.state === "needs-passphrase") {
      setPhase("passphrase");
      return;
    }
    if (settled.state === "done") {
      setPhase("done");
      onAdded();
      return;
    }
    setProblem(settled.error ?? `${added.current} wasn't added.`);
    setPhase("form");
  };

  const submit = async () => {
    setTried(true);
    if (nameProblem) return;
    setProblem(null);
    setPhase("working");
    added.current = name.trim();
    const signal = attempt();
    try {
      await follow(
        await addDot(api, {
          name: name.trim(),
          ...(copying ? { from: source } : {}),
          copy: copying ? chosenCopy(copy) : [],
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      setProblem(dotProblem(error, `${added.current} wasn't added.`));
      setPhase("form");
    }
  };

  const unlock = async () => {
    setPassTried(true);
    if (passProblem || !job?.sealKey) return;
    setProblem(null);
    setPhase("working");
    const signal = attempt();
    try {
      const sealed = await sealPassphrase(job.sealKey, passphrase);
      const next = await sendPassphrase(api, job.id, sealed);
      setPassphrase("");
      setAgain("");
      setPassTried(false);
      await follow(next, signal);
    } catch (error) {
      if (signal.aborted) return;
      setProblem(dotProblem(error, "That passphrase wasn't taken. Try again."));
      setPhase("passphrase");
    }
  };

  const openNew = async () => {
    const id = job?.dot;
    if (!id) return;
    setOpening(true);
    setProblem(null);
    try {
      navigate((await dotSignIn(api, id)).url);
    } catch (error) {
      setProblem(dotProblem(error, `${added.current} didn't open. Try again in a moment.`));
      setOpening(false);
    }
  };

  // A dot waiting for its passphrase is half made: leaving now undoes it rather than leave it so.
  const close = () => {
    if (phase === "passphrase" && job) void cancelDotJob(api, job.id).catch(() => {});
    onClose();
  };

  const footer =
    phase === "form" ? (
      <div className="settings-dot-footer">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()}>
          Add dot
        </Button>
      </div>
    ) : phase === "passphrase" ? (
      <div className="settings-dot-footer">
        <Button variant="quiet" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void unlock()}>
          Continue
        </Button>
      </div>
    ) : phase === "done" ? (
      <div className="settings-dot-footer">
        <Button variant="quiet" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" busy={opening} onClick={() => void openNew()}>
          {`Open ${added.current}`}
        </Button>
      </div>
    ) : (
      <div className="settings-dot-footer">
        <Button variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>
    );

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Add a dot on this computer"
      description="A dot of its own: its own address, keys and computer, on the same installation."
      modal
      dirty={(phase === "form" && name.trim() !== "") || (phase === "passphrase" && !!passphrase)}
      returnFocus={returnFocus}
      closeLabel="Close"
      detents={["large"]}
      className="settings-dot-sheet"
      footer={footer}
    >
      <Banner
        tone="danger"
        open={!!problem}
        announce
        title={problem ?? ""}
        className="settings-dot-banner"
      />
      <div className="settings-dot-form">
        {phase === "form" && (
          <>
            <Field label="Name" error={tried ? (nameProblem ?? undefined) : undefined}>
              <TextField
                value={name}
                maxLength={40}
                placeholder="Work"
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </Field>
            <Field
              label="Copy from"
              description={copying ? undefined : "It starts with nothing from your other dots."}
            >
              <Select
                value={source}
                onValueChange={setSource}
                items={[
                  ...dots.map((dot) => ({
                    value: dot.id,
                    label: dot.self ? `${dot.name} (this dot)` : dot.name,
                  })),
                  { value: EMPTY, label: "Nothing — start empty" },
                ]}
              />
            </Field>
            {copying && (
              <Disclosure
                summary="Advanced: what to copy"
                meta={`${chosenCopy(copy).length} of ${COPY_CHOICES.length}`}
              >
                <div className="settings-dot-copy">
                  {COPY_CHOICES.map((choice) => (
                    <Checkbox
                      key={choice.id}
                      label={choice.label}
                      description={choice.note}
                      checked={copy.has(choice.id)}
                      onCheckedChange={(on) => setCopy((now) => toggled(now, choice.id, on))}
                    />
                  ))}
                </div>
              </Disclosure>
            )}
            <div className="settings-dot-notes">
              <p>
                Never copied: its sign-in, remote access, phone notifications, ChatGPT sign-in, and
                key audit and spending records.
              </p>
              <p>Claude Code's sign-in is shared by every dot on this computer.</p>
            </div>
          </>
        )}
        {phase === "working" && (
          <div className="settings-dot-progress" role="status">
            <Progress label={`Adding ${added.current}`} />
            <p>{job?.step ?? `Adding ${added.current}…`}</p>
          </div>
        )}
        {phase === "passphrase" && (
          <>
            <p className="settings-dot-lede">
              {`${added.current} keeps its saved keys in a file only a passphrase opens. Choose its own passphrase; you'll need it after this computer restarts.`}
            </p>
            <Field label="New passphrase">
              <TextField
                type="password"
                value={passphrase}
                autoComplete="new-password"
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </Field>
            <Field label="Type it again" error={passTried ? (passProblem ?? undefined) : undefined}>
              <TextField
                type="password"
                value={again}
                autoComplete="new-password"
                onChange={(event) => setAgain(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void unlock();
                  }
                }}
              />
            </Field>
          </>
        )}
        {phase === "done" && (
          <p className="settings-dot-lede" role="status">
            {`${added.current} is ready at its own address. Open it to sign in there.`}
          </p>
        )}
      </div>
    </Sheet>
  );
}
