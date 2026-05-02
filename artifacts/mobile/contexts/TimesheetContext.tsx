import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { ApiError, api } from "@/services/api";
import type { BackendTimesheetEntry } from "@/services/api";

export interface TimesheetState {
  active: BackendTimesheetEntry | null;
  ready: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  clockIn: (
    projectId: string | number,
    notes?: string,
  ) => Promise<BackendTimesheetEntry | null>;
  clockOut: (notes?: string) => Promise<BackendTimesheetEntry | null>;
}

const TimesheetContext = createContext<TimesheetState | undefined>(undefined);

export function TimesheetProvider({ children }: { children: React.ReactNode }) {
  const { user, ready: authReady } = useAuth();
  const { showToast } = useToast();
  const [active, setActive] = useState<BackendTimesheetEntry | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);

  // Single in-flight guard shared by refresh AND mutations so a background
  // foreground-refresh can't race with (and clobber) an optimistic clockIn /
  // clockOut result.
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const entry = await api.activeTimesheet();
      setActive(entry ?? null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setActive(null);
      } else {
        console.log("[Timesheet] refresh failed:", e);
      }
    } finally {
      inFlightRef.current = false;
      setReady(true);
    }
  }, []);

  // Initial fetch once the user is signed in.
  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      setActive(null);
      setReady(true);
      return;
    }
    void refresh();
  }, [authReady, user, refresh]);

  // Re-sync on foreground.
  useEffect(() => {
    if (!authReady || !user) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => sub.remove();
  }, [authReady, user, refresh]);

  const clockIn = useCallback(
    async (projectId: string | number, notes?: string) => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setLoading(true);
      try {
        const entry = await api.clockIn(projectId, notes);
        setActive(entry);
        return entry;
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Unknown error";
        console.log("[Timesheet] clockIn failed:", e);
        showToast(`Couldn't clock in: ${msg}`);
        return null;
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [showToast],
  );

  const clockOut = useCallback(
    async (notes?: string) => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setLoading(true);
      try {
        const entry = await api.clockOut(notes);
        setActive(null);
        showToast("Clocked out");
        return entry;
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Unknown error";
        console.log("[Timesheet] clockOut failed:", e);
        showToast(`Couldn't clock out: ${msg}`);
        return null;
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [showToast],
  );

  const value = useMemo<TimesheetState>(
    () => ({ active, ready, loading, refresh, clockIn, clockOut }),
    [active, ready, loading, refresh, clockIn, clockOut],
  );

  return (
    <TimesheetContext.Provider value={value}>
      {children}
    </TimesheetContext.Provider>
  );
}

export function useTimesheet(): TimesheetState {
  const ctx = useContext(TimesheetContext);
  if (!ctx)
    throw new Error("useTimesheet must be used inside TimesheetProvider");
  return ctx;
}
