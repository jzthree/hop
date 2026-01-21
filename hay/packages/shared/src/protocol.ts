import { z } from "zod";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().min(1) }),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(2), rows: z.number().int().min(2) }),
  z.object({ type: z.literal("typing"), active: z.boolean() }),
  z.object({ type: z.literal("toggle_collab"), enabled: z.boolean() }),
  z.object({ type: z.literal("take_control") }),
  z.object({ type: z.literal("release_control") }),
  z.object({ type: z.literal("ping"), t: z.number() }),
  z.object({ type: z.literal("kill_session") })
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const presenceClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  typing: z.boolean(),
  lastActive: z.number()
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    clientId: z.string(),
    roomId: z.string(),
    color: z.string(),
    collabMode: z.boolean(),
    controllerId: z.string().nullable()
  }),
  z.object({
    type: z.literal("presence"),
    clients: z.array(presenceClientSchema)
  }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({ type: z.literal("snapshot"), data: z.string() }),
  z.object({ type: z.literal("collab"), enabled: z.boolean(), controllerId: z.string().nullable() }),
  z.object({ type: z.literal("input_rejected"), reason: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("session_ended"),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    message: z.string()
  }),
  z.object({ type: z.literal("pong"), t: z.number() }),
  // Broadcast when active user's terminal size should be followed
  z.object({ type: z.literal("active_size"), clientId: z.string(), cols: z.number().int(), rows: z.number().int() })
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type PresenceClient = z.infer<typeof presenceClientSchema>;

export const parseClientMessage = (payload: string) => {
  const parsed = JSON.parse(payload);
  return clientMessageSchema.parse(parsed);
};

export const safeParseClientMessage = (payload: string) => {
  try {
    const parsed = JSON.parse(payload);
    const result = clientMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

export const parseServerMessage = (payload: string) => {
  const parsed = JSON.parse(payload);
  return serverMessageSchema.parse(parsed);
};

export const safeParseServerMessage = (payload: string) => {
  try {
    const parsed = JSON.parse(payload);
    const result = serverMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};
