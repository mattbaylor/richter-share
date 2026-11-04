import type { HostInfo } from "@shared/types";
import { createContext, useContext } from "react";

export const HostContext = createContext<HostInfo>({ mode: "dashboard", pageSlug: null, publicUrl: "", dashboardUrl: "" });
export const useHost = () => useContext(HostContext);
