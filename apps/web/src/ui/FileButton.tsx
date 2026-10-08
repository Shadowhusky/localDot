import { useRef } from "react";
import { IconButton, type IconButtonProps } from "./IconButton.tsx";

export interface FileButtonProps extends Omit<IconButtonProps, "onClick" | "type"> {
  onFiles(files: FileList): void;
  multiple?: boolean;
  accept?: string;
}

// An icon button that opens the system's file chooser. The file input it drives is never drawn.
export function FileButton({ onFiles, multiple = false, accept, ...props }: FileButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton {...props} onClick={() => input.current?.click()} />
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
    </>
  );
}
