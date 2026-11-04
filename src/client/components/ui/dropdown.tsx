import * as M from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;

export function DropdownMenuContent({ className, align = "end", ...props }: React.ComponentProps<typeof M.Content>) {
	return (
		<M.Portal>
			<M.Content
				align={align}
				sideOffset={4}
				className={cn("z-50 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg", className)}
				{...props}
			/>
		</M.Portal>
	);
}

export function DropdownMenuItem({
	className,
	destructive,
	...props
}: React.ComponentProps<typeof M.Item> & { destructive?: boolean }) {
	return (
		<M.Item
			className={cn(
				"flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none [&_svg]:size-4 [&_svg]:text-muted-foreground",
				"data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				destructive && "text-destructive [&_svg]:text-destructive data-[highlighted]:bg-destructive/10",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuSeparator() {
	return <M.Separator className="-mx-1 my-1 h-px bg-border" />;
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof M.Label>) {
	return <M.Label className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof M.CheckboxItem>) {
	return (
		<M.CheckboxItem
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-7 pr-2 text-sm outline-none",
				"data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="absolute left-2 flex size-3.5 items-center justify-center rounded-[3px] border border-input data-[state=checked]:border-primary">
				<M.ItemIndicator className="flex size-full items-center justify-center rounded-[3px] bg-primary text-primary-foreground">
					<Check className="size-3" strokeWidth={3} />
				</M.ItemIndicator>
			</span>
			{children}
		</M.CheckboxItem>
	);
}

export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof M.RadioItem>) {
	return (
		<M.RadioItem
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-7 pr-2 text-sm outline-none",
				"data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="absolute left-2 flex size-3.5 items-center justify-center">
				<M.ItemIndicator>
					<span className="block size-2 rounded-full bg-current" />
				</M.ItemIndicator>
			</span>
			{children}
		</M.RadioItem>
	);
}
