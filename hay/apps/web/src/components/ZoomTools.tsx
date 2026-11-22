/** − 100% + at the foot of a document or image in Views (the PDF reader has its own, with the page number). */
export const ZoomTools = ({ zoom, min, max, onStep, onReset, resetTitle }: {
  zoom: number;
  min: number;
  max: number;
  onStep: (dir: 1 | -1) => void;
  onReset: () => void;
  /** What the percentage does when clicked: "Actual size (0)", "Fit to the pane (0)". */
  resetTitle: string;
}) => {
  const pct = Math.round(zoom * 100);
  return (
    <div className="zoom-tools" role="toolbar" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" title="Zoom out (⌘−)" disabled={zoom <= min + 1e-3} onClick={() => onStep(-1)}>−</button>
      <button type="button" className="zoom-pct" aria-label={`Zoom ${pct}%. ${resetTitle}`} title={resetTitle} onClick={onReset}>{pct}%</button>
      <button type="button" aria-label="Zoom in" title="Zoom in (⌘+)" disabled={zoom >= max - 1e-3} onClick={() => onStep(1)}>+</button>
    </div>
  );
};
