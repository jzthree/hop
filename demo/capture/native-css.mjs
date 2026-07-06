// CSS injected at document-start for the 02b "native local terminal" clip:
// hide ALL web chrome (topbar, drawer/controls, footer, FAB, banners, toasts)
// and make the terminal frame fill the whole viewport. The .terminal-scroll
// padding (16px) is kept so text has a natural terminal margin.
export const NATIVE_TERMINAL_CSS = `
  .topbar, .controls, .terminal-footer, .drawer-toggle, .drawer-overlay,
  .drawer-close, .connection-banner, .terminal-toast, .terminal-find {
    display: none !important;
  }
  .app { padding: 0 !important; }
  .session {
    display: block !important;
    padding: 0 !important;
    gap: 0 !important;
  }
  .terminal { display: flex !important; }
  .terminal-frame {
    height: 100vh !important;
    min-height: 100vh !important;
    border: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    animation: none !important;
  }
  .terminal-scroll { scrollbar-width: none !important; }
  .terminal-scroll::-webkit-scrollbar { display: none !important; }
`;

// Playwright addInitScript source that installs the style at document-start
// (before first paint), so no chrome ever flashes into a recorded frame.
export const NATIVE_CSS_INIT = `(() => {
  const CSS = ${JSON.stringify(NATIVE_TERMINAL_CSS)};
  let done = false;
  const add = () => {
    if (done) return;
    const root = document.head || document.documentElement;
    if (!root) return;
    done = true;
    const st = document.createElement("style");
    st.textContent = CSS;
    root.appendChild(st);
  };
  add();
  if (!done) {
    new MutationObserver((m, mo) => { add(); if (done) mo.disconnect(); })
      .observe(document, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", add);
  }
})();`;
