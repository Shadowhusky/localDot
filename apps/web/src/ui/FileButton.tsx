import { useRef } from "react";
import { Button, type ButtonProps } from "./Button.tsx";
import { IconButton, type IconButtonProps } from "./IconButton.tsx";

interface Chooser {
  onFiles(files: FileList): void;
  multiple?: boolean;
  accept?: string;
}

// The system's file chooser behind a button. The file input it drives is never drawn.
function useChooser({ onFiles, multiple = false, accept }: Chooser) {
  const input = useRef<HTMLInputElement>(null);
  const field = (
    <input
      ref={input}
      type="file"
      hidden
      tabIndex={-1}
      multiple={multiple}
      accept={accept}
      onChange={(event) => {
        const chosen = event.currentTarget;
        if (chosen.files?.length) onFiles(chosen.files);
        chosen.value = "";
      }}
    />
  );
  return { open: () => input.current?.click(), field };
}

export interface FileButtonProps extends Omit<IconButtonProps, "onClick" | "type">, Chooser {}

// An icon button that opens the system's file chooser.
export function FileButton({ onFiles, multiple, accept, ...props }: FileButtonProps) {
  const chooser = useChooser({ onFiles, multiple, accept });
  return (
    <>
      <IconButton {...props} onClick={chooser.open} />
      {chooser.field}
    </>
  );
}

export interface ChooseFileButtonProps extends Omit<ButtonProps, "onClick" | "type">, Chooser {}

// A button with words, such as "Choose a file", that opens the system's file chooser.
export function ChooseFileButton({ onFiles, multiple, accept, ...props }: ChooseFileButtonProps) {
  const chooser = useChooser({ onFiles, multiple, accept });
  return (
    <>
      <Button {...props} onClick={chooser.open} />
      {chooser.field}
    </>
  );
}
