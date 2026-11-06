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
import { Button } from "../ui/Button.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Popover } from "../ui/Popover.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { Sheet } from "../ui/Sheet.tsx";

const NONE = "none";

const WEAR_NAMES: Record<Wearable, string> = {
  hoodie: "Hoodie",
  cap: "Cap",
  sunglasses: "Shades",
  bow: "Bow",
  "star-pin": "Star",
  headphones: "Headset",
  mustache: "Mustache",
  suit: "Suit",
  mortarboard: "Grad cap",
  "round-glasses": "Glasses",
  beret: "Beret",
  scarf: "Scarf",
  beanie: "Beanie",
  "party-hat": "Party hat",
  crown: "Crown",
  "wizard-hat": "Wizard hat",
  "top-hat": "Top hat",
  "chef-hat": "Chef's hat",
  "hard-hat": "Hard hat",
  sprout: "Sprout",
  "flower-crown": "Flowers",
  antenna: "Antenna",
  "cat-ears": "Cat ears",
  halo: "Halo",
  "viking-helmet": "Viking",
  "cowboy-hat": "Cowboy hat",
  "propeller-cap": "Propeller",
  headband: "Headband",
  monocle: "Monocle",
  "heart-glasses": "Hearts",
  "clown-nose": "Red nose",
  blush: "Blush",
  "bow-tie": "Bow tie",
  medal: "Medal",
  pearls: "Pearls",
  "striped-tee": "Stripes",
  overalls: "Overalls",
  lei: "Lei",
};

const SLOT_NAMES: Record<WearSlot, string> = { head: "Head", face: "Face", body: "Body" };

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
      <Sheet open={!!entry} onClose={onClose} title="Change look" side="bottom" doneLabel="Done">
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
      title="Change look"
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
            Surprise me
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabledReason={own ? undefined : "This is the look it started with."}
            onClick={() => choose(null)}
          >
            Reset
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
                    label: "None",
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
