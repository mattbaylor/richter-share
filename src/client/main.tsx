import "./index.css";
import type { HostInfo } from "@shared/types";
import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, errorMessage } from "./api";
import { Logo } from "./components/logo";
import { applyTheme, getTheme } from "./lib/theme";

const DashboardApp = lazy(() => import("./dashboard/App"));
const PublicApp = lazy(() => import("./public/PublicApp"));

applyTheme(getTheme());

function Splash({ error }: { error?: string }) {
	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
			<Logo className={error ? "size-10" : "size-10 animate-pulse"} />
			{error && (
				<div className="space-y-1">
					<p className="font-medium">Richter could not start</p>
					<p className="text-sm text-muted-foreground">{error}</p>
					<button type="button" className="text-sm text-primary hover:underline" onClick={() => location.reload()}>
						Reload
					</button>
				</div>
			)}
		</div>
	);
}

function Boot() {
	const [host, setHost] = useState<HostInfo>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		api.get<HostInfo>("/api/whoami-host").then(setHost, (e) => setError(errorMessage(e)));
	}, []);
	if (!host) return <Splash error={error} />;
	return (
		<Suspense fallback={<Splash />}>{host.mode === "public" ? <PublicApp host={host} /> : <DashboardApp host={host} />}</Suspense>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Boot />
	</StrictMode>,
);
