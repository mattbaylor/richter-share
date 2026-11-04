import { cn } from "@/lib/utils";
import { type AnyStatus, STATUS_BADGE, STATUS_DOT, STATUS_LABEL } from "@/lib/status";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
	return (
		<span
			className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium leading-none text-muted-foreground", className)}
			{...props}
		/>
	);
}

export function StatusDot({ status, className, pulse }: { status: AnyStatus; className?: string; pulse?: boolean }) {
	return (
		<span className={cn("relative inline-flex size-2.5 shrink-0", className)}>
			{pulse && (status === "up" || status === "down") && (
				<span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-50", STATUS_DOT[status])} />
			)}
			<span className={cn("relative inline-flex size-full rounded-full", STATUS_DOT[status])} />
		</span>
	);
}

export function StatusBadge({ status, className }: { status: AnyStatus; className?: string }) {
	return (
		<span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS_BADGE[status], className)}>
			<span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
			{STATUS_LABEL[status]}
		</span>
	);
}

export function TagChip({ tag, active, onClick, className }: { tag: string; active?: boolean; onClick?: () => void; className?: string }) {
	const Comp = onClick ? "button" : "span";
	return (
		<Comp
			type={onClick ? "button" : undefined}
			onClick={onClick}
			className={cn(
				"inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
				active ? "border-primary/50 bg-primary/15 text-primary" : "text-muted-foreground",
				onClick && "hover:border-primary/40 hover:text-foreground",
				className,
			)}
		>
			{tag}
		</Comp>
	);
}
