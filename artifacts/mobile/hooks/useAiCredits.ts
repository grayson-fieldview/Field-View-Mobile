import { useCallback, useEffect, useState } from "react";

import {
  getCachedAiCredits,
  refreshAiCredits,
  subscribeToAiCredits,
} from "@/services/aiCredits";
import type { CreditsResponse } from "@/services/api";

/** Shared, refreshable GET /api/credits state for AI entry points. */
export function useAiCredits() {
  const [credits, setCredits] = useState<CreditsResponse | null>(
    getCachedAiCredits,
  );

  useEffect(() => subscribeToAiCredits(setCredits), []);

  const refresh = useCallback(() => refreshAiCredits(), []);

  return { credits, refresh };
}
