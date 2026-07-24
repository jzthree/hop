// Scan a chunk of remote output for enhanced-keyboard protocol toggles: kitty
// keyboard push/pop (CSI > flags u / CSI < u) and xterm modifyOtherKeys
// (CSI > 4 ; level m). Returns the NET state after the chunk, so a re-render
// that pops and re-pushes inside one chunk stays "on". Mirrors the hop CLI.
// Shared by the main terminal and the switcher's focused tile so both encode
// modified keys (Shift+Enter → CSI 13;2u) identically.
const KBD_PROTO_RE = /\x1b\[([<>=])[0-9;:]*u|\x1b\[>([0-9;]*)m/g;

export const scanKeyboardProtocol = (data: string, current: boolean): boolean => {
  let next = current;
  KBD_PROTO_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KBD_PROTO_RE.exec(data)) !== null) {
    if (m[1] !== undefined) {
      next = m[1] !== "<"; // kitty: pop disables, push/set enable
    } else {
      const parts = (m[2] ?? "").split(";");
      if (parts[0] === "4") next = (parts[1] ?? "0") !== "0";
    }
  }
  return next;
};
