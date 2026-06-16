// score.js — turn a recorded typing session into a humanness verdict.
//
// Design principle drawn directly from the research: TIMING ALONE IS NOT ENOUGH.
// Adversarial work (timing-forgery / statistical-impersonation / generative-LSTM
// attacks) shows >=99.8% evasion of timing-only classifiers, because keystroke
// timing carries ZERO mutual information about *what* was written. So STORYPROOF
// layers several independent families of signal, and a session must look human on
// all of them:
//
//   A. PROVENANCE  — was the text actually typed key-by-key, or pasted / autofilled
//                    / injected via synthetic (untrusted) events? (hard gate)
//   B. TIMING      — dwell/flight distributions, variance, micro-pauses, rhythm
//                    irregularity, super-human speed, rollover. (scored)
//   C. CONTENT     — does the text actually respond to *this random prompt* and
//                    read like real language (not gibberish/repeats)? This is the
//                    anti-replay layer: a replayed human timing stream types old
//                    text, which won't match a freshly-randomized prompt. (scored)
//   D. MOUSE       — cursor path curvature, velocity variance, teleports, click
//                    dwell. Skipped (not penalized) for touch/keyboard-only. (scored)
//   E. INTERACTION — timing *between* distinct actions (focus, first key, slider,
//                    click): humans have reaction-time gaps; scripts fire instantly.
//   F. BEHAVIOR    — the required rating, used as a compliance probe. A bot dutifully
//                    rates the CAPTCHA and then verifies; a human hits verify and tries
//                    to skip the busywork. So *trying to skip the rating* ⇒ human. (adj)
//
// All thresholds below are annotated with their empirical basis.

const MIN_CHARS = 70;

// ---- small stats helpers -------------------------------------------------
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// ---- the scorer ----------------------------------------------------------
// Returns { score: 0..100, verdict: 'human'|'review'|'bot', signals: [...] }.
export function scoreSession(session, promptText) {
  const signals = [];
  const text = (session.finalText || "").trim();

  // Inter-key intervals: press-to-press gaps (down→down) are the standard
  // "flight"/inter-keystroke-interval (IKI) measure in the literature.
  const gaps = session.keystrokes
    .map((k) => k.downDownGap)
    .filter((g) => typeof g === "number" && g > 0 && g < 5000);
  const dwells = session.keystrokes.map((k) => k.dwell).filter((d) => d >= 0 && d < 2000);

  // ========================================================================
  // A. PROVENANCE — hard gates. Any of these alone ⇒ reject.
  // `provenanceFail` = a genuine automation tell (paste/synthetic/ghost). `enough`
  // = just "not enough data yet". We separate them so the skip escape-hatch can
  // forgive thin sessions but never forgive a paste/injection.
  // ========================================================================
  let provenanceFail = false;

  const insertedByPaste = session.events.some(
    (e) => e.type === "input" && /paste|drop|insertReplacementText|insertFromYank/i.test(e.inputType || "")
  );
  const pasted = session.pasteCount > 0 || session.dropCount > 0 || insertedByPaste;
  push(signals, pasted ? "fail" : "pass", "Typed, not pasted",
    pasted ? "paste/drop/autofill detected" : "no paste or drop events", !pasted);
  if (pasted) provenanceFail = true;

  // Synthetic JS-dispatched events report isTrusted=false. Real user input (and
  // even most CDP/driver input) is trusted, so untrusted events are a clean tell
  // for naive document.execCommand / dispatchEvent bots. Also covers fake mouse moves.
  const synthetic = session.untrustedCount > 0 || (session.mouse && session.mouse.untrustedMoves > 0);
  push(signals, synthetic ? "fail" : "pass", "Trusted input events",
    synthetic ? "synthetic (untrusted) events seen" : "all events user-trusted", !synthetic);
  if (synthetic) provenanceFail = true;

  // The number of recorded keystrokes should roughly track the text length. A
  // huge text with almost no keystrokes ⇒ programmatic value-set (el.value=...).
  const keyToCharRatio = text.length ? session.keystrokes.length / text.length : 0;
  const ghostTyped = text.length >= MIN_CHARS && keyToCharRatio < 0.5;
  push(signals, ghostTyped ? "fail" : "pass", "Keystrokes match text",
    `${keyToCharRatio.toFixed(2)} keystrokes/char`, !ghostTyped);
  if (ghostTyped) provenanceFail = true;

  // Enough material to measure. Below this, timing stats are unreliable.
  const enough = text.length >= MIN_CHARS && session.keystrokes.length >= 40;
  push(signals, enough ? "pass" : "warn", "Enough written",
    `${text.length} chars / ${session.keystrokes.length} keystrokes`, enough);

  let hardFail = provenanceFail || !enough;

  // ========================================================================
  // B. TIMING — scored 0..1 each, then weighted.
  // ========================================================================

  // B1. Flight-time variability (coefficient of variation). Real human IKIs are
  // highly variable: literature puts human CV near ~0.99. Scripted/constant-delay
  // input collapses toward 0. We treat CV>=0.5 as solidly human, <0.18 as robotic.
  const gMean = mean(gaps);
  const gSd = stdev(gaps);
  const cv = gMean > 0 ? gSd / gMean : 0;
  const cvScore = clamp01((cv - 0.18) / (0.5 - 0.18));
  push(signals, band(cvScore), "Rhythm variability",
    `CV ${cv.toFixed(2)} (human ≈ 0.8–1.1)`, cvScore >= 0.5, fmtScore(cvScore));

  // B2. Super-human speed. Humans rarely emit keys <50ms apart (~5–6% of events);
  // bots do so ~21%+. Sustained typing above ~216 wpm (>22 chars/s) is non-human.
  const fastFrac = gaps.length ? gaps.filter((g) => g < 50).length / gaps.length : 0;
  const charsPerSec = session.durationMs > 0 ? (text.length / (session.durationMs / 1000)) : 0;
  const wpm = charsPerSec * 12; // ~5 chars + space ≈ 6 chars/word → *60/5; use 12 for chars/s→wpm
  const tooFast = fastFrac > 0.25 || charsPerSec > 22;
  const speedScore = clamp01(1 - Math.max((fastFrac - 0.08) / 0.25, (charsPerSec - 12) / 12));
  push(signals, tooFast ? "fail" : band(speedScore), "Plausible speed",
    `${Math.round(wpm)} wpm · ${(fastFrac * 100).toFixed(0)}% sub-50ms gaps`, !tooFast, fmtScore(speedScore));

  // B3. Dwell time present & variable. Physical key-hold (dwell) is ~60–150ms and
  // varies per key. Synthetic input often has dwell≈0 (keydown/keyup same instant)
  // or a single constant value.
  const dMed = median(dwells);
  const dSd = stdev(dwells);
  const dwellHealthy = dMed >= 25 && dMed <= 250 && dSd > 5;
  const dwellScore = dwellHealthy ? clamp01((dSd) / 25) : 0;
  push(signals, dwellHealthy ? band(dwellScore) : "fail", "Key-hold (dwell) profile",
    `median ${Math.round(dMed)}ms · σ ${Math.round(dSd)}ms`, dwellHealthy, fmtScore(dwellScore));

  // B3b. Rollover / key-overlap — the strongest *human-only* signal in the
  // literature. Real typists press the next key before releasing the previous
  // one (overlapping presses), so a fraction of flight times go NEGATIVE.
  // Empirically every typist group shows ≥~19% rollover and fast typists 40–70%;
  // naive synthetic key injection shows 0%. Kept soft (not a hard gate) because
  // slow hunt-and-peck and some mobile keyboards legitimately overlap less.
  const flights = session.keystrokes.map((k) => k.flight).filter((f) => typeof f === "number");
  const rolloverFrac = flights.length ? flights.filter((f) => f < 0).length / flights.length : 0;
  const rolloverScore = clamp01(rolloverFrac / 0.2); // ≥20% overlap ⇒ full credit
  const rolloverOk = rolloverFrac >= 0.05;
  push(signals, rolloverOk ? band(rolloverScore) : "warn", "Key-overlap (rollover)",
    `${(rolloverFrac * 100).toFixed(0)}% overlapping presses (human ≈ 25–50%)`, rolloverOk, fmtScore(rolloverScore));

  // B4. Cognitive pauses. Natural composition is bursty: pauses >500ms cluster at
  // word/sentence/planning boundaries. A 100-char passage with zero such pauses is
  // suspiciously metronomic.
  // Shorter passage (~100 chars) ⇒ expect at least one boundary/planning pause.
  const longPauses = gaps.filter((g) => g > 500).length;
  const pauseOk = longPauses >= 1;
  const pauseScore = clamp01(longPauses / 2);
  push(signals, pauseOk ? band(pauseScore) : "warn", "Cognitive pauses",
    `${longPauses} pause(s) > 500ms`, pauseOk, fmtScore(pauseScore));

  // B5. Rhythm regularity (anti-metronome). Count exactly-repeated interval values
  // — generators that emit a fixed or low-entropy delay produce many identical
  // gaps. Humans almost never repeat the same sub-ms interval.
  const rounded = gaps.map((g) => Math.round(g));
  const uniqueFrac = rounded.length ? new Set(rounded).size / rounded.length : 1;
  const metronomic = uniqueFrac < 0.5;
  const regScore = clamp01((uniqueFrac - 0.4) / 0.4);
  push(signals, metronomic ? "fail" : band(regScore), "Non-repeating intervals",
    `${(uniqueFrac * 100).toFixed(0)}% unique gaps`, !metronomic, fmtScore(regScore));

  // B6. Correction behavior. Humans edit; realistic synthesizers must inject
  // backspaces (~80% chance every ≥6 chars) to pass. Absence is a soft negative,
  // not a hard fail — some people type a clean 100 chars.
  const corrections = session.backspaceCount + session.deleteCount;
  const corrScore = clamp01(corrections / 3);
  push(signals, corrections > 0 ? "pass" : "warn", "Correction behavior",
    `${corrections} backspace/delete`, corrections > 0, fmtScore(corrScore));

  // ========================================================================
  // C. CONTENT — anti-replay / anti-timing-mimicry. Did they respond to THIS
  //    random prompt, in real language? Timing forgeries can't satisfy this.
  // ========================================================================
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const uniqWords = new Set(words);
  const avgWordLen = words.length ? mean(words.map((w) => w.length)) : 0;

  // Lexical variety: gibberish / repeated-token spam has low unique-word ratio.
  const lexVariety = words.length ? uniqWords.size / words.length : 0;
  const sane = words.length >= 8 && avgWordLen >= 2.5 && avgWordLen <= 12 && lexVariety > 0.35;
  push(signals, sane ? "pass" : "fail", "Reads like language",
    `${words.length} words · ${(lexVariety * 100).toFixed(0)}% unique`, sane);

  // Prompt relevance: overlap between the story and the (randomized) prompt's
  // content words. A freshly-randomized prompt means a replayed/old text won't
  // overlap — the cheap, backend-free anti-replay check.
  const stop = new Set(["a","an","the","of","who","to","for","and","your","you","is","it","that","what","on","in"]);
  const promptWords = (promptText || "").toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const overlap = promptWords.filter((pw) => uniqWords.has(pw)).length;
  const relevant = promptWords.length === 0 || overlap >= 1;
  push(signals, relevant ? "pass" : "warn", "On-topic for this prompt",
    `${overlap}/${promptWords.length} prompt keywords used`, relevant);

  // ========================================================================
  // D. MOUSE — cursor dynamics. Only scored when a real mouse/pen was used; for
  //    touch-only or keyboard-only sessions we mark n/a and reweight (never punish
  //    a phone user for not waving a cursor around). Bots draw near-straight lines,
  //    move at constant velocity, teleport the cursor, and click with 0ms dwell.
  // ========================================================================
  const m = session.mouse || { points: [], clicks: [], pointerTypes: [], moved: false };
  const usesTouch = m.pointerTypes.includes("touch") && !m.pointerTypes.includes("mouse");
  const pts = m.points;
  let pathLen = 0, turnSum = 0, teleports = 0, prevAngle = null;
  const speeds = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    const dist = Math.hypot(dx, dy);
    const dt = Math.max(1, pts[i].t - pts[i - 1].t);
    pathLen += dist;
    speeds.push(dist / dt);
    if (dt < 16 && dist > 160) teleports++; // big jump in ~no time = synthetic teleport
    if (dist > 0.5) {
      const ang = Math.atan2(dy, dx);
      if (prevAngle !== null) {
        let da = Math.abs(ang - prevAngle);
        if (da > Math.PI) da = 2 * Math.PI - da;
        turnSum += da;
      }
      prevAngle = ang;
    }
  }
  const disp = pts.length > 1 ? Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) : 0;
  const straightness = pathLen > 0 ? disp / pathLen : 0; // ~1.0 over a long move = dead straight (bot)
  const meanTurn = pts.length > 3 ? turnSum / (pts.length - 2) : 0; // avg direction change per sample (rad)
  const speedMean = mean(speeds), speedSd = stdev(speeds);
  const speedCV = speedMean > 0 ? speedSd / speedMean : 0;
  const clickDwellMed = median(m.clicks.map((c) => c.dwell).filter((d) => d >= 0));

  const mouseUsed = m.moved && pts.length >= 12 && !usesTouch;
  let mouseScore = 0;
  if (mouseUsed) {
    // Human paths tremor/curve (meanTurn high, straightness < ~0.95); velocity is
    // variable; no teleports; clicks have a real press-hold dwell.
    const curveScore = clamp01(meanTurn / 0.25) * clamp01((0.98 - straightness) / 0.3 + 0.2);
    const velScore = clamp01(speedCV / 0.6);
    const teleScore = teleports === 0 ? 1 : clamp01(1 - teleports / 3);
    const clickScore = m.clicks.length === 0 ? 0.6 : clamp01(clickDwellMed / 60);
    mouseScore = clamp01(curveScore * 0.4 + velScore * 0.3 + teleScore * 0.2 + clickScore * 0.1);
    push(signals, band(mouseScore), "Mouse path looks human",
      `${pts.length} pts · curve ${meanTurn.toFixed(2)}rad · ${(straightness * 100) | 0}% straight · ${teleports} teleport(s)`,
      mouseScore >= 0.5, fmtScore(mouseScore));
  } else {
    push(signals, "warn", "Mouse path",
      usesTouch ? "touch input — mouse n/a" : "no mouse movement (keyboard-only?)", false, "n/a");
  }

  // ========================================================================
  // E. INTERACTION TIMING — gaps between distinct actions (focus, first key,
  //    slider, click). Human simple reaction time is ~210–240ms with a HARD
  //    anticipatory floor near 110ms — responses faster than that are excluded as
  //    non-genuine in the literature. So repeated sub-~120ms gaps between distinct
  //    actions are implausible as human reactions; scripts fire instantly or at one
  //    uniform delay (low spread).
  // ========================================================================
  const REACTION_FLOOR = 120; // ms — just above the ~110ms anticipatory floor
  const iEvents = session.interactions || [];
  const iGaps = [];
  for (let i = 1; i < iEvents.length; i++) iGaps.push(iEvents[i].t - iEvents[i - 1].t);
  const instantFrac = iGaps.length ? iGaps.filter((g) => g < REACTION_FLOOR).length / iGaps.length : 0;
  const iGapCV = mean(iGaps) > 0 ? stdev(iGaps) / mean(iGaps) : 0;
  let interactionScore = 0.5; // neutral when too few interactions to judge
  let interactionOk = true;
  if (iGaps.length >= 2) {
    interactionScore = clamp01((1 - instantFrac) * 0.6 + clamp01(iGapCV / 0.5) * 0.4);
    interactionOk = instantFrac < 0.5;
  }
  push(signals, iGaps.length < 2 ? "warn" : interactionOk ? band(interactionScore) : "fail",
    "Inter-interaction timing",
    `${iEvents.length} actions · ${(instantFrac * 100) | 0}% sub-reaction-time (<${REACTION_FLOOR}ms)`, interactionOk, fmtScore(interactionScore));

  // ========================================================================
  // F. BEHAVIOR — rating slider + skip escape hatch. Contrarian by design.
  // ========================================================================
  const sl = session.slider || { moved: false, finalValue: 10 };
  // The tell is NOT whether they rated (it's required, so everyone eventually does) —
  // it's whether they TRIED TO SKIP rating. A human hits "verify" and ignores the
  // busywork (skip attempt ⇒ human); a bot dutifully rates first, then verifies.
  const triedToSkip = !!session.triedToSkipRating;
  let behaviorBonus;
  if (triedToSkip) {
    behaviorBonus = 8;
    push(signals, "pass", "Tried to skip the rating",
      `hit verify before rating — humans dodge busywork (rated ${sl.finalValue} only when forced)`, true, "+8");
  } else {
    behaviorBonus = -5;
    push(signals, "warn", "Rated, then verified",
      "no skip attempt — bots dutifully rate first, then verify", false, "−5");
  }

  // ========================================================================
  // COMPOSITE — blend keystroke timing + mouse + interaction, add the slider
  // nudge, then apply content/provenance floors.
  // ========================================================================
  const ksTiming =
    cvScore * 0.22 + speedScore * 0.15 + dwellScore * 0.16 +
    rolloverScore * 0.15 + pauseScore * 0.10 + regScore * 0.14 + corrScore * 0.08;

  const base = mouseUsed
    ? ksTiming * 0.55 + mouseScore * 0.25 + interactionScore * 0.20
    : ksTiming * 0.75 + interactionScore * 0.25; // no usable mouse ⇒ reweight onto keystrokes

  let score = Math.round(base * 100) + behaviorBonus;
  if (!sane) score = Math.min(score, 20);
  if (!relevant) score = Math.max(0, score - 12);
  if (tooFast || metronomic) score = Math.min(score, 35);
  if (hardFail) score = Math.min(score, 8);
  score = Math.max(0, Math.min(100, score));

  let verdict = "bot";
  if (!hardFail && sane && score >= 70) verdict = "human";
  else if (!hardFail && score >= 48) verdict = "review";

  return {
    score, verdict, signals,
    metrics: {
      cv, fastFrac, charsPerSec, wpm, dMed, dSd, rolloverFrac, longPauses, uniqueFrac,
      corrections, lexVariety, overlap, mouseUsed, straightness, meanTurn, speedCV,
      teleports, instantFrac, iGapCV, triedToSkipRating: triedToSkip, sliderValue: sl.finalValue,
    },
  };
}

// ---- helpers -------------------------------------------------------------
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function band(s) { return s >= 0.5 ? "pass" : s >= 0.25 ? "warn" : "fail"; }
function fmtScore(s) { return `${Math.round(s * 100)}`; }
function push(arr, status, label, detail, ok, val) {
  arr.push({ status, label, detail, ok: !!ok, val: val ?? "" });
}

export { MIN_CHARS };
