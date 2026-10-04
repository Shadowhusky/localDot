import { useEffect, useLayoutEffect, useRef } from "react";
export function useStopHotkey(stop: () => void, enabled: boolean) {
  const current = useRef({ stop, enabled });
  useLayoutEffect(() => {
    current.current = { stop, enabled };
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        !current.current.enabled ||
        event.altKey ||
        !event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        !(event.code === "Period" || event.key === "." || event.key === ">")
      )
        return;
      event.preventDefault();
      current.current.stop();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
}
