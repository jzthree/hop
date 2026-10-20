// noVNC ships without types; DesktopView declares the part it uses.
declare module "@novnc/novnc" {
  const RFB: new (target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: Record<string, string> }) => EventTarget;
  export default RFB;
}
