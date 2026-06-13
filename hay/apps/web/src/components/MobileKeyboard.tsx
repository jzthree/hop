import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

// iOS detection for haptic feedback
const isIOS = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua);
};

interface MobileKeyboardProps {
  onInput: (data: string) => void;
  visible: boolean;
  onToggle: () => void;
  onHeightChange?: (height: number) => void;
  hapticsEnabled?: boolean;
  /** Called when reading the clipboard fails (e.g. permission denied). */
  onPasteFailed?: () => void;
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

export const MobileKeyboard = ({
  onInput,
  visible,
  onToggle,
  onHeightChange,
  hapticsEnabled = true,
  onPasteFailed
}: MobileKeyboardProps) => {
  const [view, setView] = useState<KeyboardView>("abc");
  const [shift, setShift] = useState(false);
  const [caps, setCaps] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [sysKbOpen, setSysKbOpen] = useState(false);
  const [sysKbHintShown, setSysKbHintShown] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [sysKbDraft, setSysKbDraft] = useState("");

  const shiftTapAt = useRef(0);
  const bkspTimeout = useRef<number | null>(null);
  const bkspInterval = useRef<number | null>(null);
  const sysInputRef = useRef<HTMLTextAreaElement>(null);
  const hapticLabelRef = useRef<HTMLLabelElement | null>(null);
  const keyboardRef = useRef<HTMLDivElement>(null);

  // Use refs to avoid stale closures in rapid key presses
  const onInputRef = useRef(onInput);
  const shiftRef = useRef(shift);
  const capsRef = useRef(caps);
  const ctrlRef = useRef(ctrl);
  const altRef = useRef(alt);
  const onPasteFailedRef = useRef(onPasteFailed);

  // Keep refs in sync with state
  onInputRef.current = onInput;
  shiftRef.current = shift;
  capsRef.current = caps;
  ctrlRef.current = ctrl;
  altRef.current = alt;
  onPasteFailedRef.current = onPasteFailed;

  // Create hidden switch elements for iOS haptic feedback
  // iOS doesn't support navigator.vibrate, so we use a hidden checkbox switch
  // element trick - clicking its label triggers native haptic feedback
  useEffect(() => {
    if (!isIOS()) return;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = "hay-haptic-switch";
    input.setAttribute("switch", "");
    // Hide off-screen instead of display:none (display:none prevents haptic)
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "-9999px";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.appendChild(input);

    const label = document.createElement("label");
    label.htmlFor = "hay-haptic-switch";
    label.style.position = "fixed";
    label.style.left = "-9999px";
    label.style.top = "-9999px";
    label.style.opacity = "0";
    label.style.pointerEvents = "none";
    document.body.appendChild(label);
    hapticLabelRef.current = label;

    return () => {
      document.body.removeChild(input);
      document.body.removeChild(label);
      hapticLabelRef.current = null;
    };
  }, []);

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
    if (!hapticsEnabled) return;
    try {
      // Android/Chromium: the Vibration API gives a crisp tap. 8ms reads as a
      // tick without buzzing. iOS Safari has no web haptic API — the old
      // <input switch> trick was removed in iOS 17.4 — so we attempt it as a
      // best effort but it is a no-op on current iOS.
      if (typeof navigator.vibrate === "function") {
        navigator.vibrate(8);
      } else if (isIOS()) {
        hapticLabelRef.current?.click();
      }
    } catch {
      // Ignore haptic errors
    }
  }, [hapticsEnabled]);

  // Use refs in send to avoid stale closures - this is critical for rapid typing
  const send = useCallback(
    (key: string) => {
      let data = key;

      // Handle Ctrl modifier - applies only to letter keys (A-Z),
      // but the latch clears on any keypress so it can't stick forever
      if (ctrlRef.current) {
        if (key.length === 1) {
          const c = key.toUpperCase().charCodeAt(0);
          if (c >= 65 && c <= 90) {
            data = String.fromCharCode(c - 64);
          }
        }
        setCtrl(false);
      }

      // Handle Alt modifier - ESC-prefix the next single key, then clear the latch
      if (altRef.current) {
        if (data.length === 1) {
          data = "\x1b" + data;
        }
        setAlt(false);
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
      } else {
        onPasteFailedRef.current?.();
      }
    } catch {
      // Clipboard access denied — let the host surface it
      onPasteFailedRef.current?.();
    }
  }, [send]); // send is stable

  const resizeSysTextarea = useCallback(() => {
    const el = sysInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = Math.min(window.innerHeight * 0.4, 240);
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  const closeSysKb = useCallback(() => {
    sysInputRef.current?.blur();
    setSysKbOpen(false);
  }, []);

  const focusSysKbInput = useCallback(() => {
    const el = sysInputRef.current;
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    const len = el.value.length;
    if (typeof el.setSelectionRange === "function") {
      el.setSelectionRange(len, len);
    }
    resizeSysTextarea();
  }, [resizeSysTextarea]);

  const openSysKb = useCallback(() => {
    flushSync(() => {
      setSysKbOpen(true);
    });
    focusSysKbInput();
  }, [focusSysKbInput]);

  const toggleSysKb = useCallback(() => {
    if (sysKbOpen) {
      closeSysKb();
    } else {
      openSysKb();
    }
  }, [sysKbOpen, closeSysKb, openSysKb]);

  const handleSysKbSubmit = useCallback(() => {
    const text = sysKbDraft;
    if (text) {
      // Enter sends the text followed by CR — the universal "run it" expectation
      send(text + "\r");
      setSysKbDraft("");
    }
    if (sysInputRef.current) {
      sysInputRef.current.style.height = "";
    }
    closeSysKb();
  }, [send, closeSysKb, sysKbDraft]);

  useEffect(() => {
    if (!sysKbOpen) return;
    const el = sysInputRef.current;
    if (!el) return;
    const focusAndSize = () => {
      focusSysKbInput();
    };
    const frame = requestAnimationFrame(focusAndSize);
    const frame2 = requestAnimationFrame(focusAndSize);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(frame2);
    };
  }, [sysKbOpen, resizeSysTextarea]);

  useEffect(() => {
    if (!sysKbOpen) return;
    resizeSysTextarea();
  }, [sysKbDraft, sysKbOpen, resizeSysTextarea]);

  useEffect(() => {
    if (!visible) {
      onHeightChange?.(0);
      return;
    }

    const el = keyboardRef.current;
    if (!el) {
      return;
    }

    const reportHeight = () => {
      onHeightChange?.(Math.ceil(el.getBoundingClientRect().height));
    };

    reportHeight();
    window.addEventListener("resize", reportHeight);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", reportHeight);
      };
    }

    const observer = new ResizeObserver(reportHeight);
    observer.observe(el);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reportHeight);
    };
  }, [visible, onHeightChange]);

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
    send("\x7f");
    bkspTimeout.current = window.setTimeout(() => {
      bkspInterval.current = window.setInterval(() => {
        send("\x7f");
      }, 50);
    }, 500);
  }, [send]);

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
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
          onClick={hapticTap}
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
          onClick={hapticTap}
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
          }}
          onTouchCancel={removePressed}
          onClick={hapticTap}
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
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
          onClick={hapticTap}
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
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
          onClick={hapticTap}
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
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
          onClick={hapticTap}
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
          }}
          onTouchEnd={removePressed}
          onTouchCancel={removePressed}
          onClick={hapticTap}
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
        }}
        onTouchEnd={removePressed}
        onTouchCancel={removePressed}
        onClick={hapticTap}
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
            <textarea
              ref={sysInputRef}
              className="kb-sys-input"
              placeholder="Type here — return runs it..."
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              rows={1}
              value={sysKbDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSysKbSubmit();
                }
              }}
              onChange={(e) => {
                setSysKbDraft(e.currentTarget.value);
              }}
              onInput={resizeSysTextarea}
            />
          </div>
        </div>
      )}

      <div ref={keyboardRef} className="mobile-keyboard">
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
                  }}
                  onTouchEnd={removePressed}
                  onTouchCancel={removePressed}
                  onClick={hapticTap}
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
                  }}
                  onTouchEnd={removePressed}
                  onTouchCancel={removePressed}
                  onClick={hapticTap}
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
                }}
                onTouchEnd={removePressed}
                onTouchCancel={removePressed}
                onClick={hapticTap}
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
