import type { Me } from "@shared/types";
import { createContext, useContext } from "react";

/** The signed-in dashboard user. null while /me loads. */
export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);
/** Full users can change things; read-only users (and everyone until /me loads) can't. */
export const useCanEdit = () => useContext(MeContext)?.role === "full";
