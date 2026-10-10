import { Sheet } from "../ui/Sheet.tsx";
import { TextField } from "../ui/TextField.tsx";

export function SignInLinkSheet({
  link,
  label,
  onClose,
}: {
  link?: string;
  label: string;
  onClose(): void;
}) {
  return (
    <Sheet
      open={!!link}
      onClose={onClose}
      title="Copy sign-in link"
      modal
      description="Copying was blocked. Select and copy this link. It works once and expires in one minute."
    >
      <TextField
        aria-label={label}
        value={link ?? ""}
        readOnly
        onFocus={(event) => event.currentTarget.select()}
      />
    </Sheet>
  );
}
