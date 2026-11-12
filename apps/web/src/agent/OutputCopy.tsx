import { keyLikePresent } from "@localdot/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";

export function OutputCopy({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const owner = useRef({ text, label, epoch: 0, mounted: true });
  useLayoutEffect(() => {
    owner.current.epoch++;
    Object.assign(owner.current, { text, label });
    setStatus(null);
  }, [text, label]);
  useEffect(() => {
    owner.current.mounted = true;
    return () => {
      owner.current.mounted = false;
      owner.current.epoch++;
    };
  }, []);
  const blocked = !text || keyLikePresent(text);
  return (
    <span className="output-copy">
      <Button
        variant="quiet"
        size="sm"
        disabledReason={
          !text ? t`Nothing to copy.` : blocked ? t`Select a shorter excerpt to copy.` : undefined
        }
        onClick={() => {
          if (!text || keyLikePresent(text)) return;
          const epoch = owner.current.epoch;
          if (!navigator.clipboard?.writeText) {
            setStatus(t`Copy isn't available in this browser.`);
            return;
          }
          void navigator.clipboard.writeText(text).then(
            () => {
              if (owner.current.mounted && owner.current.epoch === epoch) setStatus(t`Copied`);
            },
            () => {
              if (owner.current.mounted && owner.current.epoch === epoch)
                setStatus(t`Couldn't copy the text.`);
            },
          );
        }}
      >
        {label}
      </Button>
      <span role="status" className="output-copy-status">
        {status}
      </span>
    </span>
  );
}
