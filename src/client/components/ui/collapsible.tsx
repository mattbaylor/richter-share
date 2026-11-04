import * as C from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function Section({
	title,
	description,
	defaultOpen,
	children,
}: {
	title: string;
	description?: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
}) {
	return (
		<C.Root defaultOpen={defaultOpen} className="rounded-lg border">
			<C.Trigger className="group flex w-full items-center gap-2 px-4 py-3 text-left">
				<ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
				<span className="flex-1">
					<span className="block text-sm font-medium">{title}</span>
					{description && <span className="block text-xs text-muted-foreground">{description}</span>}
				</span>
			</C.Trigger>
			<C.Content className={cn("border-t px-4 py-4")}>{children}</C.Content>
		</C.Root>
	);
}
