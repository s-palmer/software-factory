import { useEffect } from "react";

/** Call `fn` every `ms` while `active`. Plain polling works through any proxy or tunnel. */
export function usePolling(fn: () => void, active: boolean, ms = 1000): void {
  useEffect(() => {
    if (!active) return;
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, [fn, active, ms]);
}
