import { cn } from "@/lib/utils";

/** Richter mark: a seismograph trace on a violet tile (same as favicon.svg). */
export function Logo({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 64 64" className={cn("size-7", className)} aria-hidden="true">
			<rect width="64" height="64" rx="14" fill="#7c3aed" />
			<path
				d="M7 34h9l4-7 5 19 6.5-32 6 27 4-11 3.5 4H57"
				fill="none"
				stroke="#fff"
				strokeWidth="4.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
