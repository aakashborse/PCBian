import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useUser } from "../lib/user";
import { useEditor } from "./context";
import { useChat } from "./presence";

const SUGGESTIONS = [
  "Review my schematic for mistakes",
  "Add decoupling capacitors to every IC",
  "Design a 3.3V regulator from USB-C",
  "Auto-place and route the board",
  "Explain how this circuit works",
];

/** Minimal, safe Markdown: paragraphs, bullet/numbered lists, **bold** and `code`. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^#{1,6}\s+/, "");
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (bullet || num) {
      flushPara();
      const ordered = Boolean(num);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? num)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <>{blocks}</>;
}

export function Copilot({ enabled }: { enabled: boolean | null }) {
  const { projectId, conn, toast } = useEditor();
  const user = useUser();
  const chat = useChat(conn.doc);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = sending || chat.some((m) => m.status === "streaming");

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [chat]);

  const send = async (text: string) => {
    const msg = text.trim();
    if (!msg || busy) return;
    setSending(true);
    try {
      await api.ask(projectId, msg, user.name);
      setInput("");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="panel-body">
        {enabled === false && (
          <div className="card small">
            The copilot needs an Anthropic API key. Set <code>ANTHROPIC_API_KEY</code> in <code>.env</code> and restart the server.
          </div>
        )}
        {chat.length === 0 ? (
          <div>
            <p className="muted small" style={{ marginTop: 0 }}>
              The copilot can read and edit this design: add parts, wire circuits, choose component values, place and route the board, and run checks. Everyone in the project sees the conversation.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} disabled={!enabled || busy} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat">
            {chat.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="who">
                  {m.role === "assistant" ? "✦ Copilot" : m.author}
                  {m.status === "streaming" && (
                    <span className="typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
                <div className="bubble">
                  {m.tools.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      {m.tools.map((t, i) => (
                        <span key={i} className="tool-chip">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" ? <Markdown text={m.text} /> : m.text}
                  {m.status === "error" && <span style={{ color: "var(--danger)" }}> ⚠</span>}
                </div>
              </div>
            ))}
            <div ref={bottom} />
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          placeholder={enabled ? "Ask the copilot to design, review or route…" : "Copilot unavailable"}
          value={input}
          disabled={!enabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div className="row">
          <button
            className="ghost small"
            disabled={busy || chat.length === 0}
            onClick={async () => {
              if (confirm("Clear the copilot conversation for everyone?")) await api.resetCopilot(projectId).catch((e: Error) => toast(e.message));
            }}
          >
            New chat
          </button>
          <span className="spacer" />
          <span className="muted small">{busy ? "Working…" : "Enter to send"}</span>
          <button className="primary" disabled={!enabled || busy || !input.trim()} onClick={() => send(input)}>
            Send
          </button>
        </div>
      </div>
    </>
  );
}
