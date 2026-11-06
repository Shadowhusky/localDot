import { providerById } from "@localdot/providers";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { IconButton } from "../ui/IconButton.tsx";
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
import { CHATGPT, CLAUDE_CODE, CUSTOM_FORMATS, isCustomFormat, subscription } from "./chooser.ts";
import {
  knownFacts,
  type LibraryRow,
  libraryGroups,
  libraryProblem,
  type ModelSource,
  modelSources,
  newChoices,
  setModelOn,
  withModels,
  withoutModel,
} from "./model-library.ts";
import { optionId } from "./model-options.ts";
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
          onSelect={onRemove}
        >
          Remove
        </MenuItem>
      </Menu>
    </div>
  );
}

// The formats a key can speak: formats that share a kind of key share the endpoint behind it.
const formatsOf = (source: ModelSource) =>
  CUSTOM_FORMATS.filter(
    (row) => providerById(row.value)?.keyd === providerById(source.provider)?.keyd,
  ).map((row) => ({ ...row }));

function AddModels({
  open,
  returnFocus,
  draft,
  index,
  keys,
  providers,
  list,
  onClose,
  onAdd,
}: ModelLibraryProps & {
  open: boolean;
  returnFocus: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onAdd(added: RoleChoice[]): void;
}) {
  const sources = useMemo(() => modelSources(index, keys), [index, keys]);
  const [sourceId, setSourceId] = useState("");
  const source = sources.find((row) => row.id === sourceId) ?? sources[0];
  const [chosenFormat, setFormat] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const listed = useListedModels(open, source, providers, list);
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
  const id = source?.typed ? typed.trim() : "";
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
  const flat = !!siblings.find((row) => row.key === source?.key && row.plan);
  const unpriced =
    !!source?.custom && !flat && ids.some((model) => !knownFacts(providers, model).price);
  const price = priceOf({ input, output });
  const shown = listed.models.filter((model) =>
    `${model.id} ${model.name ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const reason = !ids.length
    ? "Choose a model first"
    : unpriced && !price
      ? "Give a price first"
      : undefined;
  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add models"
      description="From a key you've saved. The key stays in your key layer."
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
        {sources.length ? (
          <>
            <Field label="From">
              <Select
                value={source?.id ?? ""}
                items={sources.map((row) => ({
                  value: row.id,
                  label: row.label,
                  description: row.description,
                }))}
                onValueChange={(next) => {
                  setSourceId(next);
                  setFormat(null);
                  reset();
                }}
              />
            </Field>
            {source?.custom && formatsOf(source).length > 1 && (
              <Field label="API format">
                <Select value={format} items={formatsOf(source)} onValueChange={setFormat} />
              </Field>
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
            {listed.models.length > 8 && (
              <Field label="Search">
                <TextField
                  value={filter}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </Field>
            )}
            {shown.length > 0 && (
              <Group className="settings-model-list">
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
            {source?.typed && (
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
          </>
        ) : (
          <p className="settings-lede">Add a key first: models come from a key you've saved.</p>
        )}
      </div>
    </Sheet>
  );
}

// A source's models: its catalog, or for a custom endpoint the list it keeps itself.
function useListedModels(
  open: boolean,
  source: ModelSource | undefined,
  providers: readonly ProviderModels[],
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
  if (!source) return { loading: false, models: [] };
  if (!custom)
    return {
      loading: false,
      models:
        providers
          .find((row) => row.id === source.provider)
          ?.models.filter((model) => subscription(source.provider) || modelAllowed("main", model))
          .map((model) => ({ id: model.id, name: model.name })) ?? [],
    };
  if (!read || read.key !== key) return { loading: open, models: [] };
  return { loading: false, models: read.models, problem: read.problem };
}
