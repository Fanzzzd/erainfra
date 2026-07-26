import { useEffect, useState } from "react";

export function useNow(interval = 5_000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, interval);

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") update();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [interval]);

  return now;
}
