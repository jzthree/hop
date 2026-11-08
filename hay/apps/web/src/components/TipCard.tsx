// One tip a day on the sessions overview (utils/tips): a line under the
// briefing and pulse, never in the way. Next shows another; × puts tips away
// until tomorrow; "Turn off" for good (Settings is not needed for a line of
// text). The rest live in the shortcuts panel. Per browser, by design.
import { useState } from "react";
import { localDay, tipFor, tips } from "../utils/tips";

/** A tip's text: `backticked` spans are commands, set as code. */
export const TipText = ({ text }: { text: string }) => (
  <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}</>
);

const HIDDEN_KEY = "hop_tip_hidden_day";
const OFF_KEY = "hop_tips_off";
const STEP_KEY = "hop_tip_step";

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

export const TipCard = ({ isMac, now = Date.now() }: { isMac: boolean; now?: number }) => {
  const day = localDay(now);
  const [hidden, setHidden] = useState(() => read(OFF_KEY) === "1" || read(HIDDEN_KEY) === String(day));
  // Next, remembered for the day: a reload shows the tip you moved on to.
  const [step, setStep] = useState(() => {
    const saved = (read(STEP_KEY) || "").split(":");
    return saved[0] === String(day) ? Number(saved[1]) || 0 : 0;
  });
  if (hidden) return null;
  const tip = tipFor(tips(isMac), day, step);
  return (
    <div className="tip-card" role="note" aria-label="Tip">
      <span className="tip-kind">Tip</span>
      <span className="tip-text"><TipText text={tip.text} /></span>
      <span className="tip-acts">
        <button type="button" className="tip-btn" title="Another tip"
                onClick={() => { const next = step + 1; setStep(next); write(STEP_KEY, `${day}:${next}`); }}>Next</button>
        <button type="button" className="tip-btn quiet" title="No more tips, ever (they are all in the shortcuts panel)"
                onClick={() => { write(OFF_KEY, "1"); setHidden(true); }}>Turn off</button>
        <button type="button" className="tip-close" aria-label="Hide tips until tomorrow" title="Hide until tomorrow"
                onClick={() => { write(HIDDEN_KEY, String(day)); setHidden(true); }}>×</button>
      </span>
    </div>
  );
};
