import type { NotifyEvent, NotifySettings, QuietHours } from "@localdot/protocol";
import { useState } from "react";
import { t } from "../i18n/index.ts";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { deviceCopy, deviceDetail, EVENT_ROWS } from "./notifications-copy.ts";
import type { NotificationsView } from "./useNotifications.ts";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE_NAME = /iPhone|iPad|Android/;

export function NotificationsSection({ view }: { view: NotificationsView }) {
  const s = view.settings;
  if (!s || !view.device)
    return view.failed ? (
      <Group>
        <GroupRow
          label={t`Couldn't load notifications`}
          trailing={
            <Button size="sm" onClick={view.retry}>
              {t`Try again`}
            </Button>
          }
        />
      </Group>
    ) : (
      <Skeleton loading shape="block" width="100%" height="320px" />
    );
  const save = (patch: Partial<NotifySettings>) => view.save({ ...s, ...patch });
  const channel = (event: NotifyEvent, which: "mac" | "phone", on: boolean) =>
    save({ events: { ...s.events, [event]: { ...s.events[event], [which]: on } } });
  const copy = deviceCopy(view.device, view.banner);
  const banners = view.banner !== "none";
  const mac = view.banner === "mac";
  return (
    <>
      <p className="settings-lede">
        {!banners
          ? t`dot nudges you when it needs you, finishes or fails: on your phone, and in a tab you keep open.`
          : mac
            ? t`dot nudges you when it needs you, finishes or fails: on the Mac running localDot whenever you aren't looking at localDot there, and on your phone.`
            : t`dot nudges you when it needs you, finishes or fails: on the computer running localDot whenever you aren't looking at localDot there, and on your phone.`}
      </p>
      {!banners && (
        <Banner icon="monitor" title={t`No banners on the computer running localDot`}>
          {t`It has no screen of its own. Turn on notifications on your phone to hear from dot anywhere.`}
        </Banner>
      )}
      <Group>
        <GroupRow
          leading={<IconTile icon={PHONE_NAME.test(view.name) ? "smartphone" : "monitor"} />}
          label={view.name}
          detail={copy.line}
          trailing={
            copy.action === "turn-on" ? (
              <Button
                size="sm"
                variant="primary"
                busy={view.busy === "device"}
                onClick={view.turnOn}
              >
                {t`Turn on`}
              </Button>
            ) : copy.action === "turn-off" ? (
              <Button
                size="sm"
                variant="quiet"
                busy={view.busy === "device"}
                onClick={view.turnOff}
              >
                {t`Turn off`}
              </Button>
            ) : copy.action === "copy-link" ? (
              <Button size="sm" icon="copy" busy={view.busy === "link"} onClick={view.copyLink}>
                {t`Copy sign-in link`}
              </Button>
            ) : undefined
          }
        >
          {view.link && copy.action === "copy-link" && (
            <Field
              label={t`Sign-in link`}
              description={t`Copy it by hand: touch and hold, then tap Copy. It works once, for one minute.`}
              className="settings-notify-link"
            >
              <TextField
                size="sm"
                readOnly
                value={view.link}
                onFocus={(event) =>
                  event.currentTarget.setSelectionRange(0, view.link?.length ?? 0)
                }
              />
            </Field>
          )}
        </GroupRow>
        {/* A computer with banners of its own shows them itself (notify/policy.ts). */}
        {!banners && view.device.kind === "this-mac" && view.tab === "default" && (
          <GroupRow
            leading={<IconTile icon="bell" />}
            label={t`Show them from this tab too`}
            detail={t`Then a click on one opens the task.`}
            trailing={
              <Button size="sm" busy={view.busy === "tab"} onClick={view.allowTab}>
                {t`Allow`}
              </Button>
            }
          />
        )}
        <GroupRow
          leading={<IconTile icon="check-circle" />}
          label={t`Send a test`}
          detail={
            view.busy === "test" ? (
              t`Sending a test…`
            ) : view.result ? (
              <span
                className="settings-notify-result"
                role="status"
                data-failed={view.result.failed || undefined}
              >
                {view.result.failed && <Icon name="circle-alert" size={12} />}
                {view.result.line}
              </span>
            ) : (
              view.testHint
            )
          }
          trailing={
            <Button size="sm" busy={view.busy === "test"} onClick={view.test}>
              {t`Send`}
            </Button>
          }
        />
      </Group>

      <div>
        <GroupHead
          title={t`Notify me about`}
          aside={
            <span className="settings-notify-columns" aria-hidden="true">
              {banners && <span>{mac ? "Mac" : t`Computer`}</span>}
              <span>{t`Phone`}</span>
            </span>
          }
        />
        <Group>
          {EVENT_ROWS.map((row) => (
            <GroupRow
              key={row.event}
              label={row.label}
              detail={row.description}
              trailing={
                <>
                  {banners && (
                    <Switch
                      label={
                        <VisuallyHidden>
                          {mac ? t`${row.label} on this Mac` : t`${row.label} on this computer`}
                        </VisuallyHidden>
                      }
                      checked={s.events[row.event].mac}
                      onCheckedChange={(on) => channel(row.event, "mac", on)}
                    />
                  )}
                  <Switch
                    label={<VisuallyHidden>{t`${row.label} on phones`}</VisuallyHidden>}
                    checked={s.events[row.event].phone}
                    onCheckedChange={(on) => channel(row.event, "phone", on)}
                  />
                </>
              }
            />
          ))}
        </Group>
      </div>

      <div>
        <Group>
          <Switch
            className="ui-group-row"
            label={t`Quiet hours`}
            description={
              mac
                ? t`On your Mac's clock. Done, Failed and routine results wait in localDot.`
                : t`On your computer's clock. Done, Failed and routine results wait in localDot.`
            }
            checked={s.quietHours.enabled}
            onCheckedChange={(enabled) => save({ quietHours: { ...s.quietHours, enabled } })}
          />
          <Collapse open={s.quietHours.enabled}>
            <QuietTimes value={s.quietHours} onChange={(quietHours) => save({ quietHours })} />
            <Switch
              className="ui-group-row"
              label={t`Let “Needs you” through`}
              description={t`Questions and approvals still reach you.`}
              checked={s.quietHours.allowNeedsYou}
              onCheckedChange={(allowNeedsYou) =>
                save({ quietHours: { ...s.quietHours, allowNeedsYou } })
              }
            />
          </Collapse>
        </Group>
      </div>

      <div>
        <Group>
          <Switch
            className="ui-group-row"
            label={t`Show task text`}
            description={
              !banners
                ? t`Off: phones show only “dot needs you”.`
                : mac
                  ? t`Off: phones show only “dot needs you”. Your Mac always shows the task's title.`
                  : t`Off: phones show only “dot needs you”. Your computer always shows the task's title.`
            }
            checked={s.showTaskText}
            onCheckedChange={(showTaskText) => save({ showTaskText })}
          />
        </Group>
        <GroupNote>{t`What dot writes never goes into a notification.`}</GroupNote>
      </div>

      {view.devices.length > 0 && (
        <div>
          <GroupHead title={t`Phones`} />
          <Group>
            {view.devices.map((device) => (
              <GroupRow
                key={device.id}
                leading={<IconTile icon="smartphone" />}
                label={
                  view.device?.kind === "on" && view.device.id === device.id
                    ? t`${device.label} (this device)`
                    : device.label
                }
                detail={deviceDetail(device)}
                trailing={
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={t`Remove ${device.label}`}
                    busy={view.removing === device.id}
                    onClick={() => view.remove(device.id)}
                  >
                    {t`Remove`}
                  </Button>
                }
              />
            ))}
          </Group>
        </div>
      )}
    </>
  );
}

// From and To save when a field is left holding a whole time that differs from the other.
function QuietTimes({ value, onChange }: { value: QuietHours; onChange(next: QuietHours): void }) {
  const [error, setError] = useState<{ which: "start" | "end"; text: string } | null>(null);
  const commit = (which: "start" | "end", time: string) => {
    if (time === value[which]) return setError(null);
    const other = which === "start" ? value.end : value.start;
    if (!TIME.test(time) || time === other) {
      setError({ which, text: time ? t`Pick two different times.` : t`Pick a time.` });
      return;
    }
    setError(null);
    onChange({ ...value, [which]: time });
  };
  return (["start", "end"] as const).map((which) => (
    <Field
      key={which}
      label={which === "start" ? t`From` : t`To`}
      inline
      className="ui-group-row"
      error={error?.which === which ? error.text : undefined}
    >
      <TextField
        key={value[which]}
        size="sm"
        type="time"
        defaultValue={value[which]}
        onBlur={(event) => commit(which, event.currentTarget.value)}
      />
    </Field>
  ));
}
