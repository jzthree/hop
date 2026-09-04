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
