// Field-solver calls answered by a Web Worker, so solving never freezes the editor.
import type { fieldSolveImpedance, fieldWidthForImpedance, FieldSolution } from "@pcbian/core";

let worker: Worker | null = null;
let next = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function call<T>(fn: "solve" | "width", args: unknown[]): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./fieldWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (e.data.error) p?.reject(new Error(e.data.error));
      else p?.resolve(e.data.result);
    };
  }
  const id = ++next;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, fn, args });
  });
}

export const solveImpedance = (...args: Parameters<typeof fieldSolveImpedance>) => call<FieldSolution>("solve", args);
export const solveWidth = (...args: Parameters<typeof fieldWidthForImpedance>) => call<number | null>("width", args);
