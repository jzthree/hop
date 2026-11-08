/**
 * A line for a session's agent — a briefing reply chip, a pulse note — sent
 * through hop (/api/sessions/send), never typed straight down a socket: hop
 * types it into the agent's input box only when the box is empty and the
 * agent is free, confirms it went, and otherwise holds it (the queue card
 * above the terminal) until the turn ends. Typed straight in, a reply to a
 * busy agent sat in its box unsent, or joined what someone was typing.
 *
 * Resolves "sent", "queued", or false (with the reason, when hop gave one).
 */
export const sendToSession = async (
  internalName: string,
  text: string,
  from = "you"
): Promise<{ status: "sent" | "queued" | false; error?: string }> => {
  if (!text) return { status: false };
  try {
    const res = await fetch("/api/sessions/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalName, text, from })
    });
    const data = await res.json().catch(() => ({})) as { status?: string; error?: string };
    if (!res.ok) return { status: false, error: data.error };
    return { status: data.status === "queued" ? "queued" : "sent" };
  } catch {
    return { status: false };
  }
};
