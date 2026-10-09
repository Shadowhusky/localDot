import { PHONE, useMediaQuery } from "../ui/media.ts";

// Wide: the stage beside both rails. Laptop: the stage beside one rail that switches between Chat
// and Activity. Tablet: the stage over that rail. Phone: the stage over the thread.
export type Layout = "wide" | "laptop" | "tablet" | "phone";

export function useLayout(): Layout {
  const wide = useMediaQuery("(width >= 1880px)");
  const laptop = useMediaQuery("(width >= 1100px)");
  const phone = useMediaQuery(PHONE);
  return wide ? "wide" : laptop ? "laptop" : phone ? "phone" : "tablet";
}
