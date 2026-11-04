import { Columns3 } from "lucide-react";
import { useLocalStorage } from "@/lib/hooks";
import { Button } from "./button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown";

export interface ColumnOption {
	id: string;
	label: string;
}

/**
 * Hidden column ids persisted in localStorage. Storing the hidden set (not the visible one)
 * means columns added later show up by default.
 */
export function useHiddenColumns(key: string, defaults: string[] = []) {
	const [hidden, setHidden] = useLocalStorage<string[]>(key, defaults);
	const isVisible = (id: string) => !hidden.includes(id);
	const toggle = (id: string, show: boolean) => setHidden(show ? hidden.filter((x) => x !== id) : [...new Set([...hidden, id])]);
	return { hidden, isVisible, toggle, reset: () => setHidden(defaults) };
}

/** A "Columns" button with a checkbox per column, like Beszel's All Systems table. */
export function ColumnsMenu({ columns, isVisible, toggle, reset }: { columns: ColumnOption[] } & Pick<ReturnType<typeof useHiddenColumns>, "isVisible" | "toggle" | "reset">) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" title="Show or hide columns">
					<Columns3 /> <span className="hidden sm:inline">Columns</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuLabel>Visible columns</DropdownMenuLabel>
				{columns.map((c) => (
					<DropdownMenuCheckboxItem key={c.id} checked={isVisible(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} onSelect={(e) => e.preventDefault()}>
						{c.label}
					</DropdownMenuCheckboxItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={reset}>Reset to default</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
