import type { AgentRoleChoice, AgentSettingsDocument } from "@localdot/protocol";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { useRevealInvalid } from "../ui/reveal-field.ts";
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
  apps: boolean;
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
  const [apps, setApps] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<{ label?: string; limit?: string; budget?: string }>({});
  const { scope, reveal } = useRevealInvalid<HTMLElement>();
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
          setError(t`Shared links could not load. Reopen this page to retry.`);
      });
    return () => abort.abort();
  }, [api]);
  const create = async () => {
    if (busy) return;
    const maxTasks = limit.trim() ? Number(limit) : null;
    const found = {
      ...(label.trim() ? {} : { label: t`Give the link a name.` }),
      ...(maxTasks !== null && (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 10000)
        ? { limit: t`Enter a task limit from 1 to 10,000, or leave it empty.` }
        : {}),
      ...(!Number.isFinite(Number(budget)) || Number(budget) < 0.01 || Number(budget) > 10000
        ? { budget: t`Enter a budget from $0.01 to $10,000.` }
        : {}),
    };
    setProblems(found);
    if (Object.keys(found).length) {
      setError("");
      reveal();
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
        apps,
      });
      setLinks((old) => [...old, link]);
      setUrl(link.url);
      setLabel("");
    } catch {
      setError(
        t`The link could not be created. Check the remote connection and configured models.`,
      );
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
      setError(t`This link could not be revoked. Try again; it may still be active.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section ref={scope} className="share-links" aria-label={t`Shared links`}>
      <header className="settings-group-intro">
        <GroupHead title={t`Links for other people`} />
        <GroupNote>
          {t`Recipients use the same computer, files and conversation. Share only with people you trust. Their tasks never get your memory, contacts or routines.`}
        </GroupNote>
      </header>
      <Group>
        <Field
          label={t`Link name`}
          className="ui-group-row"
          {...(problems.label ? { error: problems.label } : {})}
        >
          <TextField
            value={label}
            maxLength={80}
            placeholder={t`e.g. Alex`}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label={t`Expires`} inline className="ui-group-row">
          <Select
            value={hours}
            onValueChange={setHours}
            items={[
              { value: "1", label: t`In 1 hour` },
              { value: "24", label: t`In 1 day` },
              { value: "168", label: t`In 7 days` },
              { value: "720", label: t`In 30 days` },
              { value: "", label: t`Never · until revoked` },
            ]}
          />
        </Field>
        <Field label={t`Model`} className="ui-group-row">
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
          label={t`Allow model switching`}
          description={t`Only between your configured models.`}
          checked={chooseModel}
          onCheckedChange={setChooseModel}
        />
        <Switch
          className="ui-group-row"
          label={t`Allow replays`}
          description={t`Every task's full record: what was said, dot's thinking and its files, archived ones too.`}
          checked={replay}
          onCheckedChange={setReplay}
        />
        <Switch
          className="ui-group-row"
          label={t`Use your apps, keys and browser`}
          description={t`Their tasks can use your connected apps, saved keys and the web browser you're signed in to. Sign-ins saved on the computer itself, such as gh or git, work for every link.`}
          checked={apps}
          onCheckedChange={setApps}
        />
        <Switch
          className="ui-group-row"
          label={t`Show chat settings`}
          description={t`Their model and limits. Owner settings and saved keys remain private.`}
          checked={settings}
          onCheckedChange={setSettings}
        />
        <Field
          label={t`Task limit`}
          className="ui-group-row"
          description={t`Leave empty for unlimited tasks.`}
          {...(problems.limit ? { error: problems.limit } : {})}
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
          label={t`API budget per task ($)`}
          className="ui-group-row"
          description={t`The lower of this and your own limit applies. Subscription plans use their own allowance.`}
          {...(problems.budget ? { error: problems.budget } : {})}
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
          !loaded
            ? t`Loading link settings`
            : !models.length
              ? t`Configure a model first`
              : undefined
        }
      >
        {t`Create shared link`}
      </Button>
      {url && (
        <Field
          label={t`New shared link`}
          description={t`Copy it now. The secret is not stored and cannot be shown again.`}
        >
          <TextField readOnly value={url} onFocus={(e) => e.target.select()} />
          <Button
            variant="quiet"
            icon="copy"
            onClick={() => {
              void navigator.clipboard
                .writeText(url)
                .catch(() => setError(t`Select the link above to copy it manually.`));
            }}
          >
            {t`Copy link`}
          </Button>
        </Field>
      )}
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      <section className="share-link-list" aria-label={t`Existing shared links`}>
        {links.map((link) => {
          const ended = link.revoked || (link.expiresAt !== null && link.expiresAt <= Date.now());
          return (
            <div className="share-link-row" key={link.id}>
              <div>
                <strong>{link.label}</strong>
                <p>
                  {link.revoked
                    ? t`Revoked`
                    : ended
                      ? t`Expired`
                      : link.expiresAt === null
                        ? t`No expiry`
                        : t`Expires ${new Date(link.expiresAt).toLocaleString()}`}{" "}
                  ·{" "}
                  {link.maxTasks === null
                    ? t`${link.tasks} tasks`
                    : t`${link.tasks} / ${link.maxTasks} tasks`}
                  {link.apps && <> · {t`Your apps, keys and browser`}</>}
                </p>
              </div>
              {!ended && (
                <Button variant="quiet" busy={busy} onClick={() => void revoke(link.id)}>
                  {t`Revoke`}
                </Button>
              )}
            </div>
          );
        })}
        {loaded && !links.length && <GroupNote>{t`No shared links yet.`}</GroupNote>}
      </section>
    </section>
  );
}
