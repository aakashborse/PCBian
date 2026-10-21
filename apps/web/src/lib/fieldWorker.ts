// Runs the field solver off the main thread.
import { fieldSolveImpedance, fieldWidthForImpedance } from "@pcbian/core";

type Req = { id: number; fn: "solve"; args: Parameters<typeof fieldSolveImpedance> } | { id: number; fn: "width"; args: Parameters<typeof fieldWidthForImpedance> };

self.onmessage = (e: MessageEvent<Req>) => {
  const { id } = e.data;
  try {
    const result = e.data.fn === "solve" ? fieldSolveImpedance(...e.data.args) : fieldWidthForImpedance(...e.data.args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
