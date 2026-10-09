import type { QuestionAnswerRequest } from "@localdot/protocol";
import { clsx } from "clsx";
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { CodeField } from "../ui/CodeField.tsx";
import { Field } from "../ui/Field.tsx";
import { ChooseFileButton } from "../ui/FileButton.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { isApple, Kbd } from "../ui/Kbd.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { QrCode } from "../ui/QrCode.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { TextArea } from "../ui/TextArea.tsx";
import { TextField, type TextFieldProps } from "../ui/TextField.tsx";
import { RevealedText } from "./ApprovalValue.tsx";
import { type AskDraft, type AskState, useAskState } from "./ask-draft.ts";
import {
  type AskField,
  confirmsBySubmit,
  fieldProblem,
  fieldValue,
  submitProblem,
} from "./ask-form.ts";
import { CopyButton } from "./CopyButton.tsx";
import { FileTransferFailure } from "./file-transfer.ts";
import { KeyFound } from "./KeyFound.tsx";
import { hiddenWarning, plainReveal, revealText } from "./reveal-text.ts";
import "../shell/decision.css";

const TOUCH = "(hover: none) and (pointer: coarse)";
const COARSE = "(pointer: coarse)";
const KEY_TAKEN = "That looked like a key, so it was taken out.";

// Where the question is answered: under dot's message in the thread, in the island over the
// computer, or in a phone's sheet.
export type AskLayout = "thread" | "island" | "sheet";
export type AskUpload = (file: File, signal: AbortSignal) => Promise<string>;

export interface AskFormProps {
  draft: AskDraft;
  layout: AskLayout;
  answer(request: QuestionAnswerRequest): Promise<boolean>;
  // Unavailable while set: every control keeps its place and Send says why.
  reason?: string;
  // Puts a file on the computer and gives its path there; absent while the computer can't take one.
  upload?: AskUpload;
  // Takes a key pasted into a field into Keys.
  receiveKey?: KeyIntake["receive"];
}

const TYPED = new Set<AskField["kind"]>([
  "text",
  "longtext",
  "secret",
  "code",
  "number",
  "date",
  "email",
  "url",
  "phone",
]);
const TEXT_INPUT: Partial<Record<AskField["kind"], Partial<TextFieldProps>>> = {
  number: { inputMode: "decimal" },
  date: { type: "date" },
  email: { type: "email", inputMode: "email", autoComplete: "email" },
  url: { type: "url", inputMode: "url", autoComplete: "url" },
  phone: { type: "tel", inputMode: "tel", autoComplete: "tel" },
};

// dot's question answered in place: its fields, then Not now and dot's own verb. The same draft
// backs every surface, so what is typed in one shows in the others.
export function AskForm({ draft, layout, answer, reason, upload, receiveKey }: AskFormProps) {
  const state = useAskState(draft);
  const titleId = `ask-${draft.question.askId}`;
  const composing = useRef(false);
  const touch = useMediaQuery(TOUCH);
  const form = useRef<HTMLFormElement>(null);
  const { question, fields } = draft;
  const sheet = layout === "sheet";
  const waiting = state.sending ? "Wait a moment" : undefined;
  const incomplete = submitProblem(fields, state.draft);
  const choice = fields.length === 1 && fields[0]?.kind === "choice" ? fields[0] : undefined;
  const asked = useMemo(() => revealText(question.question), [question.question]);

  // Typing starts in the first field when it takes typing and nothing else has focus, so a question
  // never takes the keys from what you were typing elsewhere. A phone keeps its keyboard down until
  // a field is tapped.
  const typed = TYPED.has(fields[0]?.kind ?? "qr");
  useEffect(() => {
    if (touch || reason || layout === "sheet" || !typed) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    form.current?.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
  }, [touch, reason, layout, typed]);

  const submit = () => {
    if (reason || state.sending || incomplete || composing.current) return;
    void draft.submit(answer);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === "Enter" && (event.nativeEvent.isComposing || composing.current)) {
      event.preventDefault();
      return;
    }
    if (
      event.key === "Enter" &&
      target instanceof HTMLTextAreaElement &&
      (isApple() ? event.metaKey : event.ctrlKey)
    ) {
      event.preventDefault();
      submit();
      return;
    }
    if (!choice || target.matches("input:not([type='radio']), textarea")) return;
    if (event.altKey || event.ctrlKey || event.metaKey || !/^[1-9]$/.test(event.key)) return;
    const index = Number(event.key) - 1;
    if (index >= choice.options.length) return;
    event.preventDefault();
    if (!reason) draft.set(choice.id, String(index));
  };

  const body = (
    <div className="ask-fields">
      {fields.map((field) => (
        <AskFieldControl
          key={field.id}
          field={field}
          fields={fields}
          state={state}
          draft={draft}
          plain={!question.fields?.length}
          touch={touch}
          reason={reason}
          upload={upload}
        />
      ))}
      <KeyFound
        className="ask-key"
        guard={{ notice: state.found, move: draft.moveKey, remove: draft.discardKeys }}
        receive={receiveKey}
        within="answer"
      />
    </div>
  );
  const foot = (
    <div className={clsx("ask-foot", layout !== "thread" && "decision-foot")}>
      <p className="ask-problem" role="status">
        {state.failed}
      </p>
      <div className="ask-actions" data-single={question.declinable === false || undefined}>
        {question.declinable !== false && (
          <Button
            size={sheet ? "xxl" : "md"}
            busy={state.sending === "decline"}
            disabledReason={reason ?? (state.sending === "answer" ? waiting : undefined)}
            onClick={() => {
              if (!reason && !state.sending) void draft.decline(answer);
            }}
          >
            {question.decline ?? "Not now"}
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          size={sheet ? "xxl" : "md"}
          busy={state.sending === "answer"}
          disabledReason={
            reason ?? (state.sending === "decline" ? waiting : undefined) ?? incomplete
          }
        >
          {question.submit ?? "Send answer"}
        </Button>
      </div>
    </div>
  );
  return (
    <form
      ref={form}
      className={clsx("ask", layout !== "thread" && "decision")}
      data-layout={layout}
      aria-label={layout === "thread" ? "Answer dot" : undefined}
      aria-labelledby={layout === "thread" ? undefined : titleId}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={onKeyDown}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
    >
      {layout === "thread" ? (
        body
      ) : (
        <div className="decision-body">
          <h2 id={titleId} tabIndex={-1} className="decision-title">
            <RevealedText text={question.question} />
          </h2>
          {asked.hidden && <p className="decision-warning">{hiddenWarning(asked)}</p>}
          {body}
        </div>
      )}
      {foot}
    </form>
  );
}

interface ControlProps {
  field: AskField;
  fields: readonly AskField[];
  state: AskState;
  draft: AskDraft;
  // A plain question's one field: dot's question is its label.
  plain: boolean;
  touch: boolean;
  reason?: string;
  upload?: AskUpload;
}

function AskFieldControl({
  field,
  fields,
  state,
  draft,
  plain,
  touch,
  reason,
  upload,
}: ControlProps) {
  const raw = state.draft.values[field.id];
  const text = typeof raw === "string" ? raw : "";
  const filled = fieldValue(field, state.draft, fields) !== undefined;
  const named = useMemo(() => revealText(field.label), [field.label]);
  const label = plainReveal(named.parts);
  // A problem shows once the field has been left with something in it, and then as it is typed.
  const problem = state.keys.has(field.id)
    ? KEY_TAKEN
    : state.left.has(field.id) && filled
      ? fieldProblem(field, state.draft, fields)
      : undefined;
  const common = {
    label,
    description: fieldNote(
      hiddenWarning(named),
      field.kind === "secret" ? (field.site ?? "") : undefined,
      field.hint,
    ),
    error: problem,
    validates: true,
    disabledReason: reason,
    className: clsx("ask-field", plain && "ask-field-plain"),
  };
  const leave = () => draft.leave(field.id);
  switch (field.kind) {
    case "longtext":
      return (
        <Field {...common}>
          <TextArea
            value={text}
            maxRows={6}
            autoComplete="off"
            onChange={(event) => draft.set(field.id, event.currentTarget.value)}
            onBlur={leave}
          />
        </Field>
      );
    case "secret":
      return (
        <Field {...common}>
          <SecretInput
            label={label}
            value={text}
            onChange={(value) => draft.set(field.id, value)}
            onBlur={leave}
          />
        </Field>
      );
    case "code":
      return (
        <Field {...common}>
          <CodeField
            label={label}
            length={field.length}
            value={text}
            unavailable={!!reason}
            onChange={(value) => draft.set(field.id, value)}
            onBlur={leave}
          />
        </Field>
      );
    case "choice":
      return (
        <ChoiceRows
          field={field}
          label={label}
          note={common.description}
          picked={text}
          other={state.draft.other[field.id] ?? ""}
          problem={problem}
          plain={plain}
          touch={touch}
          reason={reason}
          draft={draft}
        />
      );
    case "multichoice": {
      const picked = Array.isArray(raw) ? raw : [];
      return (
        <ChoiceGroup label={label} note={common.description}>
          {field.options.map((option) => (
            <Checkbox
              key={option}
              label={option}
              checked={picked.includes(option)}
              disabledReason={reason}
              onCheckedChange={(on) =>
                draft.set(
                  field.id,
                  on ? [...picked, option] : picked.filter((other) => other !== option),
                )
              }
            />
          ))}
        </ChoiceGroup>
      );
    }
    case "confirm":
      return confirmsBySubmit(fields) ? null : (
        <Checkbox
          label={label}
          description={common.description}
          checked={raw === true}
          disabledReason={reason}
          onCheckedChange={(on) => draft.set(field.id, on)}
        />
      );
    case "file":
      return (
        <ChoiceGroup label={label} note={common.description}>
          <FileDrop
            value={text}
            reason={reason}
            upload={upload}
            onChange={(path) => draft.set(field.id, path)}
          />
        </ChoiceGroup>
      );
    case "qr":
      return field.value ? (
        <ChoiceGroup label={label}>
          <QrAnswer value={field.value} hint={field.hint} />
        </ChoiceGroup>
      ) : null;
    default:
      return (
        <Field {...common}>
          <TextField
            {...TEXT_INPUT[field.kind]}
            value={text}
            autoComplete={
              TEXT_INPUT[field.kind]?.autoComplete ??
              (fields.some((other) => other.kind === "secret") ? "username" : "off")
            }
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => draft.set(field.id, event.currentTarget.value)}
            onBlur={leave}
          />
        </Field>
      );
  }
}

// Under a field: a warning when its name hides characters, the site a secret is typed into, and
// dot's hint, drawn as an approval card draws a value so nothing in it can disguise the rest.
function fieldNote(warning?: string, site?: string, hint?: string): ReactNode {
  if (!warning && site === undefined && !hint) return undefined;
  return (
    <>
      {warning && <span className="ask-warning">{warning} </span>}
      {site !== undefined &&
        (site ? (
          <>
            dot types this into <span className="ask-site">{site}</span> for you and never sees it.{" "}
          </>
        ) : (
          "dot types this in for you and never sees it. "
        ))}
      {hint && <RevealedText text={hint} />}
    </>
  );
}

// A label and note over controls that are not one input, such as checkbox rows.
function ChoiceGroup({
  label,
  note,
  children,
}: {
  label: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="ui-field ask-field ask-fieldset">
      <legend className="ui-field-label">{label}</legend>
      <div className="ask-group">{children}</div>
      {note && <p className="ui-field-description">{note}</p>}
    </fieldset>
  );
}

function SecretInput({
  label,
  value,
  onChange,
  onBlur,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  onBlur(): void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      type={shown ? "text" : "password"}
      value={value}
      autoComplete="current-password"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onBlur}
      suffix={
        <IconButton
          className="ask-reveal"
          icon={shown ? "eye-off" : "eye"}
          label={`${shown ? "Hide" : "Show"} ${label.toLowerCase()}`}
          size={28}
          onClick={() => setShown((now) => !now)}
        />
      }
    />
  );
}

function ChoiceRows({
  field,
  label,
  note,
  picked,
  other,
  problem,
  plain,
  touch,
  reason,
  draft,
}: {
  field: AskField;
  label: string;
  note: ReactNode;
  picked: string;
  other: string;
  problem?: string;
  plain: boolean;
  touch: boolean;
  reason?: string;
  draft: AskDraft;
}) {
  const id = useId();
  return (
    <Field
      label={label}
      description={note}
      error={problem}
      validates
      disabledReason={reason}
      className={clsx("ask-field", plain && "ask-field-plain")}
    >
      <div className="ask-choice">
        <RadioCards
          className="ask-options"
          name={id}
          value={picked}
          onValueChange={(value) => {
            if (!reason) draft.set(field.id, value);
          }}
          options={field.options.map((option, index) => ({
            value: String(index),
            label: option,
            ...(touch || field.options.length < 2
              ? {}
              : { preview: <Kbd keys={[String(index + 1)]} /> }),
          }))}
        />
        {field.other && (
          <TextField
            id={`${id}other`}
            className="ask-other"
            aria-label="Something else"
            placeholder="Something else…"
            value={other}
            autoComplete="off"
            onChange={(event) => draft.setOther(field.id, event.currentTarget.value)}
            onBlur={() => draft.leave(field.id)}
          />
        )}
      </div>
    </Field>
  );
}

type Upload =
  | { phase: "idle" }
  | { phase: "uploading" | "done" | "failed"; name: string; note?: string };

// A drop target with a Choose button. The file goes to the computer through the same upload as
// the composer's attachments; the answer is its path there.
function FileDrop({
  value,
  reason,
  upload,
  onChange,
}: {
  value: string;
  reason?: string;
  upload?: AskUpload;
  onChange(path: string): void;
}) {
  const [state, setState] = useState<Upload>(() =>
    value ? { phase: "done", name: value.split("/").at(-1) ?? value } : { phase: "idle" },
  );
  const [over, setOver] = useState(false);
  const flight = useRef<AbortController | null>(null);
  useEffect(() => () => flight.current?.abort(), []);
  const unavailable = reason ?? (upload ? undefined : "Turn on your computer first");
  const take = async (file: File | undefined) => {
    if (!file || !upload || unavailable) return;
    flight.current?.abort();
    const abort = new AbortController();
    flight.current = abort;
    setState({ phase: "uploading", name: file.name });
    onChange("");
    try {
      const path = await upload(file, abort.signal);
      if (abort.signal.aborted) return;
      setState({ phase: "done", name: file.name });
      onChange(path);
    } catch (error) {
      if (abort.signal.aborted) return;
      setState({
        phase: "failed",
        name: file.name,
        note:
          error instanceof FileTransferFailure && error.uncertain
            ? "It may have arrived. Check Downloads before choosing it again."
            : "It couldn't be added. Files up to 100 MB with a plain name work.",
      });
    }
  };
  const named = state.phase !== "idle";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for the pointer; Choose a file is the way in by keyboard
    <div
      className="ask-file"
      data-over={over || undefined}
      onDragOver={(event: DragEvent) => {
        if (!event.dataTransfer.types.includes("Files") || unavailable) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        void take(event.dataTransfer.files[0]);
      }}
    >
      <span className="ask-file-tile" aria-hidden="true">
        <Icon name="file" size={16} />
      </span>
      <span className="ask-file-text">
        <span className="ask-file-name">{named ? state.name : "Drop a file here"}</span>
        <span className="ask-file-meta">
          {state.phase === "uploading"
            ? "Adding it to your computer…"
            : state.phase === "done"
              ? "On your computer, in Downloads"
              : state.phase === "failed"
                ? state.note
                : "or choose one"}
        </span>
      </span>
      <ChooseFileButton
        size="sm"
        busy={state.phase === "uploading"}
        disabledReason={unavailable}
        onFiles={(files) => void take(files[0])}
      >
        {named ? "Choose another" : "Choose a file"}
      </ChooseFileButton>
    </div>
  );
}

const linkOf = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};

// A code for another device to scan. A phone can't scan its own screen, so there the code's
// fallback comes first: dot's hint, and the link to open or the text the code holds to copy.
function QrAnswer({ value, hint }: { value: string; hint?: string }) {
  const coarse = useMediaQuery(COARSE);
  const [fallback, setFallback] = useState(coarse);
  const link = linkOf(value);
  return (
    <div className="ask-qr" data-fallback={fallback || undefined}>
      {fallback ? (
        <div className="ask-qr-code">
          {hint && (
            <p className="ask-qr-hint">
              <RevealedText text={hint} />
            </p>
          )}
          {link ? (
            <a className="ask-qr-link" href={link.href} target="_blank" rel="noopener noreferrer">
              Open {link.host}
              <Icon name="arrow-right" size={14} />
            </a>
          ) : (
            <div className="ask-qr-value">
              <p>
                <RevealedText text={value} />
              </p>
              <CopyButton text={value} label="Copy" />
            </div>
          )}
        </div>
      ) : (
        <QrCode value={value} label="QR code to scan with another device" />
      )}
      <Button variant="quiet" size="sm" onClick={() => setFallback((now) => !now)}>
        {fallback ? "Show the QR code" : "On this phone? Use a code instead"}
      </Button>
    </div>
  );
}
