import { useState } from "react";
import {
  chooseLocale,
  deviceLocale,
  LOCALE_NAMES,
  LOCALES,
  type LocaleChoice,
  localeChoice,
  t,
} from "../i18n/index.ts";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { Select } from "../ui/Select.tsx";

// The app's language on this device. Each language is named in its own words, so it can be found
// whatever the app is showing now; System follows the device. Choosing reloads the page.
export function LanguageSetting() {
  const [chosen] = useState(localeChoice);
  const [unsaved, setUnsaved] = useState(false);
  const items = [
    { value: "system", label: t`System (${LOCALE_NAMES[deviceLocale()]})` },
    ...LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })),
  ];
  return (
    <div>
      <GroupHead title={t`Language`} />
      <Group>
        <GroupRow
          label={t`Language`}
          trailing={
            <Select
              appearance="inline"
              aria-label={t`Language`}
              value={chosen}
              items={items}
              onValueChange={(value) => {
                if (value !== chosen) setUnsaved(!chooseLocale(value as LocaleChoice));
              }}
            />
          }
        />
      </Group>
      <GroupNote>
        {unsaved
          ? t`This browser couldn't save it. Try again in a normal window.`
          : t`Just for this device. dot answers in the language you write to it in.`}
      </GroupNote>
    </div>
  );
}
