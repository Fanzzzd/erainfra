import * as React from "react";

import { ProductWordmark } from "@/components/product-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import type { EraProduct } from "@/lib/era-root";
import { cn } from "@/lib/utils";

/**
 * `viewport`: a full-page app. The sidebar is fixed, collapses off canvas and
 * becomes a sheet on small screens; the shell renders `<main>` and a skip link.
 *
 * `contained`: the shell fills its parent, such as an `AppWindow` on a
 * marketing page or a host app's panel. The sidebar is a static column, the
 * main area is a `div`, and the Cmd+B shortcut is off.
 */
type AppShellLayout = "viewport" | "contained";

type AppShellContextValue = { product: EraProduct; layout: AppShellLayout; contentId: string };

const AppShellContext = React.createContext<AppShellContextValue | null>(null);

function useAppShell(): AppShellContextValue {
  const context = React.useContext(AppShellContext);
  if (!context) throw new Error("AppShell parts must be inside <AppShell>.");
  return context;
}

/** Props for {@link AppShell}. */
type AppShellProps = React.ComponentProps<"div"> & {
  /** The product. It sets `--product` for the active indicator, marks and charts. */
  product: EraProduct;
  layout?: AppShellLayout;
  /** Whether the desktop sidebar starts open. */
  defaultOpen?: boolean;
  /** Controls the desktop sidebar, for example to persist it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * The frame every Era product uses: a sidebar with labelled navigation and a
 * main column with a top bar. Compose it from the parts below so the three
 * products stay identical.
 *
 * @example
 * <AppShell product="infra">
 *   <AppShellSidebar>
 *     <AppShellBrand>acme</AppShellBrand>
 *     <AppShellNav>
 *       <AppShellNavGroup label="CI">
 *         <AppShellNavItem active render={<a href="/runs" />}><ActivityIcon />Runs</AppShellNavItem>
 *       </AppShellNavGroup>
 *     </AppShellNav>
 *   </AppShellSidebar>
 *   <AppShellMain>
 *     <AppShellTopBar>…breadcrumb…<AppShellTopBarActions>…</AppShellTopBarActions></AppShellTopBar>
 *     <AppShellContent>…page…</AppShellContent>
 *   </AppShellMain>
 * </AppShell>
 */
function AppShell({
  product,
  layout = "viewport",
  className,
  style,
  children,
  ...props
}: AppShellProps) {
  const contentId = `era-content-${React.useId().replace(/:/g, "")}`;
  const value = React.useMemo(() => ({ product, layout, contentId }), [product, layout, contentId]);
  return (
    <AppShellContext.Provider value={value}>
      <SidebarProvider
        data-slot="app-shell"
        data-product={product}
        data-layout={layout}
        keyboardShortcut={layout === "contained" ? null : "b"}
        className={cn(layout === "contained" && "h-full min-h-0 overflow-hidden", className)}
        style={{ "--sidebar-width": "15rem", ...style } as React.CSSProperties}
        {...props}
      >
        {layout === "viewport" ? (
          <a
            href={`#${contentId}`}
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg"
          >
            Skip to content
          </a>
        ) : null}
        {children}
      </SidebarProvider>
    </AppShellContext.Provider>
  );
}

/** The sidebar. `label` names the mobile navigation sheet. */
function AppShellSidebar({
  className,
  label = "Navigation",
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { layout } = useAppShell();
  return (
    <Sidebar
      data-slot="app-shell-sidebar"
      label={label}
      collapsible={layout === "contained" ? "none" : "offcanvas"}
      className={cn(layout === "contained" && "border-r", className)}
      {...props}
    />
  );
}

/** The product wordmark at the top of the sidebar. Children show under the name, such as the workspace. */
function AppShellBrand({ className, children, ...props }: React.ComponentProps<"div">) {
  const { product } = useAppShell();
  return (
    <SidebarHeader
      data-slot="app-shell-brand"
      className={cn("h-14 flex-row items-center border-b px-4", className)}
      {...props}
    >
      <ProductWordmark product={product}>
        {children ? (
          <span className="truncate text-xs text-muted-foreground">{children}</span>
        ) : null}
      </ProductWordmark>
    </SidebarHeader>
  );
}

/** The scrolling navigation area, a `nav` landmark named by `label`. */
function AppShellNav({
  className,
  label = "Main",
  children,
  ...props
}: React.ComponentProps<"nav"> & { label?: string }) {
  return (
    <SidebarContent className="gap-0 py-2">
      <nav
        data-slot="app-shell-nav"
        aria-label={label}
        className={cn("flex flex-col", className)}
        {...props}
      >
        {children}
      </nav>
    </SidebarContent>
  );
}

/** A labelled group of items, such as "CI" or "Deploy". The label names the list for screen readers. */
function AppShellNavGroup({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { label?: string }) {
  const id = React.useId();
  return (
    <SidebarGroup data-slot="app-shell-nav-group" className={cn("py-1", className)} {...props}>
      {label ? (
        <SidebarGroupLabel id={id} className="h-7 text-xs font-normal text-muted-foreground">
          {label}
        </SidebarGroupLabel>
      ) : null}
      <SidebarGroupContent>
        <SidebarMenu aria-labelledby={label ? id : undefined}>{children}</SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/**
 * One navigation item: an icon and a label. `active` marks the current page
 * with `aria-current="page"` and the 2px bar in `--product`. Pass your router's
 * link through `render`. On mobile, choosing an item closes the sheet.
 */
function AppShellNavItem({
  active = false,
  className,
  onClick,
  ...props
}: Omit<React.ComponentProps<typeof SidebarMenuButton>, "isActive"> & { active?: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        data-slot="app-shell-nav-item"
        isActive={active}
        className={cn("h-8 text-[13px]", className)}
        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          onClick?.(event);
          if (isMobile) setOpenMobile(false);
        }}
        {...props}
      />
    </SidebarMenuItem>
  );
}

/** The bottom of the sidebar, for items such as Settings. */
function AppShellSidebarFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <SidebarFooter
      data-slot="app-shell-sidebar-footer"
      className={cn("border-t p-2", className)}
      {...props}
    >
      <SidebarMenu>{children}</SidebarMenu>
    </SidebarFooter>
  );
}

/** The main column on the subtle surface: `<main>` in the viewport layout, a `div` when contained. */
function AppShellMain({ className, ...props }: React.ComponentProps<"div">) {
  const { layout } = useAppShell();
  const classes = cn("min-w-0 bg-subtle", className);
  if (layout === "contained") {
    return (
      <div
        data-slot="app-shell-main"
        className={cn("relative flex flex-1 flex-col overflow-hidden", classes)}
        {...props}
      />
    );
  }
  return <SidebarInset data-slot="app-shell-main" className={classes} {...props} />;
}

/** The bar at the top of the main column: the mobile menu button, a breadcrumb and actions. */
function AppShellTopBar({ className, children, ...props }: React.ComponentProps<"header">) {
  const { layout } = useAppShell();
  return (
    <header
      data-slot="app-shell-top-bar"
      className={cn(
        "sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur",
        className,
      )}
      {...props}
    >
      {layout === "viewport" ? <SidebarTrigger className="-ml-1 md:hidden" /> : null}
      {children}
    </header>
  );
}

/** Actions at the right of the top bar, such as Docs and the account menu. */
function AppShellTopBarActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-shell-top-bar-actions"
      className={cn("ml-auto flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  );
}

/** The page area, padded and capped at a readable width. The skip link lands here. */
function AppShellContent({ className, children, ...props }: React.ComponentProps<"div">) {
  const { layout, contentId } = useAppShell();
  return (
    <div
      id={contentId}
      tabIndex={-1}
      data-slot="app-shell-content"
      className={cn(
        "@container flex-1 outline-none",
        layout === "contained" ? "overflow-hidden p-6" : "p-4 sm:p-6 lg:p-8",
        className,
      )}
      {...props}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">{children}</div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Props for {@link AppShellAccountMenu}. */
type AppShellAccountMenuProps = {
  /** The signed-in user's name, shown as initials on the button. */
  name: string;
  /** Shown under the name in the menu. */
  email?: string;
  /** The menu items, such as API tokens and Sign out. */
  children: React.ReactNode;
};

/** The account button and menu for the top bar. */
function AppShellAccountMenu({ name, email, children }: AppShellAccountMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={`Account: ${name}`}
          />
        }
      >
        <span
          aria-hidden="true"
          className="inline-flex size-7 items-center justify-center rounded-full border bg-subtle text-[11px] font-medium"
        >
          {initials(name)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
            <span className="text-sm text-foreground">{name}</span>
            {email ? <span className="truncate">{email}</span> : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export {
  AppShell,
  AppShellAccountMenu,
  AppShellBrand,
  AppShellContent,
  AppShellMain,
  AppShellNav,
  AppShellNavGroup,
  AppShellNavItem,
  AppShellSidebar,
  AppShellSidebarFooter,
  AppShellTopBar,
  AppShellTopBarActions,
  type AppShellAccountMenuProps,
  type AppShellLayout,
  type AppShellProps,
};
