import * as D from "@radix-ui/react-dialog";
import type { MonitorListItem, SystemRecord } from "@shared/types";
import { Activity, CornerDownLeft, Search, Server } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { StatusDot } from "@/components/ui/badge";
import { request } from "@/api";
import type { AnyStatus } from "@/lib/status";
import { MONITOR_TYPE_LABEL } from "@/lib/status";
import { cn } from "@/lib/utils";
import { NAV } from "./nav";

interface Entry {
	id: string;
	group: "Pages" | "Systems" | "Monitors";
	label: string;
	hint?: string;
	href: string;
	status?: AnyStatus;
	icon: React.ComponentType<{ className?: string }>;
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const [, navigate] = useLocation();
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const [systems, setSystems] = useState<SystemRecord[]>([]);
	const [monitors, setMonitors] = useState<MonitorListItem[]>([]);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setIndex(0);
		request<SystemRecord[]>("/api/admin/systems").then(setSystems, () => {});
		request<MonitorListItem[]>("/api/admin/monitors").then(setMonitors, () => {});
	}, [open]);

	const entries = useMemo<Entry[]>(() => {
		const all: Entry[] = [
			...NAV.map((n) => ({ id: n.href, group: "Pages" as const, label: n.label, href: n.href, icon: n.icon })),
			...systems.map((s) => ({
				id: `s:${s.id}`,
				group: "Systems" as const,
				label: s.name,
				hint: s.info?.h ?? s.tags.join(", "),
				href: `/systems/${s.id}`,
				status: s.status,
				icon: Server,
			})),
			...monitors.map((m) => ({
				id: `m:${m.id}`,
				group: "Monitors" as const,
				label: m.name,
				hint: MONITOR_TYPE_LABEL[m.type],
				href: `/monitors/${m.id}`,
				status: m.status,
				icon: Activity,
			})),
		];
		const q = query.trim().toLowerCase();
		if (!q) return all;
		return all.filter((e) => e.label.toLowerCase().includes(q) || e.hint?.toLowerCase().includes(q));
	}, [systems, monitors, query]);

	useEffect(() => setIndex(0), [query]);
	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}, [index]);

	const go = (e: Entry | undefined) => {
		if (!e) return;
		onOpenChange(false);
		navigate(e.href);
	};

	let lastGroup = "";
	return (
		<D.Root open={open} onOpenChange={onOpenChange}>
			<D.Portal>
				<D.Overlay className="animate-overlay-in fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
				<D.Content
					aria-describedby={undefined}
					className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setIndex((i) => Math.min(entries.length - 1, i + 1));
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							setIndex((i) => Math.max(0, i - 1));
						} else if (e.key === "Enter") {
							e.preventDefault();
							go(entries[index]);
						}
					}}
				>
					<D.Title className="sr-only">Jump to</D.Title>
					<div className="flex items-center gap-2 border-b px-3">
						<Search className="size-4 text-muted-foreground" />
						<input
							autoFocus
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Jump to a system, monitor or page…"
							className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
						/>
						<kbd className="rounded border px-1.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
					</div>
					<div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
						{entries.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">No matches for “{query}”.</p>}
						{entries.map((e, i) => {
							const header = e.group !== lastGroup ? e.group : null;
							lastGroup = e.group;
							return (
								<div key={e.id}>
									{header && <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{header}</div>}
									<button
										type="button"
										data-index={i}
										onMouseMove={() => setIndex(i)}
										onClick={() => go(e)}
										className={cn(
											"flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm",
											i === index && "bg-accent",
										)}
									>
										{e.status ? <StatusDot status={e.status} /> : <e.icon className="size-4 text-muted-foreground" />}
										<span className="truncate font-medium">{e.label}</span>
										{e.hint && <span className="truncate text-xs text-muted-foreground">{e.hint}</span>}
										{i === index && <CornerDownLeft className="ml-auto size-3.5 text-muted-foreground" />}
									</button>
								</div>
							);
						})}
					</div>
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}
