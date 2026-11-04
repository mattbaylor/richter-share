import * as T from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = T.Root;
export const TabsContent = T.Content;

export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
	return <T.List className={cn("inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
	return (
		<T.Trigger
			className={cn(
				"inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-all [&_svg]:size-4",
				"data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

/** Small segmented control for non-tab choices (ranges, view modes). */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
	className,
}: {
	value: T;
	onChange: (v: T) => void;
	options: { value: T; label: React.ReactNode; title?: string }[];
	className?: string;
}) {
	return (
		<div className={cn("inline-flex h-8 items-center rounded-md border bg-muted/40 p-0.5", className)}>
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					title={o.title}
					onClick={() => onChange(o.value)}
					className={cn(
						"inline-flex h-full items-center gap-1 rounded-[5px] px-2.5 text-xs font-medium text-muted-foreground transition-colors [&_svg]:size-3.5",
						value === o.value ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
