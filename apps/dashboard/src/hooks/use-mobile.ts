import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/** The media query list, or null where there is no `matchMedia`, as in jsdom or on a server. */
function mediaQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const media = mediaQuery();
  if (!media) return () => {};
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isMobileNow(): boolean {
  return mediaQuery()?.matches ?? false;
}

function isMobileOnServer(): boolean {
  return false;
}

/**
 * Whether the viewport is narrower than 768px, Tailwind's `md` breakpoint.
 * It reads `matchMedia` through `useSyncExternalStore`, so it is correct on
 * the first client render. During server rendering, and where `matchMedia`
 * is missing (jsdom, for example), it reports `false`: the desktop layout.
 */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, isMobileNow, isMobileOnServer);
}
