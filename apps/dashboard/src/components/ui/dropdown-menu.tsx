import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Fragment, type ComponentProps, type ReactNode } from "react";

import { asChildElement } from "@/components/ui/slot";
import { cn } from "@/lib/utils";

function DropdownMenu(props: ComponentProps<typeof Menu>) {
  return <Menu {...props} />;
}

/** ui-sdk menus open in the browser's top layer, so there is no portal to render into. */
function DropdownMenuPortal({ children }: { children?: ReactNode }) {
  return <Fragment>{children}</Fragment>;
}

/** `asChild` makes the single child element the trigger. */
function DropdownMenuTrigger({
  asChild = false,
  children,
  ...props
}: ComponentProps<typeof MenuTrigger> & { asChild?: boolean }) {
  const child = asChildElement(asChild, children);
  if (child) return <MenuTrigger render={child} {...props} />;
  return <MenuTrigger {...props}>{children}</MenuTrigger>;
}

function DropdownMenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof MenuContent>) {
  return (
    <MenuContent
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-y-auto rounded-md border border-border bg-popover p-1 text-left text-(length:--era-text-md) font-normal normal-case tracking-normal text-popover-foreground shadow-popup transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuGroup(props: ComponentProps<typeof MenuGroup>) {
  return <MenuGroup {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ComponentProps<typeof MenuItem> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuItem
      data-inset={inset}
      destructive={variant === "destructive"}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-(length:--era-text-md) text-foreground data-highlighted:bg-sunken data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:pl-8 data-destructive:text-destructive data-destructive:data-highlighted:bg-destructive-soft [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** A heading inside the menu. It is not an item, so the arrow keys skip it. */
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentProps<"div"> & { inset?: boolean }) {
  return (
    <div
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-(length:--era-text-sm) font-medium data-inset:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuSeparator>) {
  return <MenuSeparator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto text-[10px] tracking-widest text-subtle-foreground", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
};
