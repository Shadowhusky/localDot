import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import type { AskFormProps } from "./AskForm.tsx";
import { useAskState } from "./ask-draft.ts";
import { useAppConnect } from "./useAppConnect.ts";

// dot's offer to connect an app, in the conversation. The same one click as in Settings: the sign-in
// opens in the browser on the Mac, this card waits, and dot carries on once the app is connected.
export function AppConnectRequest({ draft, answer, reason, connectApi: api }: AskFormProps) {
  const field = draft.fields[0];
  const app = field?.connect;
  const state = useAskState(draft);
  const { connect, cancel, starting, waiting, problem } = useAppConnect({
    api,
    connector: app?.connector,
    onConnected: async () => {
      if (!field) return;
      draft.set(field.id, true);
      await draft.submit(answer);
    },
  });
  if (!app || !field)
    return <p role="alert">{t`This offer is incomplete. Ask dot to check the app's settings.`}</p>;
  const verb = app.reconnect ? t`Reconnect` : t`Connect`;
  return (
    <section
      aria-label={app.reconnect ? t`Reconnect ${app.name}` : t`Connect ${app.name}`}
      className="private-key-request keys-form"
    >
      <p className="private-key-title">{app.name}</p>
      <p className="private-key-destination">{app.host}</p>
      <p>
        {waiting
          ? waiting.remote
            ? t`The sign-in opened in the browser on your Mac, where your accounts are. It can't be finished from this device.`
            : t`Approve ${app.name} in your browser. dot carries on when you're done.`
          : t`You approve it in your browser. dot gets the app's tools and never sees this sign-in.`}
      </p>
      {waiting?.page && (
        <p>
          <a href={waiting.page} target="_blank" rel="noopener noreferrer">
            {t`Open the sign-in page`}
          </a>
        </p>
      )}
      {(problem || state.failed) && <p role="alert">{problem || state.failed}</p>}
      <div className="keys-actions">
        <Button
          variant="quiet"
          disabledReason={state.sending ? t`Continuing task` : reason}
          onClick={() => {
            cancel();
            void draft.decline(answer);
          }}
        >
          {t`Not now`}
        </Button>
        <Button
          variant="primary"
          busy={starting}
          disabledReason={
            reason ??
            (state.sending ? t`Continuing task` : undefined) ??
            (!api ? t`Connecting apps is unavailable here` : undefined)
          }
          onClick={() => void connect()}
        >
          {waiting ? t`Open again` : verb}
        </Button>
      </div>
    </section>
  );
}
