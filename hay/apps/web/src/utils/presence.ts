import type { PresenceClient } from "hay-shared";

export const sortPresence = (clients: PresenceClient[], selfId: string | null) => {
  return [...clients].sort((a, b) => {
    if (selfId && a.id === selfId) {
      return -1;
    }
    if (selfId && b.id === selfId) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
};

export const activityLabel = (client: PresenceClient) => {
  if (client.typing) {
    return "typing";
  }
  const seconds = (Date.now() - client.lastActive) / 1000;
  if (seconds < 15) {
    return "active";
  }
  return "idle";
};
