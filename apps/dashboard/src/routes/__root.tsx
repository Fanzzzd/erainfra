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
  ActivityIcon,
  BookOpenIcon,
  BoxesIcon,
  FlaskConicalIcon,
  GaugeIcon,
  LinkIcon,
  LogOutIcon,
  RocketIcon,
  ServerIcon,
  SettingsIcon,
  TestTubeDiagonalIcon,
  WaypointsIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import {
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
} from "@/components/app-shell";
import { StatusDot } from "@/components/status";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DropdownMenuGroup, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { convexDeploymentName } from "@/lib/convex-site";

export const Route = createRootRoute({ component: RootComponent });

const DOCS_URL = "https://github.com/Fanzzzd/erainfra#readme";

type NavItem = {
  to: LinkProps["to"] & string;
  label: string;
  icon: ComponentType;
};

type NavGroup = { label: string; items: NavItem[] };

// CI runs jobs on Machines; Deploy runs Apps on Nodes from Convex since the Hub's state moved
// here (ADR 0016). Two groups, so they read as two surfaces of one product.
const NAV: NavGroup[] = [
  {
    label: "CI",
    items: [
      { to: "/", label: "Machines", icon: ServerIcon },
      { to: "/attempts", label: "Runs", icon: ActivityIcon },
      { to: "/rightsize", label: "Rightsize", icon: GaugeIcon },
      { to: "/tests", label: "Tests", icon: TestTubeDiagonalIcon },
      { to: "/experiments", label: "Experiments", icon: FlaskConicalIcon },
    ],
  },
  {
    label: "Deploy",
    items: [
      { to: "/nodes", label: "Nodes", icon: WaypointsIcon },
      { to: "/apps", label: "Apps", icon: BoxesIcon },
      { to: "/deployments", label: "Deployments", icon: RocketIcon },
      { to: "/links", label: "Links", icon: LinkIcon },
    ],
  },
];

const SETTINGS: NavItem = { to: "/settings", label: "Settings", icon: SettingsIcon };

const ALL_ITEMS = [...NAV.flatMap((group) => group.items), SETTINGS];

/** The nav item a path belongs to. A Run's detail page belongs to Runs. */
function itemForPath(pathname: string): NavItem | undefined {
  if (pathname.startsWith("/attempts/")) return ALL_ITEMS.find((item) => item.to === "/attempts");
  return ALL_ITEMS.find((item) => item.to === pathname);
}

function LoadingScreen() {
  return (
    <div className="grid min-h-screen place-items-center bg-background">
      <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
        <StatusDot tone="product" pulse />
        Connecting to EraInfra
      </div>
    </div>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  return (
    <AppShellNavItem active={itemForPath(pathname) === item} render={<Link to={item.to} />}>
      <Icon />
      <span>{item.label}</span>
    </AppShellNavItem>
  );
}

function TopBarBreadcrumb({ pathname, workspace }: { pathname: string; workspace: string }) {
  const item = itemForPath(pathname);
  const detail = pathname.startsWith("/attempts/");
  return (
    <Breadcrumb className="min-w-0 flex-1">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="min-w-0 truncate">{workspace}</BreadcrumbItem>
        <BreadcrumbSeparator />
        {item === undefined ? null : detail ? (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to={item.to} />}>{item.label}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate">Run</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : (
          <BreadcrumbItem>
            <BreadcrumbPage>{item.label}</BreadcrumbPage>
          </BreadcrumbItem>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function RootComponent() {
  return (
    <TooltipProvider>
      <RootContent />
      <Toaster />
    </TooltipProvider>
  );
}

function RootContent() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const pathname = useLocation({ select: (location) => location.pathname });
  const isLogin = pathname === "/login";
  const workspace = convexDeploymentName();

  if (isLoading) return <LoadingScreen />;
  if (!isAuthenticated && !isLogin) return <Navigate to="/login" replace />;
  if (isAuthenticated && isLogin) return <Navigate to="/" replace />;
  if (isLogin) return <Outlet />;

  return (
    <AppShell product="infra">
      <AppShellSidebar label="EraInfra navigation">
        <AppShellBrand>{workspace}</AppShellBrand>
        <AppShellNav>
          {NAV.map((group) => (
            <AppShellNavGroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <NavLink key={item.to} item={item} pathname={pathname} />
              ))}
            </AppShellNavGroup>
          ))}
        </AppShellNav>
        <AppShellSidebarFooter>
          <NavLink item={SETTINGS} pathname={pathname} />
        </AppShellSidebarFooter>
      </AppShellSidebar>
      <AppShellMain>
        <AppShellTopBar>
          <TopBarBreadcrumb pathname={pathname} workspace={workspace} />
          <AppShellTopBarActions>
            <Button
              variant="ghost"
              size="sm"
              className="hidden text-muted-foreground sm:inline-flex"
              render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}
              nativeButton={false}
            >
              <BookOpenIcon data-icon="inline-start" />
              Docs
            </Button>
            <AppShellAccountMenu name="Operator" email="Signed in to this deployment">
              <DropdownMenuGroup>
                <DropdownMenuItem render={<Link to="/settings" />}>
                  <SettingsIcon />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void signOut()}>
                  <LogOutIcon />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </AppShellAccountMenu>
          </AppShellTopBarActions>
        </AppShellTopBar>
        <AppShellContent>
          <Outlet />
        </AppShellContent>
      </AppShellMain>
    </AppShell>
  );
}
