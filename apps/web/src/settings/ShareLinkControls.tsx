import type { AgentRoleChoice, AgentSettingsDocument } from "@localdot/protocol";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";

export interface ShareLink {
  id: string;
  label: string;
  expiresAt: number | null;
  revoked: boolean;
  tasks: number;
  maxTasks: number | null;
  taskBudgetUSD: number;
  replay: boolean;
  settings: boolean;
  chooseModel: boolean;
  model: AgentRoleChoice;
  models: AgentRoleChoice[];
}
export function ShareLinkControls({ api }: { api: ApiClient }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [models, setModels] = useState<AgentRoleChoice[]>([]);
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState("168");
  const [limit, setLimit] = useState("10");
  const [budget, setBudget] = useState("5");
  const [model, setModel] = useState("0");
  const [chooseModel, setChooseModel] = useState(false);
  const [replay, setReplay] = useState(false);
  const [settings, setSettings] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      api.get<{ links: ShareLink[] }>("/api/remote-access/links", { signal: abort.signal }),
      api.get<AgentSettingsDocument>("/api/agent/settings", { signal: abort.signal }),
    ])
      .then(([data, saved]) => {
        if (abort.signal.aborted) return;
        setLinks(data.links);
        setModels([saved.main, ...(saved.models ?? [])].filter((m): m is AgentRoleChoice => !!m));
        setLoaded(true);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("Shared links could not load. Reopen this page to retry.");
      });
    return () => abort.abort();
  }, [api]);
  const create = async () => {
    if (busy) return;
    const maxTasks = limit.trim() ? Number(limit) : null;
    if (
      !label.trim() ||
      (maxTasks !== null && (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 10000)) ||
      !Number.isFinite(Number(budget)) ||
      Number(budget) < 0.01 ||
      Number(budget) > 10000
    ) {
      setError(
        "Enter a link name, a task limit from 1 to 10,000 (or leave it empty), and a budget from $0.01 to $10,000.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setUrl("");
    try {
      const link = await api.post<ShareLink & { url: string }>("/api/remote-access/links", {
        label,
        expiresInHours: hours ? Number(hours) : null,
        maxTasks,
        taskBudgetUSD: Number(budget),
        modelIndex: Number(model),
        chooseModel,
        replay,
        settings,
      });
      setLinks((old) => [...old, link]);
      setUrl(link.url);
      setLabel("");
    } catch {
      setError("The link could not be created. Check the remote connection and configured models.");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await api.del(`/api/remote-access/links/${id}`);
      setLinks((old) => old.map((link) => (link.id === id ? { ...link, revoked: true } : link)));
      setUrl("");
    } catch {
      setError("This link could not be revoked. Try again; it may still be active.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="share-links" aria-label="Shared links">
      <header className="settings-group-intro">
        <GroupHead title="Links for other people" />
        <GroupNote>
          Recipients use the same computer, files and conversation. Share only with people you
          trust. Keys stay private; tasks can use the services you have enabled.
        </GroupNote>
      </header>
      <Group>
        <Field label="Link name" className="ui-group-row">
          <TextField
            value={label}
            maxLength={80}
            placeholder="e.g. Alex"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Expires" inline className="ui-group-row">
          <Select
            value={hours}
            onValueChange={setHours}
            items={[
              { value: "1", label: "In 1 hour" },
              { value: "24", label: "In 1 day" },
              { value: "168", label: "In 7 days" },
              { value: "720", label: "In 30 days" },
              { value: "", label: "Never · until revoked" },
            ]}
          />
        </Field>
        <Field label="Model" className="ui-group-row">
          <Select
            value={model}
            onValueChange={setModel}
            items={models.map((m, index) => ({
              value: String(index),
              label: `${m.model} · ${m.provider}`,
            }))}
          />
        </Field>
        <Switch
          className="ui-group-row"
          label="Allow model switching"
          description="Only between your configured models."
          checked={chooseModel}
          onCheckedChange={setChooseModel}
        />
        <Switch
          className="ui-group-row"
          label="Allow replays"
          description="Includes past recordings of this computer."
          checked={replay}
          onCheckedChange={setReplay}
        />
        <Switch
          className="ui-group-row"
          label="Show chat settings"
          description="Their model and limits. Owner settings and saved keys remain private."
          checked={settings}
          onCheckedChange={setSettings}
        />
        <Field
          label="Task limit"
          className="ui-group-row"
          description="Leave empty for unlimited tasks."
        >
          <TextField
            type="number"
            min={1}
            max={10000}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </Field>
        <Field
          label="API budget per task ($)"
          className="ui-group-row"
          description="The lower of this and your own limit applies. Subscription plans use their own allowance."
        >
          <TextField
            type="number"
            min={0.01}
            max={10000}
            step={0.01}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </Field>
      </Group>
      <Button
        onClick={() => void create()}
        busy={busy}
        disabledReason={
          !loaded ? "Loading link settings" : !models.length ? "Configure a model first" : undefined
        }
      >
        Create shared link
      </Button>
      {url && (
        <Field
          label="New shared link"
          description="Copy it now. The secret is not stored and cannot be shown again."
        >
          <TextField readOnly value={url} onFocus={(e) => e.target.select()} />
          <Button
            variant="quiet"
            icon="copy"
            onClick={() => {
              void navigator.clipboard
                .writeText(url)
                .catch(() => setError("Select the link above to copy it manually."));
            }}
          >
            Copy link
          </Button>
        </Field>
      )}
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      <section className="share-link-list" aria-label="Existing shared links">
        {links.map((link) => {
          const ended = link.revoked || (link.expiresAt !== null && link.expiresAt <= Date.now());
          return (
            <div className="share-link-row" key={link.id}>
              <div>
                <strong>{link.label}</strong>
                <p>
                  {link.revoked
                    ? "Revoked"
                    : ended
                      ? "Expired"
                      : link.expiresAt === null
                        ? "No expiry"
                        : `Expires ${new Date(link.expiresAt).toLocaleString()}`}{" "}
                  · {link.tasks}
                  {link.maxTasks === null ? " tasks" : ` / ${link.maxTasks} tasks`}
                </p>
              </div>
              {!ended && (
                <Button variant="quiet" busy={busy} onClick={() => void revoke(link.id)}>
                  Revoke
                </Button>
              )}
            </div>
          );
        })}
        {loaded && !links.length && <GroupNote>No shared links yet.</GroupNote>}
      </section>
    </section>
  );
}
