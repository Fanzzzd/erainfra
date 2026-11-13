import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import {
  createRootRoute,
  Link,
  type LinkProps,
  Navigate,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import {
  Activity,
  Boxes,
  FlaskConical,
  Gauge,
  HardDrive,
  Link2,
  Rocket,
  LogOut,
  Server,
  Settings,
  TestTubeDiagonal,
  UserRound,
} from "lucide-react";
import type { ComponentType } from "react";

import { ConfirmDialog } from "@/components/ui/confirm";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Wordmark } from "@/components/wordmark";
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
  "group relative grid size-10 place-items-center rounded-md text-muted-foreground hover:bg-sunken hover:text-foreground";

const railActiveClass =
  "bg-sunken text-foreground before:absolute before:-left-[7px] before:h-5 before:w-0.5 before:rounded-full before:bg-primary";

type NavItem = { to: LinkProps["to"]; label: string; icon: ComponentType<{ className?: string }> };

const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Machines", icon: Server },
  { to: "/attempts", label: "Runs", icon: Activity },
  { to: "/rightsize", label: "Rightsize", icon: Gauge },
  { to: "/tests", label: "Tests", icon: TestTubeDiagonal },
  { to: "/experiments", label: "Experiments", icon: FlaskConical },
  { to: "/settings", label: "Alerts and metrics", icon: Settings },
];

// Infrastructure management: the Apps on Nodes, run from Convex since the Hub's state moved here
// (ADR 0016). A group of its own, so CI and infrastructure read as two surfaces of one product.
const INFRA_NAV: NavItem[] = [
  { to: "/nodes", label: "Nodes", icon: HardDrive },
  { to: "/apps", label: "Apps", icon: Boxes },
  { to: "/deployments", label: "Deployments", icon: Rocket },
  { to: "/links", label: "Links", icon: Link2 },
];

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
        {/* The Era header: a 3px band in the product accent across the full top edge. */}
        <header className="sticky top-0 z-40 flex h-12 items-center border-b border-t-[3px] border-b-border border-t-primary bg-card pl-4 pr-2">
          <Link to="/" className="rounded-sm">
            <Wordmark />
          </Link>

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Account"
              className={cn(
                railItemClass,
                "ml-auto size-(--era-control-height) data-open:bg-sunken",
              )}
            >
              <UserRound className="size-[17px]" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" className="min-w-48">
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
        </header>

        <aside className="fixed bottom-0 left-0 top-12 z-30 flex w-14 flex-col items-center border-r border-border bg-card py-3">
          <nav className="flex flex-col gap-1.5" aria-label="Primary navigation">
            {PRIMARY_NAV.map((item) => (
              <RailLink key={item.label} item={item} />
            ))}
            <Separator className="my-1.5 w-6 self-center" />
            {INFRA_NAV.map((item) => (
              <RailLink key={item.label} item={item} />
            ))}
          </nav>
        </aside>

        <div className="pl-14">
          <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>
      <Toaster />
      <ConfirmDialog />
    </TooltipProvider>
  );
}
