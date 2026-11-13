import * as React from "react";

const PortalContainerContext = React.createContext<React.RefObject<HTMLElement | null> | undefined>(
  undefined,
);

/**
 * The element that Era popups (dialogs, menus, tooltips, toasts) portal into.
 * Inside an `EraRoot` it is the root's own portal slot, so popups keep the
 * Era tokens and the host page's styles never reach them. Elsewhere it is
 * `undefined`, which means `document.body`.
 */
function usePortalContainer(): React.RefObject<HTMLElement | null> | undefined {
  return React.useContext(PortalContainerContext);
}

/** The product whose signal colour fills `--product`. */
type EraProduct = "mesh" | "db" | "infra";

/** Props for {@link EraRoot}. */
type EraRootProps = React.ComponentProps<"div"> & {
  /** Sets `data-product`, and with it `--product`, for everything inside. */
  product?: EraProduct | undefined;
  /** Forces a theme. Leave it out to follow the system and the host page. */
  theme?: "light" | "dark" | undefined;
};

/**
 * The scope root for an Era interface that renders inside someone else's
 * page, such as the embedded EraDB dashboard. It sets `data-era-root`, so the
 * Era tokens and base styles apply only inside it, and it gives popups a
 * portal slot inside the scope.
 *
 * A whole app does not need it: put `data-era-root` on `<html>` instead.
 * Keep `transform`, `filter` and `contain` off this element, or popups that
 * use fixed positioning are placed relative to it.
 */
function EraRoot({ product, theme, children, ...props }: EraRootProps) {
  const portal = React.useRef<HTMLDivElement>(null);
  return (
    <div data-era-root="" data-slot="era-root" data-product={product} data-theme={theme} {...props}>
      <PortalContainerContext.Provider value={portal}>{children}</PortalContainerContext.Provider>
      <div ref={portal} data-slot="era-portal" />
    </div>
  );
}

export { EraRoot, usePortalContainer, type EraProduct, type EraRootProps };
