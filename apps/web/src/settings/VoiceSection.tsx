import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupNote, GroupRow } from "../ui/Group.tsx";
import { formatKeys, isApple } from "../ui/Kbd.tsx";
import { TOUCH, useMediaQuery } from "../ui/media.ts";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { AUTO_LANGUAGE, languageName, speechLanguage, VOICE_LANGUAGES } from "../voice/language.ts";
import type { VoicePrefs } from "../voice/prefs.ts";
import type { VoiceRoute } from "../voice/support.ts";
import { HOLD_KEYS } from "../voice/useVoice.ts";
import { routeDetail, routeLabel } from "../voice/words.ts";

export interface VoiceControl {
  prefs: VoicePrefs;
  saved: boolean;
  change(patch: Partial<VoicePrefs>): void;
  route: VoiceRoute;
  // The browser's own languages, which Automatic follows.
  browser: readonly string[];
  downloading: boolean;
  download(): void;
}

export function VoiceSection({ voice }: { voice: VoiceControl }) {
  const { prefs, route } = voice;
  // A keyboard shortcut means nothing on a touch screen.
  const keys = useMediaQuery(TOUCH) ? null : formatKeys(HOLD_KEYS(isApple())).label;
  const offer = route.kind === "none" && route.why === "download";
  return (
    <>
      <p className="settings-lede">
        Hold the mic in the message field{keys ? `, or ${keys},` : ""} and talk. Your words appear
        in the message, so you can check them before you send.
      </p>
      <Group>
        <GroupRow
          label="Speech to text"
          detail={routeDetail(route)}
          trailing={
            offer ? (
              <Button size="sm" busy={voice.downloading} onClick={voice.download}>
                Download
              </Button>
            ) : (
              routeLabel(route)
            )
          }
        />
        <Field label="Language" inline className="ui-group-row">
          <Select
            appearance="inline"
            value={prefs.language}
            items={[
              {
                value: AUTO_LANGUAGE,
                label: `Automatic (${languageName(speechLanguage(AUTO_LANGUAGE, voice.browser))})`,
              },
              ...VOICE_LANGUAGES,
            ]}
            onValueChange={(language) => voice.change({ language })}
          />
        </Field>
        <Switch
          className="ui-group-row"
          label="Allow online speech"
          description="Only when this device can't. The browser's speech service then hears you."
          checked={prefs.online}
          onCheckedChange={(online) => voice.change({ online })}
        />
      </Group>
      <Group>
        <Switch
          className="ui-group-row"
          label="Read replies aloud"
          description="dot reads each new reply in this device's own voice."
          checked={prefs.readAloud}
          onCheckedChange={(readAloud) => voice.change({ readAloud })}
        />
      </Group>
      <GroupNote>
        Your voice is never saved, and dot only gets the text you send.
        {!voice.saved && " This browser couldn't save these choices, so they last for this visit."}
      </GroupNote>
    </>
  );
}
