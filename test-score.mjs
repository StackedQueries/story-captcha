// Fixture test for the scorer. Builds synthetic sessions (keystrokes + mouse +
// interactions + slider/skip) and asserts the verdicts. Run: node test-score.mjs
import { scoreSession } from "./score.js";

// deterministic pseudo-random so the test is stable
let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = (m, s) => m + s * (rnd() + rnd() + rnd() - 1.5) * 2;

const PROMPT = "a cat who decides to become a chef";
const HUMAN_TEXT =
  "My cat Biscuit became a chef today. He knocked the salt on the floor and meowed proudly at his terrible soup.";

// ---- mouse path generators ----
function humanMouse() {
  const pts = [];
  let t = 0, x = 120, y = 420;
  const tx = 470, ty = 300, n = 44;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const wob = Math.sin(u * Math.PI * 3) * 18 * (1 - u) + (rnd() - 0.5) * 6;
    t += 8 + rnd() * 22; // variable 8–30ms steps
    pts.push({ t, x: x + (tx - x) * u + wob, y: y + (ty - y) * u - wob * 0.5 + (rnd() - 0.5) * 4 });
  }
  const clicks = [{ downT: t + 30, upT: t + 30 + gauss(95, 18), dwell: gauss(95, 18), x: tx, y: ty }];
  return { points: pts, clicks, pointerTypes: ["mouse"], moved: true, untrustedMoves: 0 };
}
function straightMouse() {
  const pts = [];
  let t = 0;
  for (let i = 0; i <= 22; i++) { t += 10; pts.push({ t, x: 120 + i * 16, y: 420 - i * 5 }); } // dead straight, constant v
  pts.push({ t: t + 4, x: 900, y: 90 }); // teleport
  return { points: pts, clicks: [{ downT: t, upT: t, dwell: 0, x: 470, y: 300 }], pointerTypes: ["mouse"], moved: true, untrustedMoves: 0 };
}
const noMouse = () => ({ points: [], clicks: [], pointerTypes: [], moved: false, untrustedMoves: 0 });

// ---- interaction timelines ----
const humanInteractions = () => [
  { type: "focus", t: 0 }, { type: "firstKey", t: 540 },
  { type: "mouseMove", t: 9000 }, { type: "slider", t: 9600 }, { type: "click", t: 12500 },
];
const instantInteractions = () => [
  { type: "focus", t: 0 }, { type: "firstKey", t: 4 }, { type: "click", t: 9 },
];

function buildSession(o) {
  const { text, gapMean, gapSd, dwellMean, dwellSd, pauses, backspaces, paste, untrusted, ghost } = o;
  const keystrokes = [];
  const events = [];
  let prevDown = null, prevUp = null;
  const n = ghost ? 4 : text.length;
  for (let i = 0; i < n; i++) {
    const iki = Math.max(1, gauss(gapMean, gapSd));
    const pause = pauses && i % 40 === 20 ? 600 + rnd() * 800 : 0;
    const down = prevDown === null ? 0 : prevDown + iki + pause;
    const dwell = Math.max(0, gauss(dwellMean, dwellSd));
    const up = down + dwell;
    keystrokes.push({
      key: text[i] || "x", downT: down, upT: up, dwell,
      flight: prevUp === null ? null : down - prevUp, // negative ⇒ rollover
      downDownGap: prevDown === null ? null : down - prevDown,
    });
    events.push({ type: "keydown", t: down, trusted: !untrusted });
    events.push({ type: "keyup", t: up, trusted: !untrusted });
    prevDown = down; prevUp = up;
  }
  if (paste) events.push({ type: "input", t: 1, inputType: "insertFromPaste" });
  return {
    startedAt: 0, events, keystrokes,
    pasteCount: paste ? 1 : 0, dropCount: 0, cutCount: 0,
    backspaceCount: backspaces || 0, deleteCount: 0, compositionCount: 0,
    untrustedCount: untrusted ? keystrokes.length * 2 : 0, blurCount: 0,
    finalText: text, durationMs: prevUp || 0,
    mouse: o.mouse || noMouse(),
    interactions: o.interactions || [],
    slider: o.slider || { moved: false, finalValue: 10, changes: [] },
    triedToSkipRating: !!o.triedToSkipRating,
  };
}

const H = { text: HUMAN_TEXT, gapMean: 140, gapSd: 90, dwellMean: 110, dwellSd: 28, pauses: true, backspaces: 5 };

const cases = [
  { name: "HUMAN — typing + human mouse + tried to skip the rating", expect: "human",
    s: buildSession({ ...H, mouse: humanMouse(), interactions: humanInteractions(), slider: { moved: true, finalValue: 4, changes: [] }, triedToSkipRating: true }) },
  { name: "HUMAN — keyboard-only, tried to skip the rating", expect: "human",
    s: buildSession({ ...H, interactions: humanInteractions(), slider: { moved: true, finalValue: 7, changes: [] }, triedToSkipRating: true }) },
  { name: "BOT — metronome keys + straight-line teleport mouse + instant actions", expect: "bot",
    s: buildSession({ text: HUMAN_TEXT, gapMean: 40, gapSd: 0.3, dwellMean: 0, dwellSd: 0, mouse: straightMouse(), interactions: instantInteractions() }) },
  { name: "BOT — superhuman speed", expect: "bot",
    s: buildSession({ text: HUMAN_TEXT, gapMean: 8, gapSd: 2, dwellMean: 4, dwellSd: 1 }) },
  { name: "BOT — pasted", expect: "bot",
    s: buildSession({ ...H, paste: true, mouse: humanMouse() }) },
  { name: "BOT — synthetic untrusted events", expect: "bot",
    s: buildSession({ ...H, untrusted: true }) },
  { name: "BOT — programmatic value-set (ghost keystrokes)", expect: "bot",
    s: buildSession({ text: HUMAN_TEXT, gapMean: 100, gapSd: 50, dwellMean: 60, dwellSd: 15, ghost: true }) },
];

let pass = 0;
for (const c of cases) {
  const r = scoreSession(c.s, PROMPT);
  const ok = r.verdict === c.expect;
  pass += ok ? 1 : 0;
  console.log(`${ok ? "✓" : "✗"} ${c.name}`);
  console.log(`    verdict=${r.verdict} score=${r.score} (expected ${c.expect})`);
  if (!ok) for (const sig of r.signals) console.log(`      [${sig.status}] ${sig.label}: ${sig.detail}`);
}
console.log(`\n${pass}/${cases.length} cases passed`);
process.exit(pass === cases.length ? 0 : 1);
