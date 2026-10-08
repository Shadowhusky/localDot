import { z } from "zod";

// Lifecycle-only: the model cannot supply a profile path or a browser command.
export const DesktopBrowserTask = z.strictObject({
  taskId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
});
export const DesktopBrowserReady = DesktopBrowserTask.extend({
  generation: z.string().regex(/^[0-9a-f]{32}$/),
});
