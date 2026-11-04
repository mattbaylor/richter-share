import type { MonitorStatus } from "../../shared/types";

export interface StateInput {
	prev: MonitorStatus;
	fail_streak: number;
	down_checks: number;
	retries: number;
	upside_down: boolean;
	max_latency_ms: number | null;
	resend_every: number;
}

export interface RawOutcome {
	ok: boolean;
	latency_ms: number | null;
	message: string | null;
	degraded?: boolean;
}

export interface StateOutput {
	status: MonitorStatus;
	fail_streak: number;
	down_checks: number;
	/** 0 down, 1 up, 2 degraded / pending retry, 3 maintenance */
	check_status: 0 | 1 | 2 | 3;
	message: string | null;
	transition: "down" | "up" | null;
	reminder: boolean;
	retrying: boolean;
}

/**
 * Pure status state machine: upside-down → maintenance → retries → transition.
 * Uptime Kuma semantics for retries and upside-down, FlareWatch semantics for degraded.
 */
export function nextState(m: StateInput, raw: RawOutcome, inMaintenance: boolean): StateOutput {
	const ok = m.upside_down ? !raw.ok : raw.ok;
	const message = m.upside_down && raw.ok ? `Upside down: ${raw.message ?? "target is reachable"}` : raw.message;

	if (inMaintenance) {
		return { status: "maintenance", fail_streak: 0, down_checks: 0, check_status: 3, message, transition: null, reminder: false, retrying: false };
	}

	if (ok) {
		const slow = m.max_latency_ms != null && raw.latency_ms != null && raw.latency_ms > m.max_latency_ms;
		const degraded = !!raw.degraded || slow;
		return {
			status: degraded ? "degraded" : "up",
			fail_streak: 0,
			down_checks: 0,
			check_status: degraded ? 2 : 1,
			message: slow ? `Slow: ${raw.latency_ms} ms > ${m.max_latency_ms} ms` : message,
			transition: m.prev === "down" ? "up" : null,
			reminder: false,
			retrying: false,
		};
	}

	const fail_streak = m.fail_streak + 1;
	if (m.prev !== "down" && fail_streak <= m.retries) {
		return {
			status: m.prev === "maintenance" ? "pending" : m.prev,
			fail_streak,
			down_checks: 0,
			check_status: 2,
			message: `Retry ${fail_streak}/${m.retries}: ${message ?? "failed"}`,
			transition: null,
			reminder: false,
			retrying: true,
		};
	}
	const down_checks = m.down_checks + 1;
	return {
		status: "down",
		fail_streak,
		down_checks,
		check_status: 0,
		message,
		transition: m.prev === "down" ? null : "down",
		reminder: m.prev === "down" && m.resend_every > 0 && down_checks % m.resend_every === 0,
		retrying: false,
	};
}
