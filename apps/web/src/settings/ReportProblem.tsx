import { useEffect, useRef, useState } from "react";
import type {
  ReportBundle,
  ReportDraft,
  ReportStatus,
  ReportsOverview,
  SentReport,
} from "../../../../packages/protocol/src/reports.ts";
import { ApiError } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextArea } from "../ui/TextArea.tsx";
import {
  allowReports,
  deleteSent,
  draftReport,
  type ReportControl,
  readReports,
  reportProblem,
  sendDraft,
  sentState,
} from "./reports-api.ts";
import { StableText } from "./StableText.tsx";

type Step =
  | { kind: "write"; busy: boolean; error?: string }
  | { kind: "review"; draft: ReportDraft; busy: boolean; error?: string }
  | { kind: "sent"; sent: SentReport };

const kb = (bytes: number) => `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SHOWN_SENT = 10;
const STATUS: Record<ReportStatus, string> = {
  new: "Received",
  investigating: "Being looked at",
  fixed: "Fixed",
  wontfix: "Closed",
};

// What the review lists before the full text: one line for each part of the report.
function contents(bundle: ReportBundle): [string, string][] {
  const failed = bundle.doctor?.filter((check) => !check.ok).length ?? 0;
  const browsers = bundle.computers.filter((c) => c.browser?.state === "failed").length;
  return [
    ["Summary", bundle.summary],
    ["Your words", bundle.message ?? "None"],
    [
      "localDot",
      `${bundle.app.version} · ${bundle.host.os} ${bundle.host.release} · ${bundle.host.arch}`,
    ],
    [
      "Checks",
      bundle.doctor
        ? failed
          ? `${failed} of ${bundle.doctor.length} failed`
          : `All ${bundle.doctor.length} passed`
        : "Not run",
    ],
    [
      "Computers",
      `${plural(bundle.computers.length, "computer", "computers")}${browsers ? ` · web browser failed` : ""}`,
    ],
    [
      "Recent tasks",
      bundle.tasks.length
        ? `${plural(bundle.tasks.length, "task", "tasks")}: how each ended and why, nothing you or dot wrote`
        : "None",
    ],
    [
      "Logs",
      bundle.logs.length
        ? bundle.logs
            .map(
              (log) =>
                `${log.name.split("/").at(-1)} · ${plural(log.lines.length, "line", "lines")}`,
            )
            .join(", ")
        : "None",
    ],
  ];
}

// Settings › Report a problem: what happened in the user's words, everything the report holds
// before it goes, then its ID to quote. Reports already sent can be followed and deleted.
export function ReportProblem({ report }: { report: ReportControl }) {
  const { api, about } = report;
  const [overview, setOverview] = useState<ReportsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [includeRequest, setIncludeRequest] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "write", busy: false });
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // A failure card asking again starts a fresh report about it.
  const aboutKey = about ? JSON.stringify(about.context) : "";
  const [seen, setSeen] = useState(aboutKey);
  if (seen !== aboutKey) {
    setSeen(aboutKey);
    if (aboutKey) {
      setStep({ kind: "write", busy: false });
      setIncludeRequest(false);
    }
  }

  useEffect(() => {
    let live = true;
    readReports(api).then(
      (value) => live && setOverview(value),
      () => live && setLoadError("Your reports couldn't load. Close Settings and open it again."),
    );
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!overview)
    return loadError ? (
      <GroupNote>{loadError}</GroupNote>
    ) : (
      <Skeleton loading shape="block" width="100%" height="180px" />
    );

  const review = async () => {
    setStep({ kind: "write", busy: true });
    try {
      const draft = await draftReport(api, {
        source: "app",
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(about ? { context: about.context, includeRequest } : {}),
      });
      setStep({ kind: "review", draft, busy: false });
    } catch (failure) {
      setStep({
        kind: "write",
        busy: false,
        error: reportProblem(failure, "The report couldn't be put together. Try again."),
      });
    }
  };
  const send = async (draft: ReportDraft) => {
    setStep({ kind: "review", draft, busy: true });
    try {
      const sent = await sendDraft(api, draft.draft);
      setOverview((now) => now && { ...now, sent: [sent, ...now.sent] });
      setMessage("");
      report.clear();
      setStep({ kind: "sent", sent });
    } catch (failure) {
      setStep({
        kind: "review",
        draft,
        busy: false,
        error: reportProblem(
          failure,
          "The report couldn't be sent. Check the internet connection and try again.",
        ),
      });
    }
  };
  const allow = async (enabled: boolean) => {
    setSaving(true);
    try {
      setOverview(await allowReports(api, enabled));
    } catch {
      setLoadError("That change couldn't be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p className="settings-lede">
        Something not working? Send a report so the localDot team can see what went wrong. You see
        everything in it before it goes.
      </p>
      {!overview.enabled ? (
        <GroupNote>
          Problem reports are off for this localDot. Turn them on below to send one.
        </GroupNote>
      ) : step.kind === "sent" ? (
        <div className="settings-report">
          <Group>
            <GroupRow
              leading={<IconTile icon="check" />}
              label={<span className="settings-report-id">{step.sent.id}</span>}
              detail="Report sent. Quote this ID when you ask for help."
              trailing={
                <Button
                  size="sm"
                  icon={copied ? "check" : "copy"}
                  onClick={() =>
                    void navigator.clipboard.writeText(step.sent.id).then(() => setCopied(true))
                  }
                >
                  <StableText
                    choices={["Copy ID", "Copied"]}
                    value={copied ? "Copied" : "Copy ID"}
                  />
                </Button>
              }
            />
          </Group>
          <div className="settings-report-actions">
            <Button variant="quiet" onClick={() => setStep({ kind: "write", busy: false })}>
              Report another problem
            </Button>
          </div>
        </div>
      ) : step.kind === "review" ? (
        <div className="settings-report">
          <div>
            <GroupHead title="What will be sent" aside={`${kb(step.draft.bytes)} compressed`} />
            <Group>
              {contents(step.draft.bundle).map(([label, value]) => (
                <GroupRow key={label} label={label} detail={value} />
              ))}
            </Group>
            <GroupNote>
              Keys, sign-in links, emails, addresses and your user and computer names are removed.
            </GroupNote>
          </div>
          <Disclosure summary="Everything that will be sent" className="settings-report-all">
            <pre className="settings-well settings-report-text">
              {JSON.stringify(step.draft.bundle, null, 2)}
            </pre>
          </Disclosure>
          <div className="settings-report-actions">
            <Button
              variant="quiet"
              disabledReason={step.busy ? "Sending…" : undefined}
              onClick={() => setStep({ kind: "write", busy: false })}
            >
              Back
            </Button>
            <Button
              variant="primary"
              icon="arrow-up"
              busy={step.busy}
              onClick={() => void send(step.draft)}
            >
              Send report
            </Button>
          </div>
          {step.error && <GroupNote role="alert">{step.error}</GroupNote>}
        </div>
      ) : (
        <div className="settings-report">
          {about && (
            <Group>
              <GroupRow
                leading={<IconTile icon="circle-alert" />}
                label="About this problem"
                detail={about.title}
                trailing={
                  <Button variant="quiet" size="sm" onClick={report.clear}>
                    Remove
                  </Button>
                }
              />
            </Group>
          )}
          <Field
            label="What happened?"
            description="Optional: what you were doing and what went wrong."
          >
            <TextArea
              value={message}
              maxLength={2000}
              maxRows={8}
              placeholder="The task stopped after it opened the booking page."
              onChange={(event) => setMessage(event.target.value)}
            />
          </Field>
          {about?.context.sessionId && (
            <Group>
              <Checkbox
                className="ui-group-row"
                label="Include what you asked dot to do"
                description="Your request for this task, with keys and emails removed."
                checked={includeRequest}
                onCheckedChange={setIncludeRequest}
              />
            </Group>
          )}
          <GroupNote>
            A report holds localDot's version, its checks, your computer's state, how recent tasks
            ended and the last lines of its logs. Never your messages, screenshots or files.
          </GroupNote>
          <div className="settings-report-actions">
            {step.busy && (
              <span className="settings-report-hint" role="status">
                Running localDot's checks. This can take half a minute.
              </span>
            )}
            <Button variant="primary" busy={step.busy} onClick={() => void review()}>
              Review report
            </Button>
          </div>
          {step.error && <GroupNote role="alert">{step.error}</GroupNote>}
        </div>
      )}
      {overview.sent.length > 0 && (
        <div>
          <GroupHead title="Reports you sent" />
          <Group>
            {overview.sent.slice(0, SHOWN_SENT).map((sent) => (
              <SentRow
                key={sent.id}
                report={report}
                sent={sent}
                onDeleted={() =>
                  setOverview(
                    (now) =>
                      now && { ...now, sent: now.sent.filter((each) => each.id !== sent.id) },
                  )
                }
              />
            ))}
          </Group>
          <GroupNote>Reports are kept for 180 days, or until you delete them.</GroupNote>
        </div>
      )}
      <div>
        <Group>
          <Switch
            className="ui-group-row"
            label="Allow problem reports"
            description="Off stops this localDot sending any, from here or from the command line."
            checked={overview.enabled}
            disabledReason={saving ? "Saving…" : undefined}
            onCheckedChange={(on) => void allow(on)}
          />
        </Group>
      </div>
    </>
  );
}

function SentRow({
  report,
  sent,
  onDeleted,
}: {
  report: ReportControl;
  sent: SentReport;
  onDeleted(): void;
}) {
  const [state, setState] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    sentState(report.api, sent.id).then(
      (value) => live && setState(STATUS[value.status]),
      (failure) =>
        live &&
        setState(failure instanceof ApiError && failure.status === 404 ? "No longer kept" : ""),
    );
    return () => {
      live = false;
    };
  }, [report.api, sent.id]);
  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      await deleteSent(report.api, sent.id);
      onDeleted();
    } catch {
      setState("Couldn't delete. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <GroupRow
      label={<span className="settings-report-id">{sent.id}</span>}
      detail={`${new Date(sent.sentAt).toLocaleDateString([], { month: "short", day: "numeric" })} · ${sent.summary}`}
      trailing={
        <>
          <span className="settings-report-state">{state}</span>
          <Button
            ref={trigger}
            variant="quiet"
            size="sm"
            busy={busy}
            aria-label={`Delete ${sent.id}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
          <Dialog
            open={confirming}
            onClose={() => setConfirming(false)}
            anchor={trigger}
            title={`Delete ${sent.id}?`}
            description="The report and its diagnostics are removed from the localDot team's service. You can't undo this."
          >
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete report
            </Button>
          </Dialog>
        </>
      }
    />
  );
}
