import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(path: string) {
  history.pushState(null, "", path);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
}
