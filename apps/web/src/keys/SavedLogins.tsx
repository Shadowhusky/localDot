import {
  accountProblem,
  type LoginImport,
  passwordProblem,
  type SavedLogin,
} from "@localdot/protocol";
import { type CSSProperties, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { signInSite } from "../../../../packages/protocol/src/accounts.ts";
import { t, tr } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Field } from "../ui/Field.tsx";
import { ChooseFileButton } from "../ui/FileButton.tsx";
import { Group, GroupHead, GroupNote, GroupRow, Monogram } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { foldAway } from "../ui/leave.ts";
import { MiddleTruncate } from "../ui/MiddleTruncate.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Skeleton } from "../ui/Skeleton.tsx";
import { TextField } from "../ui/TextField.tsx";
import { ARMED_MS } from "./KeyList.tsx";
import { loginProblem } from "./saved-logins-api.ts";
import type { SavedLoginsView } from "./useSavedLogins.ts";

// Above this many, a list that long gets a search field.
const SEARCH_FROM = 8;

const SKIPPED: Readonly<Record<string, string>> = {
  "no-password": tr("no password"),
  "no-website": tr("no web address dot can use"),
  "not-a-login": tr("not a login, such as a card or a note"),
  "not-https": tr("a plain http site, which isn't filled"),
  "same-site": tr("another account for the same site; one is kept per site"),
  "too-many": tr("past the limit of 3,000 logins"),
  unreadable: tr("the row couldn't be read"),
  "unusable-account": tr("an account name that can't be typed into a page"),
  "unusable-password": tr("a password that can't be typed into a page"),
};

const hostOf = (origin: string) => new URL(origin).host;

export function SavedLogins({
  view,
  unavailable,
  reveal,
}: {
  view: SavedLoginsView;
  // Why nothing can change now.
  unavailable?: string;
  reveal?(element: HTMLElement): void;
}) {
  const phone = useMediaQuery(PHONE);
  const [form, setForm] = useState<"new" | SavedLogin | null>(null);
  const [search, setSearch] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const formNode = useRef<HTMLElement>(null);
  const sorted = useMemo(
    () => [...view.logins].sort((a, b) => hostOf(a.origin).localeCompare(hostOf(b.origin))),
    [view.logins],
  );
  const wanted = search.trim().toLowerCase();
  const shown = wanted
    ? sorted.filter(
        (login) =>
          hostOf(login.origin).includes(wanted) || login.username.toLowerCase().includes(wanted),
      )
    : sorted;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each opened form comes into view once
  useEffect(() => {
    if (form && formNode.current) reveal?.(formNode.current);
  }, [form]);
  const waiting = view.busy ? t`Wait for the last change` : unavailable;
  const actions = (
    <span className="saved-logins-add">
      <ChooseFileButton
        size="sm"
        variant="quiet"
        icon="paperclip"
        accept=".csv,text/csv"
        busy={view.importing}
        disabledReason={waiting}
        onFiles={(files) => {
          const file = files[0];
          if (file) void view.importFile(file);
        }}
      >
        {t`Import`}
      </ChooseFileButton>
      <Button
        size="sm"
        icon="key-round"
        disabledReason={waiting}
        onClick={() => {
          setSaved(null);
          setForm("new");
        }}
      >
        {t`Add login`}
      </Button>
    </span>
  );
  return (
    <section className="keys-section" aria-labelledby="saved-logins-title">
      <GroupHead id="saved-logins-title" title={t`Saved logins`} aside={!phone && actions} />
      <GroupNote>
        {t`After you tap, localDot enters a saved login on its own site. dot never sees the password, and neither can you once it's saved.`}
      </GroupNote>
      {phone && <div className="saved-logins-phone-actions">{actions}</div>}
      <ImportOutcome view={view} />
      {view.failure && (
        <p className="keys-note" data-alert="" role="alert">
          <Icon name="circle-alert" size={12} />
          <span>{view.failure}</span>
        </p>
      )}
      {view.loading ? (
        <Skeleton loading shape="block" width="100%" height="calc(var(--spacing) * 13)" />
      ) : view.logins.length === 0 && unavailable ? (
        <GroupNote>
          {t`Your saved logins show here once they can be read. ${unavailable}.`}
        </GroupNote>
      ) : view.logins.length === 0 ? (
        <Group>
          <EmptyState icon="key-round" title={t`No saved logins yet`}>
            {t`Add one here, or import them from Chrome, 1Password, Bitwarden or Apple Passwords.`}
          </EmptyState>
        </Group>
      ) : (
        <>
          {view.logins.length > SEARCH_FROM && (
            <TextField
              className="saved-logins-search"
              size="sm"
              aria-label={t`Search saved logins`}
              placeholder={t`Search saved logins`}
              prefix={<Icon name="search" size={16} />}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
          <Group>
            <ul
              className="keys-list"
              aria-label={t`Saved logins`}
              style={{ "--_armed": `${ARMED_MS}ms` } as CSSProperties}
            >
              {shown.map((login) => (
                <LoginRow
                  key={login.origin}
                  login={login}
                  phone={phone}
                  unavailable={waiting}
                  edit={() => {
                    setSaved(null);
                    setForm(login);
                  }}
                  remove={(leave) => view.remove(login.origin, leave)}
                />
              ))}
            </ul>
          </Group>
          {shown.length === 0 && <GroupNote>{t`No saved login matches that.`}</GroupNote>}
        </>
      )}
      {saved && <GroupNote role="status">{saved}</GroupNote>}
      {form && (
        <section ref={formNode} className="saved-logins-form" aria-label={t`Saved login`}>
          <LoginForm
            key={form === "new" ? "new" : form.origin}
            editing={form === "new" ? undefined : form}
            view={view}
            unavailable={unavailable}
            close={(line) => {
              setForm(null);
              setSaved(line ?? null);
            }}
          />
        </section>
      )}
    </section>
  );
}

function LoginRow({
  login,
  phone,
  unavailable,
  edit,
  remove,
}: {
  login: SavedLogin;
  phone: boolean;
  unavailable?: string;
  edit(): void;
  remove(leave: () => Promise<void>): Promise<void>;
}) {
  const row = useRef<HTMLLIElement>(null);
  const [armed, setArmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const site = hostOf(login.origin);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <li ref={row} className="keys-row" data-armed={armed ? "" : undefined}>
      <GroupRow
        className="keys-row-inner"
        leading={<Monogram>{site.charAt(0).toUpperCase()}</Monogram>}
        label={
          <span title={site}>
            <MiddleTruncate text={site} />
          </span>
        }
        detail={
          <span className="keys-row-facts" title={login.username || undefined}>
            {login.username || t`No account name`}
          </span>
        }
        trailing={
          <span className="keys-row-actions">
            <IconButton
              size={phone ? 44 : 36}
              icon="compose"
              label={t`Edit login for ${site}`}
              disabledReason={unavailable}
              onClick={edit}
            />
            <IconButton
              size={phone ? 44 : 36}
              icon={armed ? "check" : "trash"}
              label={armed ? t`Confirm remove login for ${site}` : t`Remove login for ${site}`}
              disabledReason={unavailable}
              className="keys-remove-icon"
              data-confirm={armed ? "" : undefined}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                setArmed(false);
                remove(() => foldAway(row.current)).catch((err: unknown) =>
                  setProblem(loginProblem(err, t`Couldn't remove that login. Try again.`)),
                );
              }}
            />
          </span>
        }
      >
        {armed && <span className="keys-row-drain" aria-hidden="true" />}
        {problem && <p className="keys-row-fix keys-row-why">{problem}</p>}
      </GroupRow>
    </li>
  );
}

function LoginForm({
  editing,
  view,
  unavailable,
  close,
}: {
  editing?: SavedLogin;
  view: SavedLoginsView;
  unavailable?: string;
  close(line?: string): void;
}) {
  const password = useRef<HTMLInputElement>(null);
  const [site, setSite] = useState(editing ? hostOf(editing.origin) : "");
  const [account, setAccount] = useState(editing?.username ?? "");
  const [problems, setProblems] = useState<{
    site?: string;
    account?: string;
    password?: string;
    form?: string;
  }>({});
  const [saving, setSaving] = useState(false);
  // The password stays in its field alone, and leaves with the page.
  useEffect(() => {
    const clear = () => {
      if (document.hidden && password.current) password.current.value = "";
    };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const host = editing ? hostOf(editing.origin) : signInSite(site);
    const typed = password.current?.value ?? "";
    const next = {
      ...(host ? {} : { site: t`Enter a public site, like github.com.` }),
      ...(accountProblem(account.trim()) ? { account: accountProblem(account.trim()) } : {}),
      ...(!editing || typed
        ? passwordProblem(typed)
          ? { password: passwordProblem(typed) }
          : {}
        : {}),
    };
    setProblems(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const saved = await view.save({
        origin: editing?.origin ?? `https://${host}`,
        username: account.trim(),
        ...(typed ? { password: typed } : {}),
      });
      if (password.current) password.current.value = "";
      close(t`Saved a login for ${hostOf(saved.origin)}.`);
    } catch (err) {
      setProblems({ form: loginProblem(err, t`Couldn't save that login. Try again.`) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <form
        className="keys-form"
        aria-label={editing ? t`Edit login for ${hostOf(editing.origin)}` : t`Add a login`}
        autoComplete="off"
        onSubmit={(event) => void submit(event)}
      >
        <Field
          label={t`Site`}
          error={problems.site}
          validates
          description={editing ? t`A login stays with its site.` : t`It fills only on this site.`}
        >
          <TextField
            value={site}
            inputMode="url"
            placeholder="github.com"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            maxLength={253}
            readOnly={!!editing || saving}
            onChange={(event) => setSite(event.target.value)}
          />
        </Field>
        <Field label={t`Account`} error={problems.account} validates>
          <TextField
            value={account}
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            maxLength={2000}
            readOnly={saving}
            onChange={(event) => setAccount(event.target.value)}
          />
        </Field>
        <Field
          label={editing ? t`New password` : t`Password`}
          error={problems.password}
          validates
          description={
            editing ? t`Leave it blank to keep the saved one.` : t`It's never shown again.`
          }
        >
          <TextField
            ref={password}
            className="keys-secret"
            type="text"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            maxLength={1000}
            readOnly={saving}
            data-1p-ignore="true"
            data-lpignore="true"
          />
        </Field>
        {problems.form && <p role="alert">{problems.form}</p>}
        <div className="keys-actions">
          <Button
            variant="quiet"
            disabledReason={saving ? t`Saving` : undefined}
            onClick={() => close()}
          >
            {t`Cancel`}
          </Button>
          <Button type="submit" busy={saving} disabledReason={unavailable}>
            {t`Save login`}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function linesOf(skip: LoginImport["skipped"][number]): string {
  if (!skip.lines.length) return "";
  const listed = skip.lines.join(", ");
  const more = skip.count > skip.lines.length;
  if (skip.lines.length === 1) return more ? t` (line ${listed} and more)` : t` (line ${listed})`;
  return more ? t` (lines ${listed} and more)` : t` (lines ${listed})`;
}

// What an import did, in counts and line numbers only. The file is theirs to delete, which it says
// beside the import itself and again here.
function ImportOutcome({ view }: { view: SavedLoginsView }) {
  const { summary, importProblem, importing } = view;
  if (importing)
    return (
      <GroupNote className="saved-logins-import-note" role="status">
        {t`Importing your logins. A long list takes a few minutes.`}
      </GroupNote>
    );
  if (!summary && !importProblem)
    return (
      <GroupNote className="saved-logins-import-note">
        {t`Import a CSV export from Chrome, 1Password, Bitwarden or Apple Passwords. Only each login's site, account and password are kept. The file itself isn't kept, so delete it afterwards.`}
      </GroupNote>
    );
  return (
    <Card className="saved-logins-summary" role="status">
      {importProblem ? (
        <p role="alert">{importProblem}</p>
      ) : (
        summary && (
          <>
            <p className="saved-logins-summary-head">
              {summary.imported === 1
                ? t`Imported 1 login.`
                : t`Imported ${summary.imported.toLocaleString()} logins.`}
              {summary.alreadySaved > 0 &&
                (summary.alreadySaved === 1
                  ? t` ${summary.alreadySaved.toLocaleString()} site has a saved login already, which stayed as it was.`
                  : t` ${summary.alreadySaved.toLocaleString()} sites have a saved login already, which stayed as it was.`)}
            </p>
            {summary.skipped.length > 0 && (
              <ul className="saved-logins-skips">
                {summary.skipped.map((skip) => {
                  const rows = skip.count.toLocaleString();
                  const reason = SKIPPED[skip.reason] ?? tr("the row couldn't be used");
                  return (
                    <li key={skip.reason}>
                      {skip.count === 1
                        ? t`${rows} row left out: ${reason}${linesOf(skip)}`
                        : t`${rows} rows left out: ${reason}${linesOf(skip)}`}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )
      )}
      <p className="saved-logins-delete">
        <Icon name="circle-alert" size={14} />
        <span>
          {t`Delete the file now. It holds your passwords in plain text, and localDot didn't keep a copy.`}
        </span>
      </p>
      <div className="keys-actions">
        <Button variant="quiet" size="sm" onClick={view.dismissSummary}>
          {t`Done`}
        </Button>
      </div>
    </Card>
  );
}
