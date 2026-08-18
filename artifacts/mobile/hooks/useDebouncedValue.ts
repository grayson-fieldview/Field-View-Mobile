import { useEffect, useState } from "react";

/**
 * Debounce a fast-changing value (search-as-you-type). The returned
 * value trails `value` by `delayMs`; the timer resets on every change.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
