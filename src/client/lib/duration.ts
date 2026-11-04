export const DURATION_UNITS = [
	{ label: "Seconds", s: 1 },
	{ label: "Minutes", s: 60 },
	{ label: "Hours", s: 3600 },
	{ label: "Days", s: 86400 },
] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number]["s"];

/** Largest unit that divides `seconds` evenly (0 and invalid values fall back to `fallback`). */
export function pickUnit(seconds: number, fallback: DurationUnit = 1): DurationUnit {
	if (!Number.isInteger(seconds) || seconds <= 0) return fallback;
	for (let i = DURATION_UNITS.length - 1; i >= 0; i--) if (seconds % DURATION_UNITS[i].s === 0) return DURATION_UNITS[i].s;
	return 1;
}

/** Parse the typed amount; NaN unless it is a whole number >= 0. */
export function toSeconds(amount: string, unit: DurationUnit): number {
	const t = amount.trim();
	return /^\d+$/.test(t) ? Number(t) * unit : NaN;
}
