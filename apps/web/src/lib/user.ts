import { useSyncExternalStore } from "react";

export interface LocalUser {
  name: string;
  color: string;
}

const COLORS = ["#f97316", "#22c55e", "#06b6d4", "#a855f7", "#ec4899", "#eab308", "#3b82f6", "#ef4444"];
const KEY = "pcbian.user";
const listeners = new Set<() => void>();

function load(): LocalUser {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as LocalUser;
  } catch {
    // storage unavailable: fall through to a generated identity
  }
  return { name: `Engineer ${Math.floor(Math.random() * 900 + 100)}`, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
}

let current = load();

export function setUser(u: LocalUser) {
  current = u;
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useUser(): LocalUser {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export const USER_COLORS = COLORS;
