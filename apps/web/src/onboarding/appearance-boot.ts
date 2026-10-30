import { showAppearance, storedAppearance, tintChrome } from "./appearance.ts";

// Built as a classic script ahead of the stylesheets and the app (vite.config.ts), so the page opens
// in the chosen appearance; the chrome takes the void on the first frame the stylesheet is in.
showAppearance(storedAppearance());
const tint = () => {
  if (!tintChrome()) requestAnimationFrame(tint);
};
requestAnimationFrame(tint);
