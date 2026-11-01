import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DesktopView } from "./components/DesktopView";
import "./styles.css";

// `?desktop=only`: the machine's desktop and nothing else — what the iOS app
// opens in a web view (noVNC is the viewer; there is no native one). No
// terminal sockets, no presence. Closing tells the app through its message
// handler, or goes back when opened in a plain browser.
const desktopOnly = new URLSearchParams(window.location.search).get("desktop") === "only";
const closeDesktopOnly = () => {
  const hop = (window as unknown as { webkit?: { messageHandlers?: { hop?: { postMessage: (m: string) => void } } } }).webkit?.messageHandlers?.hop;
  if (hop) hop.postMessage("close");
  else if (window.history.length > 1) window.history.back();
  else window.location.href = "/";
};

const container = document.getElementById("root");
if (container) {
  const { protocol, host } = window.location;
  createRoot(container).render(
    <React.StrictMode>
      {desktopOnly
        ? <DesktopView wsBase={`${protocol === "https:" ? "wss" : "ws"}://${host}/ws`} onClose={closeDesktopOnly} />
        : <App />}
    </React.StrictMode>
  );
}
