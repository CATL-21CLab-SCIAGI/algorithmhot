// Server-rendered content must be visible without JavaScript. Entrance animations therefore only
// play for components mounted after hydration (client-side navigation, loaded-more content).
import { useEffect, useState } from "react";

let hydrated = false;

/** True when this component mounted after the first hydration, so an entrance animation is safe. */
export function useEntrance(): boolean {
  const [entrance] = useState(() => hydrated);
  return entrance;
}

export function useHydratedFlag() {
  useEffect(() => {
    hydrated = true;
  }, []);
}
