import type { HostInfo } from "@shared/types";
import { Route, Switch } from "wouter";
import { StatusPageView } from "./StatusPageView";

/** Public hosts only ever render status pages. */
export default function PublicApp({ host }: { host: HostInfo }) {
	return (
		<Switch>
			<Route path="/s/:slug">{(p) => <StatusPageView key={p.slug} path={`/api/public/pages/${encodeURIComponent(p.slug)}`} slug={p.slug} dashboardUrl={host.dashboardUrl} />}</Route>
			<Route>{() => <StatusPageView path="/api/public/page" dashboardUrl={host.dashboardUrl} />}</Route>
		</Switch>
	);
}
