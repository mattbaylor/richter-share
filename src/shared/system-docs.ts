import type { SystemRecord } from "./types";

const uniq = (xs: string[]) => [...new Set(xs)];

/** One entry per line; a line that names a system (case-insensitive) is stored as that system's id. */
export function linesToRefs(text: string, systems: Pick<SystemRecord, "id" | "name">[]): string[] {
	const byName = new Map(systems.map((s) => [s.name.toLowerCase(), s.id]));
	const ids = new Set(systems.map((s) => s.id));
	return uniq(
		text
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => (ids.has(l) ? l : (byName.get(l.toLowerCase()) ?? l))),
	);
}

export function refsToLines(refs: string[], systems: Pick<SystemRecord, "id" | "name">[]): string {
	const byId = new Map(systems.map((s) => [s.id, s.name]));
	return refs.map((r) => byId.get(r) ?? r).join("\n");
}
