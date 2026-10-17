import type { KeyMetadata } from "@localdot/protocol";
import { useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Field } from "../ui/Field.tsx";
import { TextField } from "../ui/TextField.tsx";
import { type KeyRecord, problemText } from "./keys-api.ts";
export function KeyMetadataEditor({
  record,
  save,
  close,
}: {
  record: KeyRecord;
  save(id: string, metadata: KeyMetadata): Promise<void>;
  close(): void;
}) {
  const [metadata, set] = useState<KeyMetadata>(record.metadata ?? {}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Card>
      <form
        className="keys-form"
        aria-label={`Details for ${record.id}`}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          try {
            await save(record.id, metadata);
            close();
          } catch (err) {
            setError(problemText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Help dot choose when to use <strong>{record.id}</strong>. Its secret and destination stay
          the same.
        </p>
        {(
          [
            ["label", "Name", 80],
            ["service", "Service", 80],
            ["description", "Use for", 600],
          ] as const
        ).map(([key, label, max]) => (
          <Field key={key} label={label}>
            <TextField
              value={metadata[key] ?? ""}
              maxLength={max}
              readOnly={busy}
              onChange={(e) => set({ ...metadata, [key]: e.target.value })}
            />
          </Field>
        ))}
        {error && <p role="alert">{error}</p>}
        <div className="keys-actions">
          <Button variant="quiet" onClick={close} disabledReason={busy ? "Saving" : undefined}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save details
          </Button>
        </div>
      </form>
    </Card>
  );
}
