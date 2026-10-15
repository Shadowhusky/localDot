import type { LocalDotLink } from "@localdot/protocol";
import { useState } from "react";
import { localDotHost, localDotOrigin, localDotProblem } from "../shell/local-dots.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { TextField } from "../ui/TextField.tsx";

// The user's other localDots, which the localDot menu opens: each by name at its own address.
export function OtherLocalDots({
  links,
  onChange,
}: {
  links: readonly LocalDotLink[];
  onChange(links: LocalDotLink[]): void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [tried, setTried] = useState(false);
  const problem = localDotProblem(address, links, window.location.origin);
  const add = () => {
    setTried(true);
    const url = localDotOrigin(address);
    if (problem || !url) return;
    onChange([...links, { name: name.trim() || localDotHost(url), url }]);
    setName("");
    setAddress("");
    setTried(false);
  };
  return (
    <div>
      <GroupHead title="Your other localDots" />
      <Group>
        {links.map((link) => (
          <GroupRow
            key={link.url}
            label={link.name}
            detail={localDotHost(link.url)}
            trailing={
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Remove ${link.name}`}
                onClick={() => onChange(links.filter((other) => other.url !== link.url))}
              >
                Remove
              </Button>
            }
          />
        ))}
        <Field label="Name" inline className="ui-group-row">
          <TextField
            size="sm"
            value={name}
            maxLength={40}
            placeholder="Office PC"
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Address"
          inline
          className="ui-group-row"
          error={tried && address ? (problem ?? undefined) : undefined}
        >
          <TextField
            size="sm"
            value={address}
            maxLength={512}
            placeholder="office-pc.example.ts.net:4750"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="url"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
            }}
          />
        </Field>
        <GroupRow
          label="Add this localDot"
          trailing={
            <Button
              size="sm"
              disabledReason={address ? undefined : "Enter its address"}
              onClick={add}
            >
              Add
            </Button>
          }
        />
      </Group>
      <GroupNote>
        Switch to one from the localDot menu at the top left. The first time, sign in there with a
        link from that computer.
      </GroupNote>
    </div>
  );
}
