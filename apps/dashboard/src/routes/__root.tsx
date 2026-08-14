import type { ComponentType } from "react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import {
  createRootRoute,
  Link,
  type LinkProps,
  Navigate,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { Activity, FlaskConical, ListChecks, LogOut, Server, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const Route = createRootRoute({ component: RootComponent });

function LoadingScreen() {
  return (
    <div className="grid min-h-screen place-items-center bg-background">
      <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
        <span className="status-pulse size-2 rounded-full bg-primary" />
        Connecting to EraInfra
      </div>
    </div>
  );
}

const railItemClass =
  "group relative grid size-10 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-secondary-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40";

const railActiveClass =
  "bg-accent text-foreground before:absolute before:-left-[7px] before:h-5 before:w-0.5 before:rounded-full before:bg-primary";

type NavItem = { to: LinkProps["to"]; label: string; icon: ComponentType<{ className?: string }> };

const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Machines", icon: Server },
  { to: "/attempts", label: "Runs", icon: Activity },
  { to: "/experiments", label: "Experiments", icon: FlaskConical },
];

// Kept reachable but visually demoted below the separator: the webhook runner
// path is on its way out, and the rail should say so before a page does.
const LEGACY_NAV: NavItem[] = [{ to: "/jobs", label: "Legacy jobs", icon: ListChecks }];

function RailLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={item.to}
          activeOptions={item.to === "/" ? { exact: true } : undefined}
          aria-label={item.label}
          className={railItemClass}
          activeProps={{ className: railActiveClass }}
        >
          <Icon className="size-[17px]" />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function RootComponent() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const pathname = useLocation({ select: (location) => location.pathname });
  const isLogin = pathname === "/login";

  if (isLoading) return <LoadingScreen />;
  if (!isAuthenticated && !isLogin) return <Navigate to="/login" replace />;
  if (isAuthenticated && isLogin) return <Navigate to="/" replace />;
  if (isLogin) return <Outlet />;

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background">
        <aside className="fixed inset-y-0 left-0 z-40 flex w-14 flex-col items-center border-r border-border bg-card py-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/"
                aria-label="EraInfra"
                className="grid size-9 place-items-center rounded-md border border-border bg-secondary font-mono text-[11px] font-semibold tracking-[-0.04em] text-foreground outline-none transition-colors duration-150 hover:border-input focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                EI
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">EraInfra</TooltipContent>
          </Tooltip>

          <nav className="mt-6 flex flex-col gap-1.5" aria-label="Primary navigation">
            {PRIMARY_NAV.map((item) => (
              <RailLink key={item.label} item={item} />
            ))}
            <Separator className="my-1.5 w-6 self-center" />
            {LEGACY_NAV.map((item) => (
              <RailLink key={item.label} item={item} />
            ))}
          </nav>

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Account"
              className={cn(railItemClass, "mt-auto data-[state=open]:bg-accent")}
            >
              <UserRound className="size-[17px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" className="min-w-48">
              <DropdownMenuLabel className="text-muted-foreground">
                Signed in to this deployment
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void signOut()}>
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </aside>

        <div className="pl-14">
          <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
