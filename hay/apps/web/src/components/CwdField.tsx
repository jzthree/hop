import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// Working-directory input for the create form, with directory completion.
//
// Completion comes from the daemon (/api/fs/complete): the browser cannot
// see the filesystem, and the session is going to start wherever the DAEMON
// resolves the path, so the daemon is the only honest source of what exists.
// The field keeps the text as typed — ~ included — and the create API expands
// it; showing absolute paths here would make every suggestion a screenful.
//
// With nothing typed, the directories of recent sessions are offered first:
// a new session usually joins a project that already has one.
//
// A folder that is not there says so, with a "Create folder" button beside
// it: the session cannot start in a missing folder (the daemon refuses it;
// before, it quietly started in home — and Codex then made itself a scratch
// folder under ~/Documents/Codex). Creating stays a deliberate click, so a
// typo never leaves a stray folder behind.

type Entry = { name: string; path: string };

const shorten = (p: string, home: string) =>
  home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;

export const CwdField = ({ value, onChange, recent, id }: {
  value: string;
  onChange: (next: string) => void;
  recent: string[];
  id?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Array<{ label: string; fill: string }>>([]);
  const [active, setActive] = useState(-1);
  const [source, setSource] = useState<"recent" | "fs">("fs");
  const seq = useRef(0);
  const timer = useRef<number | null>(null);
  // Is the typed folder there? null: nothing typed, or not checked yet.
  const [folder, setFolder] = useState<null | { shown: string; exists: boolean; isDirectory: boolean }>(null);
  const [making, setMaking] = useState(false);
  const [makeError, setMakeError] = useState<string | null>(null);
  const checkSeq = useRef(0);
  const checkTimer = useRef<number | null>(null);
  const check = (q: string) => {
    const mine = ++checkSeq.current;
    if (!q.trim()) { setFolder(null); return; }
    fetch(`/api/fs/folder?path=${encodeURIComponent(q)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { shown?: string; exists?: boolean; isDirectory?: boolean } | null) => {
        if (mine !== checkSeq.current || !d || !d.shown) return;
        setFolder({ shown: d.shown, exists: !!d.exists, isDirectory: !!d.isDirectory });
      })
      .catch(() => { /* the daemon will say so on Create */ });
  };
  useEffect(() => {
    setMakeError(null);
    if (checkTimer.current) window.clearTimeout(checkTimer.current);
    checkTimer.current = window.setTimeout(() => check(value), 250);
    return () => { if (checkTimer.current) window.clearTimeout(checkTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const makeFolder = async () => {
    setMaking(true);
    setMakeError(null);
    try {
      const res = await fetch("/api/fs/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: value }) });
      const d = await res.json().catch(() => ({})) as { error?: string; shown?: string };
      if (!res.ok) { setMakeError(d.error || "Couldn't create it"); return; }
      check(value);
    } catch { setMakeError("Couldn't create it"); } finally { setMaking(false); }
  };

  const showRecent = () => {
    setSource("recent");
    setItems(recent.map((p) => ({ label: p, fill: p })));
    setActive(-1);
    setOpen(recent.length > 0);
  };

  const complete = (q: string) => {
    const mine = ++seq.current;
    fetch(`/api/fs/complete?q=${encodeURIComponent(q)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { home?: string; entries?: Entry[] } | null) => {
        if (mine !== seq.current) return; // a newer keystroke superseded this
        const home = data?.home || "";
        const list = (data?.entries || []).map((e) => {
          const short = shorten(e.path, home);
          return { label: short, fill: short + "/" };
        });
        setSource("fs");
        setItems(list);
        setActive(list.length ? 0 : -1);
        setOpen(list.length > 0);
      })
      .catch(() => { /* completion is a convenience; the field still works */ });
  };

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const onInput = (next: string) => {
    onChange(next);
    if (timer.current) window.clearTimeout(timer.current);
    if (!next.trim()) { showRecent(); return; }
    timer.current = window.setTimeout(() => complete(next), 120);
  };

  const accept = (i: number) => {
    const it = items[i];
    if (!it) return;
    onChange(it.fill);
    if (source === "recent") { setOpen(false); return; }
    // Descend: completing a directory immediately lists what is inside it,
    // so a path is built one segment per Tab, like a shell.
    complete(it.fill);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); return; }
    if (e.key === "Tab" || e.key === "ArrowRight") {
      if (active >= 0) { e.preventDefault(); accept(active); }
      return;
    }
    if (e.key === "Enter" && active >= 0) { e.preventDefault(); accept(active); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };

  return (
    <div className="switcher-create-cwd">
      <input
        id={id}
        value={value}
        placeholder="~ (working directory)"
        aria-label="Working directory"
        aria-autocomplete="list"
        aria-expanded={open}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onInput(e.target.value)}
        onFocus={() => { if (!value.trim()) showRecent(); else if (items.length) setOpen(true); }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      {folder && !folder.exists && value.trim() && (
        <div className="cwd-status missing" role="status">
          <span>No folder at <code>{folder.shown}</code> yet</span>
          <button type="button" className="cwd-make" disabled={making}
                  // mousedown would blur the field first; a click is fine here.
                  onClick={() => void makeFolder()}>{making ? "Creating…" : "Create folder"}</button>
          {makeError && <span className="cwd-make-error">{makeError}</span>}
        </div>
      )}
      {folder && folder.exists && !folder.isDirectory && (
        <div className="cwd-status missing" role="status"><span><code>{folder.shown}</code> is a file, not a folder</span></div>
      )}
      {open && items.length > 0 && (
        <div className="cwd-suggest" role="listbox" aria-label={source === "recent" ? "Recent directories" : "Directories"}>
          {source === "recent" && <div className="cwd-suggest-label">Recent</div>}
          {items.map((it, i) => (
            <button
              key={it.fill}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? "on" : ""}
              // mousedown, not click: the input's blur (which closes the
              // list) fires between the two, and the click would land on nothing.
              onMouseDown={(e) => { e.preventDefault(); accept(i); }}
              onMouseEnter={() => setActive(i)}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
