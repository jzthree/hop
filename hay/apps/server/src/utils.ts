const MAX_NAME_LENGTH = 24;
const MAX_ROOM_LENGTH = 32;

const normalize = (value: string) => value.replace(/[^a-zA-Z0-9 _.-]/g, "").trim();

export const sanitizeName = (value: string | null | undefined) => {
  const cleaned = normalize(value ?? "");
  if (!cleaned) {
    return "Guest";
  }
  return cleaned.slice(0, MAX_NAME_LENGTH);
};

export const sanitizeRoom = (value: string | null | undefined) => {
  const cleaned = normalize(value ?? "");
  if (!cleaned) {
    return "main";
  }
  return cleaned.slice(0, MAX_ROOM_LENGTH);
};
