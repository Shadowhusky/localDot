import { type ComponentType, lazy, useState } from "react";

const screens = new Set<() => Promise<void>>();

// A screen that loads apart from the app: the first time it is wanted, or ahead once the app is up.
// Once loaded it renders at once; one wanted before then waits under the nearest Suspense, and stays
// that same component for as long as it is shown.
export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | undefined;
  const preload = () =>
    load().then((screen) => {
      loaded = screen;
    });
  screens.add(preload);
  const Waiting = lazy(() => preload().then(() => ({ default: loaded as ComponentType<P> })));
  function Screen(props: P) {
    const [Shown] = useState<ComponentType<P>>(() => loaded ?? Waiting);
    return <Shown {...props} />;
  }
  return Object.assign(Screen, { preload });
}

// Every screen loaded, as a test needs before it renders the app.
export async function preloadScreens(): Promise<void> {
  await Promise.all([...screens].map((preload) => preload()));
}
