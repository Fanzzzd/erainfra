import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { createRootRoute, Link, Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { ListChecks, LogOut, Server } from "lucide-react";

export const Route = createRootRoute({ component: RootComponent });

function LoadingScreen() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#0a0a0b]">
      <div className="flex items-center gap-3 text-sm text-zinc-400" role="status">
        <span className="status-pulse size-2 rounded-full bg-emerald-400" />
        Connecting to Runner Center
      </div>
    </div>
  );
}

const navItemClass =
  "group relative grid size-10 place-items-center rounded-md text-[#8a8a93] outline-none transition-colors duration-150 hover:bg-white/[0.05] hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-400/80";

function NavLabel({ children }: { children: string }) {
  return (
    <span className="pointer-events-none absolute left-12 z-50 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#18181b] px-2 py-1 text-xs font-medium text-zinc-200 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
      {children}
    </span>
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
    <div className="min-h-screen bg-[#0a0a0b]">
      <aside className="fixed inset-y-0 left-0 z-40 flex w-14 flex-col items-center border-r border-white/[0.08] bg-[#0d0d0f] py-3">
        <Link
          to="/"
          aria-label="Runner Center"
          className="group relative grid size-9 place-items-center rounded-md border border-white/[0.1] bg-white/[0.035] font-mono text-[11px] font-semibold tracking-[-0.04em] text-zinc-100 outline-none transition-colors duration-150 hover:border-white/[0.16] focus-visible:ring-2 focus-visible:ring-emerald-400/80"
        >
          RC
          <NavLabel>Runner Center</NavLabel>
        </Link>

        <nav className="mt-6 flex flex-col gap-1.5" aria-label="Primary navigation">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            aria-label="Machines"
            className={navItemClass}
            activeProps={{
              className:
                "bg-white/[0.07] text-zinc-100 before:absolute before:-left-[7px] before:h-5 before:w-0.5 before:rounded-full before:bg-emerald-400",
            }}
          >
            <Server className="size-[17px]" />
            <NavLabel>Machines</NavLabel>
          </Link>
          <Link
            to="/jobs"
            aria-label="Jobs"
            className={navItemClass}
            activeProps={{
              className:
                "bg-white/[0.07] text-zinc-100 before:absolute before:-left-[7px] before:h-5 before:w-0.5 before:rounded-full before:bg-emerald-400",
            }}
          >
            <ListChecks className="size-[17px]" />
            <NavLabel>Jobs</NavLabel>
          </Link>
        </nav>

        <button
          type="button"
          aria-label="Sign out"
          className={`${navItemClass} mt-auto`}
          onClick={() => void signOut()}
        >
          <LogOut className="size-[17px]" />
          <NavLabel>Sign out</NavLabel>
        </button>
      </aside>

      <div className="pl-14">
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
