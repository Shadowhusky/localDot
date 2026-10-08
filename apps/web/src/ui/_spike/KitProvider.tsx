import { CSPProvider } from "@base-ui/react/csp-provider";
import { Toast } from "@base-ui/react/toast";
import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

// The page CSP has no style-src exception, so Base UI must not render its own <style> elements.
// The one rule they carried (hiding a Select list's scrollbar) lives in the kit stylesheet.
export function KitProvider({ children }: { children: ReactNode }) {
  return (
    <CSPProvider disableStyleElements>
      <Tooltip.Provider delay={500}>
        <Toast.Provider>{children}</Toast.Provider>
      </Tooltip.Provider>
    </CSPProvider>
  );
}
