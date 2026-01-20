export const PRESENCE_COLORS = [
  "#e67e22",
  "#1abc9c",
  "#3498db",
  "#e74c3c",
  "#9b59b6",
  "#2ecc71",
  "#f1c40f",
  "#16a085",
  "#d35400",
  "#2980b9"
];

export const pickPresenceColor = (index: number) => {
  return PRESENCE_COLORS[index % PRESENCE_COLORS.length];
};
