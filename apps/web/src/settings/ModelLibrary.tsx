import { providerById } from "@localdot/providers";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Combobox } from "../ui/Combobox.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { foldAway } from "../ui/leave.ts";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { Select } from "../ui/Select.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  type ModelRole,
  modelAllowed,
  modelIdProblem,
  type PickerKey,
  type ProviderModels,
  type RoleChoice,
} from "./choices.ts";
import { CHATGPT, CLAUDE_CODE, CUSTOM_FORMATS, isCustomFormat } from "./chooser.ts";
import {
  firstSource,
  knownFacts,
  type LibraryRow,
  libraryGroups,
  libraryProblem,
  type ModelSource,
  modelSources,
  newChoices,
  setModelOn,
  sourceGroups,
  withModels,
  withoutModel,
} from "./model-library.ts";
import { type SetupControls, SourceSetup } from "./SourceSetup.tsx";
import type { ProviderIndex } from "./settings-api.ts";
import { priceOf, type SettingsDraft } from "./settings-form.ts";

export interface ModelLibraryProps {
  draft: Pick<SettingsDraft, "choices" | "models">;
  index: ProviderIndex | null;
  keys: readonly PickerKey[];
  providers: readonly ProviderModels[];
  modelName(route: string, model: string): string;
  onModels(models: RoleChoice[]): void;
  onRole(role: ModelRole, choice: RoleChoice): void;
  list(keyId: string, signal: AbortSignal): Promise<readonly { id: string; name?: string }[]>;
  // What sets up a provider from Add models: the key layer, and the plans' own sign-in, whose
  // accounts are read once it opens.
  keyStore: SetupControls["keyStore"];
  plans: SetupControls["plans"] & { browse(): void };
}

const ROLE_NAMES: Record<ModelRole, string> = { main: "Default", fast: "Fast", local: "Local" };

// Every model the user has, under its provider or endpoint. Each that is on can be chosen in a task,
// and any can be the default or the fast one.
export function ModelLibrary(props: ModelLibraryProps) {
  const { draft, index, keys, modelName, onModels, onRole } = props;
  const groups = useMemo(() => libraryGroups(draft, index), [draft, index]);
  const models = draft.models ?? [];
  const adding = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <section className="settings-role" aria-labelledby={titleId}>
      <GroupHead
        id={titleId}
        title="Your models"
        aside={
          <Button ref={adding} variant="quiet" size="sm" icon="plus" onClick={() => setOpen(true)}>
            Add models
          </Button>
        }
      />
      {groups.map((group) => (
        <div key={group.label} className="settings-model-group">
          <p className="settings-model-group-label">{group.label}</p>
          <Group>
            {group.rows.map((row) => (
              <ModelRow
                key={row.id}
                row={row}
                name={modelName(row.choice.provider, row.choice.model)}
                problem={libraryProblem(row.choice, keys)}
                main={draft.choices.main?.provider}
                onOn={(on) => onModels(setModelOn(models, row.choice, on))}
                onRole={(role) => onRole(role, row.choice)}
                onRemove={() => onModels(withoutModel(models, row.choice))}
              />
            ))}
          </Group>
        </div>
      ))}
      <GroupNote>
        Models that are on can be chosen for any task. A new task starts on the default.
      </GroupNote>
      <AddModels
        open={open}
        returnFocus={adding}
        {...props}
        onClose={() => setOpen(false)}
        onAdd={(added) => {
          onModels(withModels(models, added));
          setOpen(false);
        }}
      />
    </section>
  );
}

function ModelRow({
  row,
  name,
  problem,
  main,
  onOn,
  onRole,
  onRemove,
}: {
  row: LibraryRow;
  name: string;
  problem?: string;
  main?: string;
  onOn(on: boolean): void;
  onRole(role: ModelRole): void;
  onRemove(): void;
}) {
  const { choice, role } = row;
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const fastReason =
    choice.provider === CHATGPT
      ? "The ChatGPT plan can only be the main model"
      : choice.provider === CLAUDE_CODE && main !== CLAUDE_CODE
        ? "Only beside a Claude Code main model"
        : undefined;
  const format = isCustomFormat(choice.provider)
    ? CUSTOM_FORMATS.find((item) => item.value === choice.provider)?.label
    : undefined;
  return (
    <div className="settings-model-row">
      <Switch
        className="ui-group-row"
        label={
          <>
            {name}
            {role && <Badge className="settings-tier">{ROLE_NAMES[role]}</Badge>}
          </>
        }
        description={
          problem ?? [name === choice.model ? "" : choice.model, format].filter(Boolean).join(" · ")
        }
        checked={!choice.off}
        {...(role
          ? { disabledReason: `In use as the ${ROLE_NAMES[role].toLowerCase()} model` }
          : {})}
        onCheckedChange={onOn}
      />
      <IconButton
        ref={more}
        icon="more-horizontal"
        size={32}
        label={`More for ${name}`}
        {...triggerProps("menu", menu)}
        onClick={() => setMenu(true)}
      />
      <Menu open={menu} onClose={() => setMenu(false)} anchor={more} label={`${name} actions`}>
        <MenuItem
          disabledReason={role === "main" ? "This is the default" : problem}
          onSelect={() => onRole("main")}
        >
          Make the default
        </MenuItem>
        <MenuItem
          disabledReason={role === "fast" ? "This is the fast model" : (problem ?? fastReason)}
          onSelect={() => onRole("fast")}
        >
          Make the fast model
        </MenuItem>
        <MenuItem
          icon="trash"
          disabledReason={role ? "Choose another model for its role first" : undefined}
          onSelect={() => void foldAway(goesWith(more.current)).then(onRemove)}
        >
          Remove
        </MenuItem>
      </Menu>
    </div>
  );
}

// What leaves with a model: its row, or the whole group where it is the last there.
function goesWith(from: HTMLElement | null) {
  const row = from?.closest(".settings-model-row");
  const group = row?.closest(".settings-model-group");
  return group?.querySelectorAll(".settings-model-row").length === 1 ? group : row;
}

// The formats a key can speak: formats that share a kind of key share the endpoint behind it. An
// endpoint still to be set up can be any of them.
const formatsOf = (source: ModelSource | undefined) =>
  CUSTOM_FORMATS.filter(
    (row) =>
      source?.custom &&
      (source.setup || providerById(row.value)?.keyd === providerById(source.provider)?.keyd),
  ).map((row) => ({ ...row }));

function AddModels({
  open,
  returnFocus,
  draft,
  index,
  keys,
  providers,
  list,
  keyStore,
  plans,
  onClose,
  onAdd,
}: ModelLibraryProps & {
  open: boolean;
  returnFocus: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onAdd(added: RoleChoice[]): void;
}) {
  const chatgptReady = plans.chatgpt.summary?.state === "signed_in" && plans.chatgpt.verified;
  const claudeReady = plans.claudeCode.canStart;
  const sources = useMemo(
    () => modelSources(index, keys, { [CHATGPT]: chatgptReady, [CLAUDE_CODE]: claudeReady }),
    [index, keys, chatgptReady, claudeReady],
  );
  // Null until one is chosen: the first ready key or plan, if any.
  const [sourceId, setSourceId] = useState<string | null>(null);
  // A key just saved here, whose source comes in with the next list of keys.
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const arrived = awaiting ? sources.find((row) => row.key === awaiting) : undefined;
  const chosenId = arrived?.id ?? sourceId;
  const source = sources.find((row) => row.id === chosenId) ?? firstSource(sources);
  // The one set up just now, which says so once its models are in.
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => {
    if (!arrived) return;
    setSourceId(arrived.id);
    setFresh(arrived.id);
    setAwaiting(null);
  }, [arrived]);
  const browse = useRef(plans.browse);
  browse.current = plans.browse;
  useEffect(() => {
    if (open) browse.current();
  }, [open]);
  const [chosenFormat, setFormat] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const listed = useListedModels(open, source, providers, plans, list);
  const reset = () => {
    setPicked(new Set());
    setTyped("");
    setFilter("");
    setInput("");
    setOutput("");
  };
  const have = useMemo(
    () =>
      new Set(
        [draft.choices.main, draft.choices.fast, draft.choices.local, ...(draft.models ?? [])]
          .filter((choice): choice is RoleChoice => !!choice)
          .map((choice) => `${choice.model}\0${choice.key ?? ""}`),
      ),
    [draft],
  );
  const id = source?.typed && !source.setup ? typed.trim() : "";
  const idProblem = id ? modelIdProblem(id) : null;
  const ids = [...picked, ...(id && !idProblem ? [id] : [])];
  const siblings = [draft.choices.main, draft.choices.fast, ...(draft.models ?? [])].filter(
    (choice): choice is RoleChoice => !!choice,
  );
  // The format the endpoint's other models use, until the user says otherwise.
  const format =
    chosenFormat ??
    siblings.find((row) => row.key === source?.key && isCustomFormat(row.provider))?.provider ??
    source?.provider ??
    "";
  const formats = formatsOf(source);
  const flat = !!siblings.find((row) => row.key === source?.key && row.plan);
  const unpriced =
    !!source?.custom && !flat && ids.some((model) => !knownFacts(providers, model).price);
  const price = priceOf({ input, output });
  const shown = listed.models.filter((model) =>
    `${model.id} ${model.name ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const reason = !source
    ? "Choose where they come from first"
    : source.setup
      ? `Set up ${source.setup === "endpoint" ? "your endpoint" : source.label} first`
      : !ids.length
        ? "Choose a model first"
        : unpriced && !price
          ? "Give a price first"
          : undefined;
  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        setSourceId(null);
        setAwaiting(null);
        setFresh(null);
        setFormat(null);
        onClose();
      }}
      title="Add models"
      description="From any provider or plan. One that isn't set up yet can be set up here."
      modal
      returnFocus={returnFocus}
      closeLabel="Close"
      detents={["large"]}
      className="settings-dot-sheet"
      footer={
        <div className="settings-dot-footer">
          <Button
            variant="primary"
            disabledReason={reason}
            onClick={() => {
              if (!source) return;
              onAdd(newChoices(source, ids, providers, siblings, price, format));
              reset();
            }}
          >
            {ids.length > 1 ? `Add ${ids.length} models` : "Add model"}
          </Button>
        </div>
      }
    >
      <div className="settings-dot-form">
        <Field label="From">
          <Combobox
            value={source?.id ?? ""}
            groups={sourceGroups(sources)}
            placeholder="Choose a provider"
            searchPlaceholder="Search providers"
            onValueChange={(next) => {
              setSourceId(next);
              setAwaiting(null);
              setFresh(null);
              setFormat(null);
              reset();
            }}
          />
        </Field>
        {!source && (
          <p className="settings-lede">
            Choose an API provider, a plan you already have or an app on this Mac.
          </p>
        )}
        {formats.length > 1 && (
          <Field label="API format">
            <Select value={format} items={formats} onValueChange={setFormat} />
          </Field>
        )}
        {source?.setup && (
          <SourceSetup
            source={source}
            format={format}
            active={open}
            controls={{ keyStore, plans }}
            onKeySaved={setAwaiting}
          />
        )}
        {awaiting && !arrived && (
          <p className="settings-lede" role="status">
            <Spinner size={16} /> Reading its models…
          </p>
        )}
        {fresh && fresh === source?.id && (
          <p className="settings-lede" role="status">
            {source.label} is set up. Choose the models to add.
          </p>
        )}
        {listed.loading && (
          <p className="settings-lede" role="status">
            <Spinner size={16} /> Reading the model list…
          </p>
        )}
        <Banner
          tone="neutral"
          open={!!listed.problem}
          announce
          title={listed.problem ?? ""}
          className="settings-dot-banner"
        />
        {source?.typed && !source.setup && !source.custom && (
          <p className="settings-note">{LOCAL_HINTS[source.provider]}</p>
        )}
        {listed.models.length > 8 && (
          <Field label="Search" className="settings-model-search">
            <TextField
              value={filter}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setFilter(event.target.value)}
            />
          </Field>
        )}
        {shown.length > 0 && (
          <Group role="group" aria-label="Models">
            {shown.map((model) => {
              const added = have.has(`${model.id}\0${source?.key ?? ""}`);
              return (
                <Checkbox
                  key={model.id}
                  className="ui-group-row"
                  label={model.name ?? model.id}
                  description={model.name ? model.id : undefined}
                  checked={added || picked.has(model.id)}
                  {...(added ? { disabledReason: "Already on your list" } : {})}
                  onCheckedChange={(checked) =>
                    setPicked((was) => {
                      const next = new Set(was);
                      if (checked) next.add(model.id);
                      else next.delete(model.id);
                      return next;
                    })
                  }
                />
              );
            })}
          </Group>
        )}
        {source?.typed && !source.setup && (
          <Field label="Add by ID" error={idProblem ?? undefined}>
            <TextField
              value={typed}
              maxLength={128}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="e.g. my-model-1"
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        )}
        {unpriced && (
          <>
            <Field label="Input price">
              <TextField
                inputMode="decimal"
                maxLength={64}
                autoComplete="off"
                prefix="$"
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </Field>
            <Field label="Output price">
              <TextField
                inputMode="decimal"
                maxLength={64}
                autoComplete="off"
                prefix="$"
                value={output}
                onChange={(event) => setOutput(event.target.value)}
              />
            </Field>
            <GroupNote>
              US dollars per million tokens, used to set aside a task's spending. It isn't your
              bill.
            </GroupNote>
          </>
        )}
      </div>
    </Sheet>
  );
}

// What a local server needs before its models answer; nothing here can see whether it runs.
const LOCAL_HINTS: Readonly<Record<string, string>> = {
  lmstudio: "Start LM Studio's local server and load a model, then add it.",
  ollama: "Keep Ollama running with the model pulled, then add it.",
};

// A source's models: its catalog, a plan's own list, or for a custom endpoint the list it keeps
// itself. One still to be set up has none yet.
function useListedModels(
  open: boolean,
  source: ModelSource | undefined,
  providers: readonly ProviderModels[],
  plans: ModelLibraryProps["plans"],
  list: ModelLibraryProps["list"],
) {
  const [read, setRead] = useState<{
    key: string;
    models: readonly { id: string; name?: string }[];
    problem?: string;
  } | null>(null);
  const key = source?.key;
  const custom = !!source?.custom;
  // The page redraws many times a second while dot works: a list is read once for each opening.
  const reader = useRef(list);
  reader.current = list;
  useEffect(() => {
    if (!open || !key || !custom) return;
    const controller = new AbortController();
    setRead(null);
    reader.current(key, controller.signal).then(
      (models) => {
        if (!controller.signal.aborted) setRead({ key, models });
      },
      () => {
        if (!controller.signal.aborted)
          setRead({
            key,
            models: [],
            problem: "This endpoint didn't give its model list. Add models by ID.",
          });
      },
    );
    return () => controller.abort();
  }, [open, key, custom]);
  if (!source || source.setup) return { loading: false, models: [] };
  if (source.provider === CHATGPT) return { loading: false, models: plans.chatgpt.models };
  if (source.provider === CLAUDE_CODE) return { loading: false, models: plans.claudeCode.models };
  if (!custom)
    return {
      loading: false,
      models:
        providers
          .find((row) => row.id === source.provider)
          ?.models.filter((model) => modelAllowed("main", model))
          .map((model) => ({ id: model.id, name: model.name })) ?? [],
    };
  if (!read || read.key !== key) return { loading: open, models: [] };
  return { loading: false, models: read.models, problem: read.problem };
}
