import { UNLOCK_PRIVACY, UnlockKeys } from "../keys/UnlockKeys.tsx";
import { Button } from "../ui/Button.tsx";

// In the conversation where a task met locked saved keys: the passphrase goes here, never into
// the chat, and dot carries on by itself once they open. Keys holds the same form and the rest.
export function KeysLockedCard({
  setup,
  unlock,
  onOpenKeys,
}: {
  setup: boolean;
  unlock(passphrase: string): Promise<unknown>;
  onOpenKeys(trigger: HTMLButtonElement): void;
}) {
  return (
    <section className="thread-recovery" aria-labelledby="keys-locked-title">
      <h3 id="keys-locked-title" className="thread-recovery-title">
        {setup ? "Choose a passphrase for your saved keys" : "Unlock your saved keys"}
      </h3>
      <p className="thread-recovery-text">
        {setup
          ? "dot needs your saved keys and passwords, and they need a passphrase first. You'll enter it after each restart of the computer running localDot."
          : "dot needs your saved keys and passwords, which lock each time the computer running localDot restarts. Unlock them and dot carries on by itself."}
      </p>
      <UnlockKeys
        setup={setup}
        unlock={unlock}
        label={setup ? "Choose a passphrase" : "Unlock saved keys"}
        actions={
          <Button
            variant="quiet"
            icon="key-round"
            onClick={(event) => onOpenKeys(event.currentTarget)}
          >
            Open Keys
          </Button>
        }
      />
      <p className="thread-recovery-reason">{UNLOCK_PRIVACY}</p>
    </section>
  );
}
