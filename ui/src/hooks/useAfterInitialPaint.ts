import { useEffect, useState } from "react";

export function useAfterInitialPaint(delayMs = 750) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready) return;

    let cancelled = false;
    const finish = () => {
      if (!cancelled) setReady(true);
    };

    const timeout = window.setTimeout(finish, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [delayMs, ready]);

  return ready;
}
