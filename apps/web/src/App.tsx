import { Editor } from "./editor/Editor";
import { usePath } from "./lib/router";
import { Dashboard } from "./pages/Dashboard";

export function App() {
  const path = usePath();
  const m = path.match(/^\/p\/([A-Za-z0-9_-]+)/);
  return m ? <Editor key={m[1]} projectId={m[1]} /> : <Dashboard />;
}
