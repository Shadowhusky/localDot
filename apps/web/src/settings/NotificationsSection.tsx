import type { NotifyEvent, NotifySettings, QuietHours } from "@localdot/protocol";
import { useState } from "react";
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
          label="Notification settings couldn't be read."
          trailing={
            <Button size="sm" onClick={view.retry}>
              Try again
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
  const copy = deviceCopy(view.device);
  return (
    <>
      <p className="settings-lede">
        dot nudges you when it needs you, finishes or fails: on this Mac with no tab open, and on
        your phone.
      </p>
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
                Turn on
              </Button>
            ) : copy.action === "turn-off" ? (
              <Button
                size="sm"
                variant="quiet"
                busy={view.busy === "device"}
                onClick={view.turnOff}
              >
                Turn off
              </Button>
            ) : copy.action === "copy-link" ? (
              <Button size="sm" icon="copy" busy={view.busy === "link"} onClick={view.copyLink}>
                Copy sign-in link
              </Button>
            ) : undefined
          }
        >
          {view.link && copy.action === "copy-link" && (
            <Field
              label="Sign-in link"
              description="It couldn't be copied. Touch and hold it to copy. It works once, for one minute."
              className="settings-notify-link"
            >
              <TextField
                size="sm"
                readOnly
                value={view.link}
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
          )}
        </GroupRow>
        {view.device.kind === "this-mac" && view.tab === "default" && (
          <GroupRow
            leading={<IconTile icon="bell" />}
            label="Show them from this tab too"
            detail="Then a click on one opens the task."
            trailing={
              <Button size="sm" busy={view.busy === "tab"} onClick={view.allowTab}>
                Allow
              </Button>
            }
          />
        )}
        <GroupRow
          leading={<IconTile icon="check-circle" />}
          label="Send a test"
          detail={
            view.result ? (
              <span
                className="settings-notify-result"
                data-failed={view.result.failed || undefined}
              >
                {view.result.failed && <Icon name="circle-alert" size={12} />}
                {view.result.line}
              </span>
            ) : (
              "Check that notifications reach you."
            )
          }
          trailing={
            <Button size="sm" busy={view.busy === "test"} onClick={view.test}>
              Send
            </Button>
          }
        />
      </Group>

      <div>
        <GroupHead
          title="Notify me about"
          aside={
            <span className="settings-notify-columns" aria-hidden="true">
              <span>Mac</span>
              <span>Phone</span>
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
                  <Switch
                    label={<VisuallyHidden>{`${row.label} on this Mac`}</VisuallyHidden>}
                    checked={s.events[row.event].mac}
                    onCheckedChange={(on) => channel(row.event, "mac", on)}
                  />
                  <Switch
                    label={<VisuallyHidden>{`${row.label} on phones`}</VisuallyHidden>}
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
            label="Quiet hours"
            description="On your Mac's clock. Done, Failed and routine results wait in localDot."
            checked={s.quietHours.enabled}
            onCheckedChange={(enabled) => save({ quietHours: { ...s.quietHours, enabled } })}
          />
          <Collapse open={s.quietHours.enabled}>
            <QuietTimes value={s.quietHours} onChange={(quietHours) => save({ quietHours })} />
            <Switch
              className="ui-group-row"
              label="Let “Needs you” through"
              description="Questions and approvals still reach you."
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
            label="Show task text in notifications"
            description="Off: phones show only “dot needs you”. Your Mac always shows the task's title."
            checked={s.showTaskText}
            onCheckedChange={(showTaskText) => save({ showTaskText })}
          />
        </Group>
        <GroupNote>What dot writes never goes into a notification.</GroupNote>
      </div>

      {view.devices.length > 0 && (
        <div>
          <GroupHead title="Phones" />
          <Group>
            {view.devices.map((device) => (
              <GroupRow
                key={device.id}
                leading={<IconTile icon="smartphone" />}
                label={
                  view.device?.kind === "on" && view.device.id === device.id
                    ? `${device.label} (this device)`
                    : device.label
                }
                detail={deviceDetail(device)}
                trailing={
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={`Remove ${device.label}`}
                    busy={view.removing === device.id}
                    onClick={() => view.remove(device.id)}
                  >
                    Remove
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
      setError({ which, text: time ? "Pick two different times." : "Pick a time." });
      return;
    }
    setError(null);
    onChange({ ...value, [which]: time });
  };
  return (["start", "end"] as const).map((which) => (
    <Field
      key={which}
      label={which === "start" ? "From" : "To"}
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
