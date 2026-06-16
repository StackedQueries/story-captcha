// capture.js — keystroke + mouse + interaction telemetry recorder.
//
// Records a high-resolution, monotonic timeline of keyboard, editing, mouse, and
// general interaction events for one challenge. It is intentionally "dumb": it
// only records, it does not judge. Scoring lives in score.js so the two can be
// tested and tuned independently.
//
// All times are performance.now() ms (monotonic, sub-ms, immune to clock changes).
//
// createRecorder(el, opts):
//   el          — the textarea being typed into
//   opts.slider — (optional) the <input type=range> rating control to track
//   opts.root   — (optional) element to bind mouse listeners to (default: window)

export function createRecorder(el, opts = {}) {
  const root = opts.root || window;
  const slider = opts.slider || null;

  const session = {
    startedAt: null, // perf time of first interaction (any kind)
    events: [], // raw event log
    keystrokes: [], // reconstructed per-character keystrokes with dwell/flight
    pasteCount: 0,
    dropCount: 0,
    cutCount: 0,
    backspaceCount: 0,
    deleteCount: 0,
    compositionCount: 0, // IME usage — informational
    untrustedCount: 0, // events with isTrusted === false (synthetic)
    blurCount: 0,
    finalText: "",
    durationMs: 0,

    // --- mouse / pointer dynamics ---
    mouse: {
      points: [], // throttled {t,x,y} move samples
      clicks: [], // {downT,upT,dwell,x,y}
      pointerTypes: [], // observed pointerType strings ('mouse'|'touch'|'pen')
      moved: false,
      untrustedMoves: 0,
    },

    // --- unified interaction timeline (for inter-interaction gaps) ---
    // {type, t} for the salient actions a human strings together.
    interactions: [],

    // --- the rating slider ("rate this CAPTCHA") — required, but not announced ---
    slider: { changes: [], firstMoveT: null, finalValue: null, moved: false },
    // set true by app.js if the user hits "verify" before rating (a human tell)
    triedToSkipRating: false,
  };

  const downAt = new Map();
  let lastUpAt = null;
  let lastDownAt = null;
  let firstKeyMarked = false;
  let lastMoveStored = -1e9;
  const pointerDownAt = new Map();

  const now = () => performance.now();

  function mark(type, extra) {
    const t = now();
    if (session.startedAt === null) session.startedAt = t;
    session.events.push({ type, t, ...extra });
    return t;
  }

  // Record a salient interaction into the unified timeline (deduped on rapid repeats).
  function interaction(type, t) {
    const arr = session.interactions;
    const last = arr[arr.length - 1];
    if (last && last.type === type && t - last.t < 40) return; // collapse jitter
    arr.push({ type, t });
  }

  const isPrintable = (e) => e.key && e.key.length === 1;

  // ---------- keyboard ----------
  function onKeyDown(e) {
    const t = mark("keydown", { key: e.key, code: e.code, trusted: e.isTrusted, repeat: e.repeat });
    if (!e.isTrusted) session.untrustedCount++;
    if (e.key === "Backspace") session.backspaceCount++;
    if (e.key === "Delete") session.deleteCount++;
    if (!firstKeyMarked) {
      firstKeyMarked = true;
      interaction("firstKey", t);
    }
    if (isPrintable(e) && !e.repeat) {
      downAt.set(e.code, { t, key: e.key, downDownGap: lastDownAt === null ? null : t - lastDownAt });
      lastDownAt = t;
    }
  }

  function onKeyUp(e) {
    const t = mark("keyup", { key: e.key, code: e.code, trusted: e.isTrusted });
    if (!e.isTrusted) session.untrustedCount++;
    const d = downAt.get(e.code);
    if (d) {
      session.keystrokes.push({
        key: d.key,
        downT: d.t,
        upT: t,
        dwell: t - d.t,
        flight: lastUpAt === null ? null : d.t - lastUpAt,
        downDownGap: d.downDownGap,
      });
      downAt.delete(e.code);
      lastUpAt = t;
    }
  }

  // ---------- editing / clipboard ----------
  const onPaste = (e) => { session.pasteCount++; mark("paste", { len: (e.clipboardData && e.clipboardData.getData("text").length) || 0 }); };
  const onDrop = () => { session.dropCount++; mark("drop", {}); };
  const onCut = () => { session.cutCount++; mark("cut", {}); };
  const onCompositionStart = () => { session.compositionCount++; mark("compositionstart", {}); };
  const onBlur = () => { session.blurCount++; mark("blur", {}); };
  const onFocus = (e) => interaction("focus", mark("focus", { trusted: e.isTrusted }));
  const onInput = (e) => mark("input", { inputType: e.inputType || "", dataLen: (e.data && e.data.length) || 0 });

  // ---------- mouse / pointer ----------
  function onPointerMove(e) {
    const t = now();
    if (session.startedAt === null) session.startedAt = t;
    if (e.pointerType && !session.mouse.pointerTypes.includes(e.pointerType)) {
      session.mouse.pointerTypes.push(e.pointerType);
    }
    if (!e.isTrusted) session.mouse.untrustedMoves++;
    // throttle to ~160 Hz max; cap total for memory safety
    if (t - lastMoveStored < 6) return;
    lastMoveStored = t;
    if (session.mouse.points.length < 4000) {
      session.mouse.points.push({ t, x: e.clientX, y: e.clientY });
    }
    if (!session.mouse.moved) {
      session.mouse.moved = true;
      interaction("mouseMove", t);
    }
  }

  function onPointerDown(e) {
    const t = mark("pointerdown", { x: e.clientX, y: e.clientY, trusted: e.isTrusted, pointerType: e.pointerType });
    pointerDownAt.set(e.pointerId ?? 0, { t, x: e.clientX, y: e.clientY });
    interaction("click", t);
  }

  function onPointerUp(e) {
    const t = mark("pointerup", { x: e.clientX, y: e.clientY, trusted: e.isTrusted });
    const d = pointerDownAt.get(e.pointerId ?? 0);
    if (d) {
      session.mouse.clicks.push({ downT: d.t, upT: t, dwell: t - d.t, x: d.x, y: d.y });
      pointerDownAt.delete(e.pointerId ?? 0);
    }
  }

  // ---------- slider ----------
  function onSliderInput(e) {
    const t = mark("slider", { value: Number(e.target.value), trusted: e.isTrusted });
    session.slider.finalValue = Number(e.target.value);
    session.slider.changes.push({ t, value: Number(e.target.value) });
    if (!session.slider.moved) {
      session.slider.moved = true;
      session.slider.firstMoveT = t;
    }
    interaction("slider", t);
  }

  el.addEventListener("keydown", onKeyDown, true);
  el.addEventListener("keyup", onKeyUp, true);
  el.addEventListener("paste", onPaste, true);
  el.addEventListener("drop", onDrop, true);
  el.addEventListener("cut", onCut, true);
  el.addEventListener("compositionstart", onCompositionStart, true);
  el.addEventListener("blur", onBlur, true);
  el.addEventListener("focus", onFocus, true);
  el.addEventListener("input", onInput, true);

  root.addEventListener("pointermove", onPointerMove, true);
  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("pointerup", onPointerUp, true);

  if (slider) slider.addEventListener("input", onSliderInput, true);

  return {
    session,
    /** Freeze the session: stamp duration + final text. Returns the session. */
    finalize() {
      session.finalText = el.value;
      if (slider && session.slider.finalValue === null) session.slider.finalValue = Number(slider.value);
      const last = session.events.length ? session.events[session.events.length - 1].t : session.startedAt;
      session.durationMs = session.startedAt === null ? 0 : last - session.startedAt;
      return session;
    },
    /** Detach all listeners. */
    destroy() {
      el.removeEventListener("keydown", onKeyDown, true);
      el.removeEventListener("keyup", onKeyUp, true);
      el.removeEventListener("paste", onPaste, true);
      el.removeEventListener("drop", onDrop, true);
      el.removeEventListener("cut", onCut, true);
      el.removeEventListener("compositionstart", onCompositionStart, true);
      el.removeEventListener("blur", onBlur, true);
      el.removeEventListener("focus", onFocus, true);
      el.removeEventListener("input", onInput, true);
      root.removeEventListener("pointermove", onPointerMove, true);
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("pointerup", onPointerUp, true);
      if (slider) slider.removeEventListener("input", onSliderInput, true);
    },
  };
}
