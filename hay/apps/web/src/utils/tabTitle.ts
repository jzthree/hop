// The browser tab's title.
//
// A session tab reads by session: its name first, the app second, so a row
// of hop tabs is scannable and still says what it is. The hub — no session
// open — is just the app. Before this, the hub showed the placeholder room id
// minted for a would-be new session ("room-k3x9q"), and the pre-hydration
// title was the web package's internal name ("Hay"): neither named anything
// the user had.
export const APP_TITLE = "hop";

export const tabTitle = (sessionLabel: string | null | undefined, alert: boolean): string => {
  const label = (sessionLabel || "").trim();
  const base = label ? `${label} · ${APP_TITLE}` : APP_TITLE;
  return `${alert ? "● " : ""}${base}`;
};
