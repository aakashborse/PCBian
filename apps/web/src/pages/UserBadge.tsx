import { useState } from "react";
import { setUser, USER_COLORS, useUser } from "../lib/user";

export function UserBadge() {
  const user = useUser();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  return (
    <>
      <button className="ghost row" onClick={() => setEditing(true)} title="Change your display name">
        <span className="avatar" style={{ background: user.color, margin: 0 }}>
          {initials(user.name)}
        </span>
        <span className="small">{user.name}</span>
      </button>
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(false)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setUser({ name: name.trim() || user.name, color });
              setEditing(false);
            }}
          >
            <h3>Your profile</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Collaborators see this name and colour next to your cursor and copilot messages.
            </p>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            <div className="row">
              {USER_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)} style={{ width: 26, height: 26, padding: 0, borderRadius: "50%", background: c, outline: c === color ? "2px solid white" : "none" }} />
              ))}
            </div>
            <div className="row">
              <span className="spacer" />
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary">Save</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
