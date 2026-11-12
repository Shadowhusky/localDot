import {
  type ConversationEntry,
  type LookWearables,
  taskOutfit,
  WEAR_SLOT,
  WEAR_SLOTS,
  Wearable,
  type WearSlot,
} from "@localdot/protocol";
import { type RefObject, useRef, useState } from "react";
import { conversationLook, lookSeed } from "../agent/conversation-list.ts";
import { Dot } from "../dot/Dot.tsx";
import { DotAvatar } from "../dot/DotAvatar.tsx";
import { t, tc, tr } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Popover } from "../ui/Popover.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { Sheet } from "../ui/Sheet.tsx";

const NONE = "none";

const WEAR_NAMES: Record<Wearable, string> = {
  hoodie: tr("Hoodie"),
  cap: tr("Cap"),
  sunglasses: tr("Shades"),
  bow: tr("Bow"),
  "star-pin": tr("Star"),
  headphones: tr("Headset"),
  mustache: tr("Mustache"),
  suit: tr("Suit"),
  mortarboard: tr("Grad cap"),
  "round-glasses": tr("Glasses"),
  beret: tr("Beret"),
  scarf: tr("Scarf"),
  beanie: tr("Beanie"),
  "party-hat": tr("Party hat"),
  crown: tr("Crown"),
  "wizard-hat": tr("Wizard hat"),
  "top-hat": tr("Top hat"),
  "chef-hat": tr("Chef's hat"),
  "hard-hat": tr("Hard hat"),
  sprout: tr("Sprout"),
  "flower-crown": tr("Flowers"),
  antenna: tr("Antenna"),
  "cat-ears": tr("Cat ears"),
  halo: tr("Halo"),
  "viking-helmet": tr("Viking"),
  "cowboy-hat": tr("Cowboy hat"),
  "propeller-cap": tr("Propeller"),
  headband: tr("Headband"),
  monocle: tr("Monocle"),
  "heart-glasses": tr("Hearts"),
  "clown-nose": tr("Red nose"),
  blush: tr("Blush"),
  "bow-tie": tr("Bow tie"),
  medal: tr("Medal"),
  pearls: tr("Pearls"),
  "striped-tee": tr("Stripes"),
  overalls: tr("Overalls"),
  lei: tr("Lei"),
};

const SLOT_NAMES: Record<WearSlot, string> = {
  head: tr("Head"),
  face: tr("Face"),
  body: tr("Body"),
};

const inSlot = (slot: WearSlot) => Wearable.options.filter((name) => WEAR_SLOT[name] === slot);

// Dresses a conversation's dot, one thing for each place. A choice is saved at once, as a tag is;
// Reset gives the conversation back the look it started with.
export function LookChooser({
  entry,
  anchor,
  onChange,
  onClose,
}: {
  // The conversation being dressed; open while there is one.
  entry: ConversationEntry | null;
  anchor: RefObject<HTMLElement | null>;
  onChange(entry: ConversationEntry, look: LookWearables | null): void;
  onClose(): void;
}) {
  const phone = useMediaQuery(PHONE);
  const body = entry && <LookPanel key={entry.sessionId} entry={entry} onChange={onChange} />;
  if (phone)
    return (
      <Sheet
        open={!!entry}
        onClose={onClose}
        title={t`Change look`}
        side="bottom"
        doneLabel={t`Done`}
      >
        {body}
      </Sheet>
    );
  return (
    <Popover
      open={!!entry}
      onClose={onClose}
      anchor={anchor}
      side="right"
      align="start"
      title={t`Change look`}
      size="lg"
    >
      {body}
    </Popover>
  );
}

function LookPanel({
  entry,
  onChange,
}: {
  entry: ConversationEntry;
  onChange(entry: ConversationEntry, look: LookWearables | null): void;
}) {
  const [look, setLook] = useState<readonly Wearable[]>(() => conversationLook(entry));
  const [own, setOwn] = useState(!!entry.look);
  const shuffles = useRef(0);
  const seed = lookSeed(entry);
  const { look: _own, ...drawn } = entry;
  const dot = entry.live?.persona ?? entry.persona;
  const choose = (next: LookWearables | null) => {
    setLook(next ?? conversationLook(drawn));
    setOwn(next !== null);
    onChange(entry, next);
  };
  return (
    <div className="look-chooser">
      <div className="look-preview">
        <Dot size={72} wearables={look} seed={7} />
        <div className="look-actions">
          <Button
            size="sm"
            onClick={() => {
              shuffles.current += 1;
              choose(taskOutfit(`${seed}:${shuffles.current}:${Date.now()}`, dot));
            }}
          >
            {t`Surprise me`}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabledReason={own ? undefined : t`This is the look it started with.`}
            onClick={() => choose(null)}
          >
            {tc("button", "Reset")}
          </Button>
        </div>
      </div>
      <div className="look-choices">
        {WEAR_SLOTS.map((slot) => {
          const worn = look.find((name) => WEAR_SLOT[name] === slot);
          return (
            <div key={slot}>
              <div className="look-group-name">{SLOT_NAMES[slot]}</div>
              <RadioCards
                layout="tiles"
                compact
                aria-label={SLOT_NAMES[slot]}
                value={worn ?? NONE}
                onValueChange={(next) => {
                  const others = look.filter((name) => WEAR_SLOT[name] !== slot);
                  const parsed = Wearable.safeParse(next);
                  choose(parsed.success ? [...others, parsed.data] : others);
                }}
                options={[
                  {
                    value: NONE,
                    label: t`None`,
                    preview: (
                      <span className="look-tile">
                        <DotAvatar size={40} wearables={[]} />
                      </span>
                    ),
                  },
                  ...inSlot(slot).map((name) => ({
                    value: name,
                    label: WEAR_NAMES[name],
                    preview: (
                      <span className="look-tile">
                        <DotAvatar size={40} wearables={[name]} />
                      </span>
                    ),
                  })),
                ]}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
