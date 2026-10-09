import {
  type CatalogEntry,
  type ConnectorView,
  catalogEntry,
  connectorHost,
  connectorSecretId,
} from "@localdot/protocol";
import { type FormEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile, Monogram } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Select } from "../ui/Select.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  type CustomForm,
  type CustomProblems,
  catalogDraft,
  customDraft,
  EMPTY_CUSTOM,
  initialOf,
  statusLine,
  TOOL_MODES,
  type ToolMode,
  toolChoice,
  toolLabel,
  toolMode,
} from "./connectors-form.ts";
import type { ConnectorsView } from "./useConnectors.ts";

// More tools than this, and the list opens with a search.
const SEARCH_FROM = 10;
const PLACEHOLDER_ROWS = 2;

// A secret typed here shows as dots without being offered to the browser's password manager.
function SecretField({
  label,
  description,
  error,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  description?: ReactNode;
  error?: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
}) {
  return (
    <Field label={label} description={description} error={error}>
      <TextField
        className="keys-secret"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={8192}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

// The entry's own advice on making a key, and where to make one.
function HelpLink({ entry }: { entry: CatalogEntry }) {
  if (!entry.key) return null;
  return (
    <>
      {entry.key.help}
      <span className="connectors-link">
        <a href={entry.key.helpUrl} target="_blank" rel="noopener noreferrer">
          Get one from {entry.name}
        </a>
        <span className="connectors-host">{new URL(entry.key.helpUrl).host}</span>
      </span>
    </>
  );
}

// One tool: what it is, and whether it just runs, asks first or is off.
function ToolRow({
  tool,
  appName,
  busy,
  onMode,
}: {
  tool: ConnectorView["tools"][number];
  appName: string;
  busy: boolean;
  onMode(mode: ToolMode): void;
}) {
  const label = toolLabel(tool);
  return (
    <li>
      <GroupRow
        className="connectors-tool"
        label={label}
        detail={tool.description || undefined}
        trailing={
          <Select
            appearance="inline"
            size="sm"
            aria-label={`${label} in ${appName}`}
            value={toolMode(tool)}
            items={TOOL_MODES}
            onValueChange={(next) => {
              if (!busy) onMode(next as ToolMode);
            }}
          />
        }
      />
    </li>
  );
}

function ToolList({ view, connectors }: { view: ConnectorView; connectors: ConnectorsView }) {
  const [query, setQuery] = useState("");
  const remove = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const busy = connectors.pending === view.id;
  const words = query.trim().toLowerCase();
  const shown = words
    ? view.tools.filter((tool) =>
        `${toolLabel(tool)} ${tool.name} ${tool.description}`.toLowerCase().includes(words),
      )
    : view.tools;
  return (
    <div className="connectors-tools">
      {view.tools.length > SEARCH_FROM && (
        <div className="connectors-search">
          <TextField
            size="sm"
            filled
            aria-label={`Search ${view.name}'s tools`}
            prefix={<Icon name="search" size={14} />}
            placeholder="Search tools"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {view.tools.length > 0 && (
        <ul className="connectors-tool-list" aria-label={`${view.name}'s tools`}>
          {shown.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              appName={view.name}
              busy={busy}
              onMode={(mode) =>
                void connectors.update(view.id, { tools: { [tool.name]: toolChoice(mode) } })
              }
            />
          ))}
          {!shown.length && <li className="connectors-empty">No tools match “{query.trim()}”.</li>}
        </ul>
      )}
      <div className="connectors-actions">
        <Button
          variant="quiet"
          size="sm"
          icon="repeat"
          busy={busy && view.status === "connecting"}
          disabledReason={!view.enabled ? "Turn the app on first" : undefined}
          onClick={() => connectors.refresh(view.id)}
        >
          Check again
        </Button>
        <Button ref={remove} variant="quiet" size="sm" onClick={() => setConfirming(true)}>
          Remove…
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        anchor={remove}
        title={`Remove ${view.name}?`}
        description="dot stops using it, and the key localDot keeps for it is deleted."
      >
        <Button variant="quiet" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            setConfirming(false);
            void connectors.remove(view.id);
          }}
        >
          Remove
        </Button>
      </Dialog>
    </div>
  );
}

// What the app needs before dot can use it: a sign-in, a key, or another try.
function NextStep({ view, connectors }: { view: ConnectorView; connectors: ConnectorsView }) {
  const [key, setKey] = useState("");
  const entry = catalogEntry(view.catalog);
  const busy = connectors.pending === view.id;
  if (!view.enabled) return null;
  if (view.status === "needs_sign_in")
    return (
      <GroupRow
        label={`Sign in to ${view.name}`}
        detail={
          view.server.kind === "remote"
            ? `Opens ${connectorHost(view.server.url)} in a new tab.`
            : undefined
        }
        trailing={
          <Button
            size="sm"
            variant="primary"
            busy={busy}
            onClick={() => connectors.signIn(view.id)}
          >
            Sign in
          </Button>
        }
      />
    );
  const where =
    entry?.key ??
    (view.server.kind === "remote"
      ? {
          hosts: [connectorHost(view.server.url)],
          header: "authorization",
          format: "bearer" as const,
        }
      : undefined);
  if (view.status === "needs_key" && where) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (!key.trim() || busy) return;
      void connectors
        .saveKey(
          view.id,
          { hosts: where.hosts, header: where.header, format: where.format, value: key.trim() },
          view.server.kind === "remote" && view.server.auth.kind !== "key"
            ? {
                server: {
                  ...view.server,
                  auth: { kind: "key", secret: connectorSecretId(view.id) },
                },
              }
            : undefined,
        )
        .then((saved) => {
          if (saved) setKey("");
        });
    };
    return (
      <div className="ui-group-row">
        <form className="connectors-form" onSubmit={submit}>
          <SecretField
            label={entry?.key?.label ?? "Key"}
            description={entry ? <HelpLink entry={entry} /> : undefined}
            error={connectors.failure?.id === view.id ? connectors.failure.text : undefined}
            value={key}
            onChange={setKey}
          />
          <div className="connectors-form-actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              busy={busy}
              disabledReason={key.trim() ? undefined : "Paste the key first"}
            >
              Save key
            </Button>
          </div>
        </form>
      </div>
    );
  }
  if (view.status === "failed")
    return (
      <GroupRow
        label="Couldn't connect"
        detail={view.problem ?? "The app didn't answer."}
        trailing={
          <Button size="sm" busy={busy} onClick={() => connectors.refresh(view.id)}>
            Try again
          </Button>
        }
      />
    );
  return null;
}

function AppCard({ view, connectors }: { view: ConnectorView; connectors: ConnectorsView }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const busy = connectors.pending === view.id;
  const on = view.tools.filter((tool) => tool.enabled).length;
  const failure =
    connectors.failure?.id === view.id && view.status !== "needs_key"
      ? connectors.failure.text
      : undefined;
  return (
    <Group className="connectors-app" data-status={view.status}>
      <Switch
        className="ui-group-row"
        leading={<Monogram>{initialOf(view.name)}</Monogram>}
        label={view.name}
        description={
          <span className="connectors-status" data-status={view.status}>
            {view.status === "connecting" && (
              <span className="connectors-pulse" aria-hidden="true" />
            )}
            {statusLine(view)}
          </span>
        }
        checked={view.enabled}
        onCheckedChange={(checked) => {
          if (!busy) void connectors.update(view.id, { enabled: checked });
        }}
      />
      <NextStep view={view} connectors={connectors} />
      <button
        type="button"
        className="ui-group-row connectors-disclosure"
        data-open={open || undefined}
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((now) => !now)}
      >
        <span className="ui-group-row-text">
          <span className="ui-group-row-label">Tools</span>
        </span>
        <span className="ui-group-row-trailing">
          {view.tools.length ? `${on} of ${view.tools.length} on` : "None listed yet"}
          <Icon name="chevron-down" size={16} className="connectors-chevron" />
        </span>
      </button>
      <Collapse open={open} id={panel}>
        <ToolList view={view} connectors={connectors} />
      </Collapse>
      {failure && (
        <p className="connectors-failure" role="alert">
          <Icon name="circle-alert" size={14} />
          {failure}
        </p>
      )}
    </Group>
  );
}

const ADDRESS_SIGN_INS = [
  { value: "none", label: "Nothing" },
  { value: "key", label: "A key" },
  { value: "oauth", label: "Its own sign-in page" },
] as const;

// An app that isn't listed: its address, or the command that runs it on the computer.
function CustomApp({
  taken,
  connectors,
  onDone,
}: {
  taken: ReadonlySet<string>;
  connectors: ConnectorsView;
  onDone(): void;
}) {
  const [form, setForm] = useState<CustomForm>(EMPTY_CUSTOM);
  const [problems, setProblems] = useState<CustomProblems>({});
  const set = <K extends keyof CustomForm>(key: K, value: CustomForm[K]) => {
    setForm((now) => ({ ...now, [key]: value }));
    if (problems[key]) setProblems((now) => ({ ...now, [key]: undefined }));
  };
  const busy = connectors.pending === "new";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const built = customDraft(form, taken);
    if ("problems" in built) {
      setProblems(built.problems);
      return;
    }
    const tab =
      built.draft.server.kind === "remote" && built.draft.server.auth.kind === "oauth"
        ? window.open("", "_blank")
        : undefined;
    void connectors.add(built.draft, built.key).then((view) => {
      if (!view) {
        tab?.close();
        return;
      }
      if (tab !== undefined) connectors.signIn(view.id, tab);
      onDone();
    });
  };
  const command = form.kind === "command";
  return (
    <form className="connectors-form connectors-inline" onSubmit={submit} noValidate>
      <SegmentedControl
        size={32}
        aria-label="How the app is reached"
        value={form.kind}
        items={[
          { value: "address", label: "By address" },
          { value: "command", label: "By command" },
        ]}
        onValueChange={(value) => set("kind", value as CustomForm["kind"])}
      />
      <Field label="Name" error={problems.name}>
        <TextField
          placeholder="Calendar"
          maxLength={40}
          value={form.name}
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      {command ? (
        <>
          <Field
            label="Command"
            description="It runs on your computer in a space of its own, with no access to your files."
            error={problems.command}
          >
            <TextField
              className="keys-code"
              placeholder="npx -y @example/app-server"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              value={form.command}
              onChange={(event) => set("command", event.target.value)}
            />
          </Field>
          <div className="keys-pair">
            <Field label="Key variable" error={problems.keyEnv}>
              <TextField
                className="keys-code"
                placeholder="API_KEY"
                autoCapitalize="off"
                spellCheck={false}
                value={form.keyEnv}
                onChange={(event) => set("keyEnv", event.target.value)}
              />
            </Field>
            <Field label="Key is for" error={problems.keyHost}>
              <TextField
                placeholder="api.example.com"
                inputMode="url"
                autoCapitalize="off"
                spellCheck={false}
                value={form.keyHost}
                onChange={(event) => set("keyHost", event.target.value)}
              />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Address" error={problems.url}>
            <TextField
              placeholder="https://example.com/mcp"
              inputMode="url"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              value={form.url}
              onChange={(event) => set("url", event.target.value)}
            />
          </Field>
          <Field label="Signs in with">
            <Select
              value={form.signIn}
              items={ADDRESS_SIGN_INS}
              onValueChange={(value) => set("signIn", value as CustomForm["signIn"])}
            />
          </Field>
        </>
      )}
      <Collapse open={command || form.signIn === "key"}>
        <div className="connectors-key keys-pair">
          <SecretField
            label={command ? "Key (optional)" : "Key"}
            error={problems.key}
            value={form.key}
            onChange={(value) => set("key", value)}
          />
          <Field label="Sent in header" error={problems.header}>
            <TextField
              className="keys-code"
              autoCapitalize="off"
              spellCheck={false}
              value={form.header}
              onChange={(event) => set("header", event.target.value)}
            />
          </Field>
        </div>
      </Collapse>
      {connectors.failure?.id === "new" && (
        <p className="connectors-failure" role="alert">
          <Icon name="circle-alert" size={14} />
          {connectors.failure.text}
        </p>
      )}
      <div className="connectors-form-actions">
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          Add app
        </Button>
      </div>
    </form>
  );
}

// A listed app: Add, then whatever it needs (a key, or a sign-in in a new tab).
function CatalogRow({
  entry,
  taken,
  connectors,
  open,
  onOpen,
}: {
  entry: CatalogEntry;
  taken: ReadonlySet<string>;
  connectors: ConnectorsView;
  open: boolean;
  onOpen(open: boolean): void;
}) {
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const busy = connectors.pending === "new";
  const auth = entry.server.kind === "remote" ? entry.server.auth : "key";
  const needsKey = auth === "key";
  const add = (withKey?: string) => {
    const signsIn = auth === "oauth" || (auth === "oauth-or-key" && !withKey);
    const tab = signsIn ? window.open("", "_blank") : undefined;
    const { draft, key: saved } = catalogDraft(entry, taken, withKey);
    void connectors.add(draft, saved).then((view) => {
      if (!view) {
        tab?.close();
        return;
      }
      if (tab !== undefined) connectors.signIn(view.id, tab);
      onOpen(false);
      setKey("");
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!key.trim()) {
      setProblem("Paste the key first.");
      return;
    }
    add(key.trim());
  };
  return (
    <li>
      <GroupRow
        leading={<Monogram>{initialOf(entry.name)}</Monogram>}
        label={entry.name}
        detail={entry.description}
        trailing={
          <Button
            size="sm"
            busy={busy && !open && connectors.pending === "new"}
            aria-expanded={needsKey || auth === "oauth-or-key" ? open : undefined}
            onClick={() => {
              if (needsKey || auth === "oauth-or-key") onOpen(!open);
              else add();
            }}
          >
            {open ? "Cancel" : "Add"}
          </Button>
        }
      >
        <Collapse open={open}>
          <form className="connectors-form connectors-inline" onSubmit={submit} noValidate>
            {auth === "oauth-or-key" && (
              <div className="connectors-choice">
                <Button variant="primary" busy={busy} onClick={() => add()}>
                  Sign in with {entry.name}
                </Button>
                <span className="connectors-or">or use a key</span>
              </div>
            )}
            <SecretField
              label={entry.key?.label ?? "Key"}
              description={<HelpLink entry={entry} />}
              error={
                problem ?? (connectors.failure?.id === "new" ? connectors.failure.text : undefined)
              }
              value={key}
              onChange={(value) => {
                setKey(value);
                setProblem(undefined);
              }}
            />
            <div className="connectors-form-actions">
              <Button
                type="submit"
                variant={needsKey ? "primary" : "secondary"}
                size="sm"
                busy={busy}
              >
                Connect
              </Button>
            </div>
          </form>
        </Collapse>
      </GroupRow>
    </li>
  );
}

// Settings > Connectors: the user's apps, each tool's behaviour, and the apps that can be added.
export function ConnectorsSection({ connectors }: { connectors: ConnectorsView }) {
  const [opened, setOpened] = useState<string | null>(null);
  const taken = useMemo(
    () => new Set(connectors.connectors.map((view) => view.id)),
    [connectors.connectors],
  );
  const addable = connectors.catalog.filter(
    (entry) => !connectors.connectors.some((view) => view.catalog === entry.id),
  );
  const { phase } = connectors;
  return (
    <div className="settings-connectors">
      <p className="settings-lede">
        dot works in these apps directly, without the screen. Their keys stay with localDot, never
        with dot, and anything that changes something asks you first.
      </p>
      {phase === "error" ? (
        <Group>
          <GroupRow
            label="Couldn't load your apps"
            trailing={
              <Button variant="quiet" size="sm" onClick={connectors.reload}>
                Try again
              </Button>
            }
          />
        </Group>
      ) : phase === "loading" ? (
        <Group aria-busy="true">
          {Array.from({ length: PLACEHOLDER_ROWS }, (_, index) => (
            <GroupRow
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else
              key={index}
              leading={<Skeleton loading shape="block" width="28px" height="28px" />}
              label={<Skeleton loading width="12ch" />}
              detail={<Skeleton loading width="22ch" />}
            />
          ))}
        </Group>
      ) : (
        connectors.connectors.length > 0 && (
          <section className="connectors-block" aria-labelledby="connectors-yours">
            <GroupHead id="connectors-yours" title="Your apps" />
            <div className="connectors-apps">
              {connectors.connectors.map((view) => (
                <AppCard key={view.id} view={view} connectors={connectors} />
              ))}
            </div>
          </section>
        )
      )}
      {phase === "ready" && (
        <section className="connectors-block" aria-labelledby="connectors-add">
          <GroupHead id="connectors-add" title="Add an app" />
          <Group>
            <ul className="connectors-catalog" aria-label="Apps you can add">
              {addable.map((entry) => (
                <CatalogRow
                  key={entry.id}
                  entry={entry}
                  taken={taken}
                  connectors={connectors}
                  open={opened === entry.id}
                  onOpen={(open) => {
                    connectors.clear();
                    setOpened(open ? entry.id : null);
                  }}
                />
              ))}
              <li>
                <GroupRow
                  leading={<IconTile icon="plug" />}
                  label="Another app"
                  detail="By its address, or the command that runs it"
                  trailing={
                    <Button
                      size="sm"
                      aria-expanded={opened === "custom"}
                      onClick={() => {
                        connectors.clear();
                        setOpened(opened === "custom" ? null : "custom");
                      }}
                    >
                      {opened === "custom" ? "Cancel" : "Add"}
                    </Button>
                  }
                >
                  <Collapse open={opened === "custom"}>
                    <CustomApp
                      taken={taken}
                      connectors={connectors}
                      onDone={() => setOpened(null)}
                    />
                  </Collapse>
                </GroupRow>
              </li>
            </ul>
          </Group>
          <GroupNote>
            Apps that run on your computer start in a space of their own, with no access to your
            files.
          </GroupNote>
        </section>
      )}
    </div>
  );
}
