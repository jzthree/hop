// The wall's three agent colours, from the daemon's verdict. The daemon
// decides working / done and whether a human has opened the session since
// the turn ended (its seen witness counts every device), so the web wall and
// the phone paint the same session the same colour.
//
//   working      blue   a turn is in flight
//   done-unread  green  finished; nobody has opened it since
//   done-read    quiet  finished, and looked at
//
// A question the agent is asking (attentionReason "ask") keeps its own amber
// signal on top; it is not folded in here.
export type CardPhase = "working" | "done-unread" | "done-read" | null;

export const cardPhase = (s: { agentPhase?: "working" | "done" | null; turnSeen?: boolean }): CardPhase => {
  if (s.agentPhase === "working") return "working";
  if (s.agentPhase === "done") return s.turnSeen === false ? "done-unread" : "done-read";
  return null;
};

export const phaseLabel = (p: CardPhase): string =>
  p === "working" ? "WORKING" : p === "done-unread" ? "DONE" : p === "done-read" ? "READ" : "";

export const phaseTitle = (p: CardPhase): string =>
  p === "working" ? "The agent is working on a turn"
    : p === "done-unread" ? "The agent finished — you have not opened this session since"
    : p === "done-read" ? "The agent finished, and you have looked" : "";
