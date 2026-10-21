import { deleteComment, replyComment, setCommentResolved, type DesignComment } from "@pcbian/core";
import { useState } from "react";
import { api } from "../lib/api";
import { useUser } from "../lib/user";
import { useEditor } from "./context";

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

/** Ask the copilot to handle a thread (used for @copilot mentions and the Ask button). */
export function askCopilotAbout(projectId: string, c: DesignComment, text: string, author: string) {
  const where = c.view === "pcb" ? `on the PCB at (${c.pos.x.toFixed(1)}, ${c.pos.y.toFixed(1)}) mm` : `on schematic sheet ${c.sheet ?? "1"} at (${c.pos.x}, ${c.pos.y})`;
  return api.ask(projectId, `Review comment ${c.id} ${where}${c.ref ? ` about ${c.ref}` : ""}: "${text}". Do what it asks, then answer in the thread with reply_comment (resolve it if done).`, author);
}

export function ReviewPanel() {
  const { design, conn, selection, select, focusOn, projectId, toast } = useEditor();
  const user = useUser();
  const [showResolved, setShowResolved] = useState(false);
  const list = design.comments.filter((c) => showResolved || !c.resolved);
  const open = design.comments.filter((c) => !c.resolved).length;
  return (
    <div className="panel-body">
      <div className="row" style={{ marginBottom: 8 }}>
        <h4 style={{ margin: 0 }}>Review comments</h4>
        <span className="muted small">{open} open</span>
        <span className="spacer" />
        <label className="small row" style={{ gap: 4 }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          resolved
        </label>
      </div>
      {list.length === 0 && (
        <p className="muted small">
          Use the <b>Comment</b> tool on the schematic or PCB toolbar to pin a note to a spot or part. Mention <code>@copilot</code> to have the AI handle it and answer in the thread.
        </p>
      )}
      {list.map((c, i) => (
        <Thread
          key={c.id}
          c={c}
          n={design.comments.indexOf(c) + 1}
          selected={selection?.kind === "comment" && selection.id === c.id}
          onShow={() => {
            select({ kind: "comment", id: c.id });
            focusOn(c.view === "pcb" ? "pcb" : "schematic", c.pos);
          }}
          onReply={(text) => {
            replyComment(conn.doc, c.id, { author: user.name, color: user.color, text });
            if (/@copilot\b/i.test(text)) askCopilotAbout(projectId, c, text, user.name).then(() => toast("Copilot is on it"), (e) => toast((e as Error).message));
          }}
          onResolve={(r) => setCommentResolved(conn.doc, c.id, r)}
          onDelete={() => deleteComment(conn.doc, c.id)}
          onAsk={() => askCopilotAbout(projectId, c, c.text, user.name).then(() => toast("Copilot is on it"), (e) => toast((e as Error).message))}
          last={i === list.length - 1}
        />
      ))}
    </div>
  );
}

function Thread(props: { c: DesignComment; n: number; selected: boolean; onShow: () => void; onReply: (t: string) => void; onResolve: (r: boolean) => void; onDelete: () => void; onAsk: () => void; last: boolean }) {
  const { c, n, selected } = props;
  const [reply, setReply] = useState("");
  return (
    <div className={`card thread${selected ? " sel" : ""}${c.resolved ? " resolved" : ""}`}>
      <div className="row" style={{ gap: 6 }}>
        <span className="pin-badge" style={{ background: c.color ?? "#9085e9" }}>
          {n}
        </span>
        <b className="small">{c.author}</b>
        <span className="muted small">
          {ago(c.createdAt)} · {c.view === "pcb" ? "PCB" : "schematic"}
          {c.ref ? ` · ${c.ref}` : ""}
        </span>
        <span className="spacer" />
        <button className="ghost small" onClick={props.onShow} title="Show on the design">
          Show
        </button>
      </div>
      <div className="small" style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
        {c.text}
      </div>
      {c.replies.map((r) => (
        <div key={r.id} className="reply small">
          <b style={{ color: r.color ?? "var(--text)" }}>{r.author}</b> <span className="muted">{ago(r.at)}</span>
          <div style={{ whiteSpace: "pre-wrap" }}>{r.text}</div>
        </div>
      ))}
      <div className="row" style={{ gap: 4, marginTop: 6 }}>
        <input
          placeholder="Reply… (@copilot to ask the AI)"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && reply.trim()) {
              props.onReply(reply.trim());
              setReply("");
            }
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
      <div className="row" style={{ gap: 4, marginTop: 6 }}>
        <button className="small" onClick={() => props.onResolve(!c.resolved)}>
          {c.resolved ? "Reopen" : "Resolve"}
        </button>
        <button className="small" onClick={props.onAsk} title="Ask the copilot to handle this comment">
          ✦ Ask copilot
        </button>
        <span className="spacer" />
        <button className="ghost small danger" onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** Comment markers drawn on a canvas (world coordinates); `r` is the marker radius in world units. */
export function CommentPins({ view, sheet, r }: { view: "schematic" | "pcb"; sheet?: string; r: number }) {
  const { design, selection, select } = useEditor();
  return (
    <g>
      {design.comments.map((c, i) => {
        if (c.view !== view || c.resolved || (view === "schematic" && (c.sheet ?? design.sheets[0].id) !== sheet)) return null;
        const sel = selection?.kind === "comment" && selection.id === c.id;
        return (
          <g
            key={c.id}
            className="comment-pin"
            transform={`translate(${c.pos.x} ${c.pos.y})`}
            onPointerDown={(e) => {
              e.stopPropagation();
              select({ kind: "comment", id: c.id });
            }}
            style={{ cursor: "pointer" }}
          >
            <title>{`${c.author}: ${c.text}`}</title>
            <path d={`M0 0 L${-r * 0.5} ${-r * 0.9} A${r} ${r} 0 1 1 ${r * 0.5} ${-r * 0.9} Z`} fill={c.color ?? "#9085e9"} stroke={sel ? "#ffffff" : "#12151b"} strokeWidth={r * 0.18} />
            <text x={0} y={-r * 1.55} fontSize={r * 1.1} textAnchor="middle" fill="#ffffff" fontWeight={700} style={{ pointerEvents: "none" }}>
              {i + 1}
            </text>
          </g>
        );
      })}
    </g>
  );
}
