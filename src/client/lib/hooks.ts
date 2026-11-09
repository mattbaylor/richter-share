import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "@/api";

/** Run `fn` every `ms` while the tab is visible (and once when it becomes visible again). */
export function usePoll(fn: () => void, ms: number | null | undefined) {
	const ref = useRef(fn);
	ref.current = fn;
	useEffect(() => {
		if (!ms) return;
		const id = setInterval(() => {
			if (document.visibilityState === "visible") ref.current();
		}, ms);
		const onVis = () => document.visibilityState === "visible" && ref.current();
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [ms]);
}

/**
 * Dashboard-wide freshness: every useApi load reports here, so the header can say how fresh the
 * page is, and warn when refreshes keep failing (e.g. the Cloudflare Access sign-in expired) instead
 * of silently showing old numbers.
 */
export interface LiveState {
	/** Last successful load. */
	okAt: number | null;
	/** First failure since the last success, or null while loads succeed. */
	failingSince: number | null;
	error: Error | null;
}
let live: LiveState = { okAt: null, failingSince: null, error: null };
const liveSubs = new Set<() => void>();
function setLive(next: LiveState) {
	live = next;
	liveSubs.forEach((f) => f());
}
function liveOk() {
	setLive({ okAt: Date.now(), failingSince: null, error: null });
}
function liveFail(e: Error) {
	setLive({ ...live, failingSince: live.failingSince ?? Date.now(), error: e });
}
export function useLiveState(): LiveState {
	const [, force] = useState(0);
	useEffect(() => {
		const f = () => force((n) => n + 1);
		liveSubs.add(f);
		return () => {
			liveSubs.delete(f);
		};
	}, []);
	return live;
}

const REFRESH_EVENT = "richter:refresh";
/** Reload everything on screen now (after "Check now", or from the header's refresh control). */
export function refreshAll() {
	window.dispatchEvent(new Event(REFRESH_EVENT));
}

export interface ApiState<T> {
	data: T | undefined;
	error: Error | undefined;
	loading: boolean;
	reload: () => Promise<void>;
	setData: React.Dispatch<React.SetStateAction<T | undefined>>;
}

/**
 * Load JSON from `path` (full path, e.g. "/api/admin/systems"). `null` path skips loading.
 * Keeps the previous data while refreshing, so polling never flashes skeletons.
 */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}): ApiState<T> {
	const [data, setData] = useState<T>();
	const [error, setError] = useState<Error>();
	const [loading, setLoading] = useState(path != null);
	const pathRef = useRef(path);
	pathRef.current = path;
	const seq = useRef(0);

	const load = useCallback(async () => {
		const p = pathRef.current;
		if (p == null) return;
		const mine = ++seq.current;
		try {
			const d = await request<T>(p);
			if (mine !== seq.current) return;
			setData(d);
			setError(undefined);
			liveOk();
		} catch (e) {
			if (mine !== seq.current) return;
			const err = e instanceof Error ? e : new Error(String(e));
			setError(err);
			// Connection-level failures only: a 404 or a validation error says nothing about freshness.
			if (!(err instanceof ApiError) || err.status === 401 || err.status >= 500 || err.message === "Invalid JSON from server") liveFail(err);
		} finally {
			if (mine === seq.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		setLoading(path != null);
		setData(undefined);
		setError(undefined);
		void load();
	}, [path, load]);

	usePoll(() => void load(), path == null ? null : opts.refreshMs);
	useEffect(() => {
		if (path == null) return;
		const f = () => void load();
		window.addEventListener(REFRESH_EVENT, f);
		return () => window.removeEventListener(REFRESH_EVENT, f);
	}, [path, load]);

	return { data, error, loading, reload: load, setData };
}

/**
 * The latest value in a ref, for callbacks used inside effects. Parents often pass inline handlers
 * (`onClose={() => setOpen(false)}`) that change on every render, and polling pages re-render every
 * few seconds: listing such a handler in an effect's deps re-runs the effect (e.g. reloads a form
 * and wipes the user's edits). Call `ref.current()` instead and leave it out of the deps.
 */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
	const ref = useRef(value);
	ref.current = value;
	return ref;
}

/** Re-render every `ms` (for "updated 12s ago" labels). */
export function useNow(ms = 1000): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(id);
	}, [ms]);
	return now;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			return raw == null ? initial : (JSON.parse(raw) as T);
		} catch {
			return initial;
		}
	});
	const set = useCallback(
		(v: T) => {
			setValue(v);
			localStorage.setItem(key, JSON.stringify(v));
		},
		[key],
	);
	return [value, set];
}

export const DEFAULT_TITLE = "Richter";

/**
 * Set document.title while the calling view is mounted. `undefined` (e.g. still loading) leaves
 * the current title alone. On unmount the title that was in place before this view first set it
 * is restored (falling back to `fallback`), so it never sticks after navigating away.
 */
export function useDocumentTitle(title: string | undefined, fallback = DEFAULT_TITLE) {
	const prev = useRef<string | null>(null);
	useEffect(() => {
		if (!title) return;
		if (prev.current === null) prev.current = document.title || fallback;
		document.title = title;
	}, [title, fallback]);
	useEffect(
		() => () => {
			if (prev.current !== null) document.title = prev.current;
			prev.current = null;
		},
		[],
	);
}
