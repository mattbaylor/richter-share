import { useEffect, useRef, useState } from "react";
import { DURATION_UNITS, type DurationUnit, pickUnit, toSeconds } from "@/lib/duration";
import { Input, Select } from "./input";

/**
 * Number + unit picker that reads and writes seconds. Invalid input reports NaN
 * so the form can show a validation error. Changing the unit keeps the number.
 */
export function DurationInput({ value, onChange, fallbackUnit = 60, "aria-label": label }: { value: number; onChange: (seconds: number) => void; fallbackUnit?: DurationUnit; "aria-label"?: string }) {
	const [unit, setUnit] = useState<DurationUnit>(() => pickUnit(value, fallbackUnit));
	const [text, setText] = useState(() => (Number.isFinite(value) ? String(value / pickUnit(value, fallbackUnit)) : ""));
	const last = useRef(value);
	// Resync only when the parent sets a value we didn't emit (e.g. a type preset).
	useEffect(() => {
		if (Object.is(value, last.current)) return;
		last.current = value;
		if (!Number.isFinite(value)) return;
		const u = pickUnit(value, fallbackUnit);
		setUnit(u);
		setText(String(value / u));
	}, [value, fallbackUnit]);
	const emit = (t: string, u: DurationUnit) => {
		const s = toSeconds(t, u);
		last.current = s;
		onChange(s);
	};
	return (
		<div className="flex gap-2">
			<Input type="number" inputMode="numeric" min={0} step={1} className="min-w-0 flex-1" aria-label={label} value={text} onChange={(e) => { setText(e.target.value); emit(e.target.value, unit); }} />
			<Select className="w-28 shrink-0" aria-label={label ? `${label} unit` : "Unit"} value={unit} onChange={(e) => { const u = Number(e.target.value) as DurationUnit; setUnit(u); emit(text, u); }}>
				{DURATION_UNITS.map((d) => <option key={d.s} value={d.s}>{d.label}</option>)}
			</Select>
		</div>
	);
}
