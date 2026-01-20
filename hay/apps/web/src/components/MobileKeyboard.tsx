import { useCallback, useEffect, useRef, useState } from "react";

interface MobileKeyboardProps {
  onInput: (data: string) => void;
  visible: boolean;
  onToggle: () => void;
}

type KeyboardView = "abc" | "num";

interface KeyDef {
  label: string;
  key?: string;
  mod?: "ctrl" | "alt";
  fn?: "sysKb";
  action?: "shift" | "bksp" | "paste" | "ret" | "space" | "123" | "abc";
  className?: string;
  flexGrow?: number;
}

const LAYOUTS: Record<KeyboardView, string[][]> = {
  abc: [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["SHIFT", "z", "x", "c", "v", "b", "n", "m", "BKSP"],
    ["123", "PASTE", "SPACE", "RET"]
  ],
  num: [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'],
    ["SHIFT", ".", ",", "?", "!", "'", "BKSP"],
    ["ABC", "PASTE", "SPACE", "RET"]
  ]
};

const ACC_KEYS: KeyDef[] = [
  { label: "Esc", key: "\x1b" },
  { label: "Tab", key: "\t" },
  { label: "Ctrl", mod: "ctrl" },
  { label: "Alt", mod: "alt" },
  { label: "←", key: "\x1b[D" },
  { label: "↓", key: "\x1b[B" },
  { label: "↑", key: "\x1b[A" },
  { label: "→", key: "\x1b[C" },
  { label: "KB", fn: "sysKb" }
];

const ShiftIcon = ({ filled }: { filled: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth="1.5"
    fill={filled ? "currentColor" : "none"}
  >
    <path d="M12 4L4 16h16L12 4z" />
  </svg>
);

const BackspaceIcon = () => (
  <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" fill="none">
    <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
    <line x1="18" y1="9" x2="12" y2="15" />
    <line x1="12" y1="9" x2="18" y2="15" />
  </svg>
);

const KeyboardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <line x1="6" y1="10" x2="6.01" y2="10" />
    <line x1="10" y1="10" x2="10.01" y2="10" />
    <line x1="14" y1="10" x2="14.01" y2="10" />
    <line x1="18" y1="10" x2="18.01" y2="10" />
    <line x1="8" y1="14" x2="16" y2="14" />
  </svg>
);

const PasteIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
  </svg>
);

export const MobileKeyboard = ({ onInput, visible, onToggle }: MobileKeyboardProps) => {
  const [view, setView] = useState<KeyboardView>("abc");
  const [shift, setShift] = useState(false);
  const [caps, setCaps] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [sysKbOpen, setSysKbOpen] = useState(false);
  const [sysKbHintShown, setSysKbHintShown] = useState(false);
  const [showHint, setShowHint] = useState(false);

  const shiftTapAt = useRef(0);
  const bkspTimeout = useRef<number | null>(null);
  const bkspInterval = useRef<number | null>(null);
  const sysInputRef = useRef<HTMLInputElement>(null);

  // Use refs to avoid stale closures in rapid key presses
  const onInputRef = useRef(onInput);
  const shiftRef = useRef(shift);
  const capsRef = useRef(caps);
  const ctrlRef = useRef(ctrl);

  // Keep refs in sync with state
  onInputRef.current = onInput;
  shiftRef.current = shift;
  capsRef.current = caps;
  ctrlRef.current = ctrl;

  // Helper to add pressed class (fast in, slow fade out via CSS)
  const addPressed = (e: React.TouchEvent | React.MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    target.classList.add("kb-pressed");
  };

  const removePressed = (e: React.TouchEvent | React.MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    target.classList.remove("kb-pressed");
  };

  const hapticTap = useCallback(() => {
    try {
      if (!navigator.vibrate) return;
      const ua = navigator.userAgent || "";
      if (/iPad|iPhone|iPod/.test(ua)) return;
      navigator.vibrate(10);
    } catch {
      // Ignore vibration errors
    }
  }, []);

  // Use refs in send to avoid stale closures - this is critical for rapid typing
  const send = useCallback(
    (key: string) => {
      let data = key;

      // Handle Ctrl modifier - only for letter keys (A-Z)
      // Read from ref for current value
      if (ctrlRef.current && key.length === 1) {
        const c = key.toUpperCase().charCodeAt(0);
        if (c >= 65 && c <= 90) {
          data = String.fromCharCode(c - 64);
          setCtrl(false);
        }
      }

      // Call onInput via ref to always use current callback
      onInputRef.current(data);

      // Clear shift after character input (unless caps lock)
      if (shiftRef.current && !capsRef.current && data.length === 1) {
        shiftTapAt.current = 0;
      }
    },
    [] // No dependencies - we read from refs
  );

  const handlePaste = useCallback(async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          send(text);
        }
      }
    } catch {
      // Clipboard access denied
    }
  }, [send]); // send is stable

  const toggleSysKb = useCallback(() => {
    if (sysKbOpen) {
      sysInputRef.current?.blur();
      setSysKbOpen(false);
    } else {
      setSysKbOpen(true);
      setTimeout(() => {
        sysInputRef.current?.focus();
      }, 50);
    }
  }, [sysKbOpen]);

  const handleSysKbSubmit = useCallback(() => {
    const text = sysInputRef.current?.value || "";
    if (text) {
      send(text);
    }
    if (sysInputRef.current) {
      sysInputRef.current.value = "";
    }
    toggleSysKb();
  }, [send, toggleSysKb]);

  const handleShift = useCallback(() => {
    const now = Date.now();
    const doubleTap = shiftTapAt.current && now - shiftTapAt.current < 300;

    if (caps) {
      setCaps(false);
      setShift(false);
      shiftTapAt.current = 0;
    } else if (shift) {
      if (doubleTap) {
        setCaps(true);
        setShift(false);
        shiftTapAt.current = 0;
      } else {
        setShift(false);
        shiftTapAt.current = now;
      }
    } else {
      setShift(true);
      shiftTapAt.current = now;
    }
  }, [caps, shift]);

  const startBksp = useCallback(() => {
    hapticTap();
    send("\x7f");
    bkspTimeout.current = window.setTimeout(() => {
      bkspInterval.current = window.setInterval(() => {
        send("\x7f");
      }, 50);
    }, 500);
  }, [hapticTap, send]); // Both are stable

  const stopBksp = useCallback(() => {
    if (bkspTimeout.current) {
      clearTimeout(bkspTimeout.current);
      bkspTimeout.current = null;
    }
    if (bkspInterval.current) {
      clearInterval(bkspInterval.current);
      bkspInterval.current = null;
    }
  }, []);

  // Show hint for first-time users
  useEffect(() => {
    if (visible && !sysKbHintShown) {
      try {
        const seen = localStorage.getItem("hay-syskb-seen");
        if (!seen) {
          setSysKbHintShown(true);
          setTimeout(() => {
            setShowHint(true);
            setTimeout(() => {
              setShowHint(false);
              localStorage.setItem("hay-syskb-seen", "1");
            }, 4000);
          }, 1000);
        } else {
          setSysKbHintShown(true);
        }
      } catch {
        setSysKbHintShown(true);
      }
    }
  }, [visible, sysKbHintShown]);

  // Use refs to avoid stale closures during rapid typing
  const handleCharKey = useCallback(
    (char: string) => {
      const ch = shiftRef.current || capsRef.current ? char.toUpperCase() : char;
      send(ch);
      if (shiftRef.current && !capsRef.current) {
        setShift(false);
      }
    },
    [send] // send is stable (empty deps)
  );

  const renderKey = (keyStr: string, index: number, isThirdRow: boolean) => {
    const isOn = shift || caps;

    if (keyStr === "SHIFT") {
      return (
        <button
          key={keyStr}
          type="button"
          className={`kb-key kb-act${isOn ? " kb-on" : ""}`}
          style={{ flexGrow: 1.25 }}
          onTouchStart={(e) => {
            e.preventDefault();
            addPressed(e);
            handleShift();
            hapticTap();
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
        >
          <ShiftIcon filled={isOn} />
        </button>
      );
    }

    if (keyStr === "BKSP") {
      return (
        <button
          key={keyStr}
          type="button"
          className="kb-key kb-act"
          style={{ flexGrow: 1.25 }}
          onTouchStart={(e) => {
            e.preventDefault();
            addPressed(e);
            startBksp();
          }}
          onTouchEnd={(e) => {
            removePressed(e);
            stopBksp();
          }}
          onTouchCancel={(e) => {
            removePressed(e);
            stopBksp();
          }}
        >
          <BackspaceIcon />
        </button>
      );
    }

    if (keyStr === "PASTE") {
      return (
        <button
          key={keyStr}
          type="button"
          className="kb-key kb-act"
          style={{ flexGrow: 1.25 }}
          onTouchStart={addPressed}
          onTouchEnd={(e) => {
            removePressed(e);
            handlePaste();
            hapticTap();
          }}
          onTouchCancel={removePressed}
          onClick={handlePaste}
        >
          <PasteIcon />
        </button>
      );
    }

    if (keyStr === "RET") {
      return (
        <button
          key={keyStr}
          type="button"
          className="kb-key kb-pri kb-bottom"
          style={{ flexGrow: 2.5 }}
          onTouchStart={(e) => {
            e.preventDefault();
            addPressed(e);
            send("\r");
            hapticTap();
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
        >
          return
        </button>
      );
    }

    if (keyStr === "SPACE") {
      return (
        <button
          key={keyStr}
          type="button"
          className="kb-key kb-bottom"
          style={{ flexGrow: 5 }}
          onTouchStart={(e) => {
            e.preventDefault();
            addPressed(e);
            send(" ");
            hapticTap();
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
        >
          space
        </button>
      );
    }

    if (keyStr === "123") {
      return (
        <button
          key={keyStr}
          type="button"
          className="kb-key kb-act kb-bottom"
          style={{ flexGrow: 1.25 }}
          onTouchStart={(e) => {
            e.preventDefault();
            addPressed(e);
            setView("num");
            hapticTap();
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
        >
          123
        </button>
      );
    }

    if (keyStr === "ABC") {
      return (
        <button
          key={keyStr}
          type="button"
          className="kb-key kb-act kb-bottom"
          style={{ flexGrow: 1.25 }}
          onTouchStart={(e) => {
            e.preventDefault();
            addPressed(e);
            setView("abc");
            hapticTap();
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
        >
          ABC
        </button>
      );
    }

    // Character key
    const displayChar = shift || caps ? keyStr.toUpperCase() : keyStr;
    return (
      <button
        key={`${keyStr}-${index}`}
        type="button"
        className="kb-key"
        onTouchStart={(e) => {
          e.preventDefault();
          addPressed(e);
          handleCharKey(keyStr);
          hapticTap();
        }}
        onTouchEnd={removePressed}
        onTouchCancel={removePressed}
      >
        {displayChar}
      </button>
    );
  };

  if (!visible) return null;

  return (
    <>
      {/* System keyboard hint overlay */}
      {showHint && (
        <div className="kb-hint-overlay">
          <div className="kb-hint">
            Tap the pulsing <strong>KB</strong> button for smooth typing with native keyboard, spellcheck, autocomplete and dictation
          </div>
        </div>
      )}

      {/* System keyboard dialog */}
      {sysKbOpen && (
        <div className="kb-sys-overlay" onClick={toggleSysKb}>
          <div className="kb-sys-dialog" onClick={(e) => e.stopPropagation()}>
            <input
              ref={sysInputRef}
              type="text"
              className="kb-sys-input"
              placeholder="Type here..."
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSysKbSubmit();
                }
              }}
            />
          </div>
        </div>
      )}

      <div className="mobile-keyboard">
        {/* Accessory row - Esc, Tab, Ctrl, Alt, arrows, system keyboard */}
        <div className="kb-acc-row">
          {ACC_KEYS.map((k, i) => {
            if (k.mod) {
              const isOn = k.mod === "ctrl" ? ctrl : alt;
              return (
                <button
                  key={k.label}
                  type="button"
                  className={`kb-key kb-act kb-acc${isOn ? " kb-on" : ""}`}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    addPressed(e);
                    if (k.mod === "ctrl") setCtrl(prev => !prev);
                    else setAlt(prev => !prev);
                    hapticTap();
                  }}
                  onTouchEnd={removePressed}
                  onTouchCancel={removePressed}
                >
                  {k.label}
                </button>
              );
            }
            if (k.fn === "sysKb") {
              return (
                <button
                  key={k.label}
                  type="button"
                  className={`kb-key kb-act kb-acc kb-syskb${showHint ? " kb-pulse" : ""}`}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    addPressed(e);
                    try {
                      localStorage.setItem("hay-syskb-seen", "1");
                    } catch {
                      // Ignore
                    }
                    toggleSysKb();
                    hapticTap();
                  }}
                  onTouchEnd={removePressed}
                  onTouchCancel={removePressed}
                >
                  <KeyboardIcon />
                </button>
              );
            }
            return (
              <button
                key={k.label}
                type="button"
                className="kb-key kb-act kb-acc"
                onTouchStart={(e) => {
                  e.preventDefault();
                  addPressed(e);
                  if (k.key) send(k.key);
                  hapticTap();
                }}
                onTouchEnd={removePressed}
                onTouchCancel={removePressed}
              >
                {k.label}
              </button>
            );
          })}
        </div>

        {/* Main keyboard rows */}
        <div className="kb-keys">
          {LAYOUTS[view].map((row, ri) => {
            const isThirdRow = ri === 2;
            return (
              <div
                key={ri}
                className={`kb-row${ri === 1 ? " kb-r2" : ""}${isThirdRow ? " kb-r3" : ""}`}
              >
                {row.map((keyStr, ki) => {
                  const elements = [];

                  // Add gap after SHIFT in third row
                  if (keyStr === "SHIFT" && isThirdRow) {
                    elements.push(renderKey(keyStr, ki, isThirdRow));
                    elements.push(<div key="gap-after-shift" className="kb-gap" />);
                    return elements;
                  }

                  // Add gap before BKSP in third row
                  if (keyStr === "BKSP" && isThirdRow) {
                    elements.push(<div key="gap-before-bksp" className="kb-gap" />);
                    elements.push(renderKey(keyStr, ki, isThirdRow));
                    return elements;
                  }

                  return renderKey(keyStr, ki, isThirdRow);
                })}
              </div>
            );
          })}
        </div>

      </div>
    </>
  );
};

export default MobileKeyboard;
