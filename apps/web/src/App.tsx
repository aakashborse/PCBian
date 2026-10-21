import { lazy, Suspense } from "react";
import { usePath } from "./lib/router";

// Each page is its own chunk: the dashboard does not pull in the editor (and vice versa).
const Editor = lazy(() => import("./editor/Editor").then((m) => ({ default: m.Editor })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));

export function App() {
  const path = usePath();
  const m = path.match(/^\/p\/([A-Za-z0-9_-]+)/);
  return <Suspense fallback={null}>{m ? <Editor key={m[1]} projectId={m[1]} /> : <Dashboard />}</Suspense>;
}
