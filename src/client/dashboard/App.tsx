import type { HostInfo, Me, Overview } from "@shared/types";
import { Eye, LogOut, Moon, RefreshCw, Search, ShieldX, Sun, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { Logo } from "@/components/logo";
import { ConfirmProvider } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { ToastProvider } from "@/components/ui/toast";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { refreshAll, useApi, useDocumentTitle, useLiveState, useNow } from "@/lib/hooks";
import { timeAgo } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./CommandPalette";
import { HostContext } from "./host";
import { NAV } from "./nav";
import { MeContext, useMe } from "./role";
import { IncidentsPage } from "./pages/IncidentsPage";
import { MonitorDetail } from "./pages/monitors/MonitorDetail";
import { MonitorForm } from "./pages/monitors/MonitorForm";
import { MonitorsPage } from "./pages/monitors/MonitorsPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StatusPageEditor } from "./pages/status-pages/StatusPageEditor";
import { StatusPagesPage } from "./pages/status-pages/StatusPagesPage";
import { SystemDetail } from "./pages/systems/SystemDetail";
import { SystemsPage } from "./pages/systems/SystemsPage";

function overallOf(o: Overview | undefined): { cls: string; label: string } {
	if (!o) return { cls: "bg-zinc-400", label: "Loading status…" };
	if (o.systems.down > 0 || o.monitors.down > 0)
		return { cls: "bg-red-500", label: `${o.monitors.down} monitor(s) and ${o.systems.down} system(s) down` };
	if (o.monitors.degraded > 0) return { cls: "bg-amber-500", label: `${o.monitors.degraded} monitor(s) degraded` };
	return { cls: "bg-emerald-500", label: "Everything is up" };
}

/** Refreshes failing for this long: the page is showing old data, say so. */
const STALE_AFTER_MS = 45_000;

/** "Updated 8s ago" in the header; click to refresh everything on screen now. */
function LiveIndicator() {
	const live = useLiveState();
	const now = useNow(1000);
	const [spin, setSpin] = useState(false);
	const stale = live.failingSince != null && now - live.failingSince > STALE_AFTER_MS;
	return (
		<Tooltip content={stale ? "Refreshes are failing: click to retry" : "The page refreshes itself. Click to refresh now."} side="bottom">
			<button
				type="button"
				onClick={() => {
					setSpin(true);
					setTimeout(() => setSpin(false), 800);
					refreshAll();
				}}
				className={cn(
					"hidden h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs tabular-nums hover:bg-accent sm:flex",
					stale ? "text-red-600 dark:text-red-400" : "text-muted-foreground hover:text-foreground",
				)}
			>
				{stale ? <WifiOff className="size-3.5" /> : <RefreshCw className={cn("size-3.5", spin && "animate-spin")} />}
				{live.okAt == null ? "Loading…" : `Updated ${timeAgo(live.okAt, now)}`}
			</button>
		</Tooltip>
	);
}

/** Shown when refreshes keep failing, so old numbers are never mistaken for current ones. */
function StaleBanner() {
	const live = useLiveState();
	const now = useNow(5000);
	if (live.failingSince == null || now - live.failingSince < STALE_AFTER_MS) return null;
	return (
		<div className="border-b border-red-500/30 bg-red-500/10 text-sm text-red-700 dark:text-red-300">
			<div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-6">
				<WifiOff className="size-4 shrink-0" />
				<span>
					Can't reach Richter{live.okAt != null ? `, so this page is showing data from ${timeAgo(live.okAt, now)}` : ""}. Your sign-in may have expired.
				</span>
				<button type="button" onClick={() => window.location.reload()} className="font-medium underline underline-offset-2">
					Reload the page
				</button>
			</div>
		</div>
	);
}

function Header({ onSearch }: { onSearch: () => void }) {
	const [location] = useLocation();
	const { theme, toggle } = useTheme();
	const me = { data: useMe() };
	const overview = useApi<Overview>("/api/admin/overview", { refreshMs: 15_000 });
	const overall = overallOf(overview.data);
	const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

	return (
		<header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
			<div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
				<Link href="/systems" className="flex items-center gap-2 font-semibold tracking-tight">
					<Logo />
					<span className="hidden sm:inline">Richter</span>
				</Link>
				<Tooltip content={overall.label} side="bottom">
					<span className="relative flex size-2.5">
						<span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-40", overall.cls)} />
						<span className={cn("relative inline-flex size-2.5 rounded-full", overall.cls)} />
					</span>
				</Tooltip>
				<nav className="hidden items-center gap-0.5 lg:flex">
					{NAV.map((n) => {
						const active = location === n.href || location.startsWith(`${n.href}/`);
						return (
							<Link
								key={n.href}
								href={n.href}
								className={cn(
									"flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
									active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								<n.icon className="size-4" />
								{"short" in n ? (
									<>
										<span className="2xl:hidden">{n.short}</span>
										<span className="hidden 2xl:inline">{n.label}</span>
									</>
								) : (
									n.label
								)}
							</Link>
						);
					})}
				</nav>
				<div className="ml-auto flex items-center gap-1.5">
					<LiveIndicator />
					<button
						type="button"
						onClick={onSearch}
						className="flex h-8 items-center gap-2 rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
					>
						<Search className="size-4" />
						<span className="hidden md:inline lg:hidden xl:inline">Search…</span>
						<kbd className="hidden whitespace-nowrap rounded border bg-background px-1.5 font-mono text-[10px] md:inline lg:hidden xl:inline">{isMac ? "⌘" : "Ctrl"} K</kbd>
					</button>
					<Tooltip content={theme === "dark" ? "Light mode" : "Dark mode"} side="bottom">
						<button
							type="button"
							onClick={toggle}
							className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
						</button>
					</Tooltip>
					{me.data?.role === "read" && (
						<Tooltip content="You can view everything but not make changes. Ask the owner for Full access." side="bottom">
							<span className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-amber-500/40 bg-amber-500/10 px-2 text-xs font-medium text-amber-700 dark:text-amber-400">
								<Eye className="size-3.5" />
								Read-only
							</span>
						</Tooltip>
					)}
					{me.data && (
						<span
							className={cn("hidden max-w-48 truncate rounded-md border px-2 py-1 text-xs text-muted-foreground sm:inline lg:hidden", me.data.role === "read" ? "2xl:inline" : "xl:inline")}
							title="Cloudflare Access identity"
						>
							{me.data.email}
						</span>
					)}
					<Tooltip content="Log out" side="bottom">
						<a
							href="/cdn-cgi/access/logout"
							className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							<LogOut className="size-4" />
							<span className="hidden sm:inline">Log out</span>
						</a>
					</Tooltip>
				</div>
			</div>
			<nav className="flex gap-1 overflow-x-auto border-t px-3 py-1.5 lg:hidden">
				{NAV.map((n) => {
					const active = location === n.href || location.startsWith(`${n.href}/`);
					return (
						<Link
							key={n.href}
							href={n.href}
							className={cn(
								"flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
								active ? "bg-accent text-foreground" : "text-muted-foreground",
							)}
						>
							<n.icon className="size-3.5" />
							{"short" in n ? n.short : n.label}
						</Link>
					);
				})}
			</nav>
		</header>
	);
}

function NotFound() {
	useDocumentTitle("Not found · Richter");
	return (
		<EmptyState icon={Search} title="Page not found" action={<Link href="/systems" className="text-sm text-primary hover:underline">Go to systems</Link>}>
			The page you are looking for does not exist.
		</EmptyState>
	);
}

/** Edit-only routes: read-only users are sent to `to` instead. */
function FullOnly({ to, children }: { to: string; children: React.ReactNode }) {
	const me = useMe();
	if (!me) return null;
	return me.role === "full" ? <>{children}</> : <Redirect to={to} replace />;
}

function NoAccess({ message }: { message: string }) {
	return (
		<div className="flex min-h-dvh items-center justify-center p-6">
			<EmptyState
				icon={ShieldX}
				title="No access to this dashboard"
				action={<a href="/cdn-cgi/access/logout" className="text-sm text-primary hover:underline">Log out</a>}
			>
				{message}
			</EmptyState>
		</div>
	);
}

export default function DashboardApp({ host }: { host: HostInfo }) {
	const [paletteOpen, setPaletteOpen] = useState(false);
	const me = useApi<Me>("/api/admin/me");
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPaletteOpen((o) => !o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	if (me.error && /isn't on this dashboard's user list/.test(me.error.message)) return <NoAccess message={me.error.message} />;
	return (
		<HostContext.Provider value={host}>
			<MeContext.Provider value={me.data ?? null}>
			<TooltipProvider>
				<ToastProvider>
					<ConfirmProvider>
						<div className="min-h-dvh">
							<Header onSearch={() => setPaletteOpen(true)} />
							<StaleBanner />
							<main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
								<Switch>
									<Route path="/">
										<Redirect to="/systems" replace />
									</Route>
									<Route path="/systems" component={SystemsPage} />
									<Route path="/systems/:id">{(p) => <SystemDetail key={p.id} id={p.id} />}</Route>
									<Route path="/monitors" component={MonitorsPage} />
									<Route path="/monitors/new">
										{() => (
											<FullOnly to="/monitors">
												<MonitorForm />
											</FullOnly>
										)}
									</Route>
									<Route path="/monitors/:id/edit">
										{(p) => (
											<FullOnly to={`/monitors/${p.id}`}>
												<MonitorForm key={p.id} id={p.id} />
											</FullOnly>
										)}
									</Route>
									<Route path="/monitors/:id">{(p) => <MonitorDetail key={p.id} id={p.id} />}</Route>
									<Route path="/status-pages" component={StatusPagesPage} />
									<Route path="/status-pages/:id">{(p) => <StatusPageEditor key={p.id} id={p.id} />}</Route>
									<Route path="/incidents" component={IncidentsPage} />
									<Route path="/notifications" component={NotificationsPage} />
									<Route path="/settings" component={SettingsPage} />
									<Route component={NotFound} />
								</Switch>
							</main>
						</div>
						<CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
					</ConfirmProvider>
				</ToastProvider>
			</TooltipProvider>
			</MeContext.Provider>
		</HostContext.Provider>
	);
}
