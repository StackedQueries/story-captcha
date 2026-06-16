// app.js — wires the prompt, the recorder, and the scorer to the DOM.
import { pickTopic } from "./topics.js";
import { createRecorder } from "./capture.js";
import { scoreSession, MIN_CHARS } from "./score.js";

const el = {
  topic: document.getElementById("topic"),
  refresh: document.getElementById("refresh"),
  story: document.getElementById("story"),
  count: document.getElementById("count"),
  bar: document.getElementById("bar"),
  rating: document.getElementById("rating"),
  rateLabel: document.getElementById("rateLabel"),
  rateHint: document.getElementById("rateHint"),
  rate: document.getElementById("rate"),
  rateOut: document.getElementById("rateOut"),
  verify: document.getElementById("verify"),
  status: document.getElementById("status"),
  verdict: document.getElementById("verdict"),
  vtag: document.getElementById("vtag"),
  vscore: document.getElementById("vscore"),
  signals: document.getElementById("signals"),
};

const TARGET = 100;
let currentTopic = null;
let recorder = null;

function newRound() {
  currentTopic = pickTopic();
  el.topic.textContent = currentTopic.text;
  el.story.value = "";
  el.story.disabled = false;
  el.rate.value = "10";
  el.rateOut.textContent = "10";
  el.rating.classList.remove("required");
  el.rateHint.textContent = "1 = hostile · 10 = delightful";
  el.verdict.classList.remove("show");
  el.signals.innerHTML = "";
  el.status.textContent = "Keep writing…";
  if (recorder) recorder.destroy();
  // Pass the slider so its drags are recorded; mouse is bound at window level.
  recorder = createRecorder(el.story, { slider: el.rate });
  update();
  el.story.focus();
}

function update() {
  const len = el.story.value.length;
  el.count.textContent = `${len} / ${TARGET}`;
  el.count.className = "count" + (len > TARGET ? " over" : len >= MIN_CHARS ? " ok" : "");
  el.bar.style.width = `${Math.min(100, (len / TARGET) * 100)}%`;
  const ready = len >= MIN_CHARS;
  el.verify.disabled = !ready;
  if (!ready) {
    el.status.textContent = `${MIN_CHARS - len} more characters to unlock verify`;
  } else {
    el.status.textContent = "Looks good — verify when ready.";
  }
}

function renderVerdict(result) {
  el.verdict.classList.add("show");
  const tagClass = result.verdict === "human" ? "tag-human" : result.verdict === "review" ? "tag-review" : "tag-bot";
  const tagText = result.verdict === "human" ? "✓ human" : result.verdict === "review" ? "needs review" : "✗ bot";
  el.vtag.className = "verdict-tag " + tagClass;
  el.vtag.textContent = tagText;
  el.vscore.textContent = result.score;

  el.signals.innerHTML = "";
  for (const s of result.signals) {
    const row = document.createElement("div");
    row.className = "signal " + s.status;
    const ico = s.status === "pass" ? "✓" : s.status === "warn" ? "▲" : "✗";
    row.innerHTML = `
      <span class="ico">${ico}</span>
      <span><span class="label">${s.label}</span> · <span class="detail">${s.detail}</span></span>
      <span class="val">${s.val}</span>`;
    el.signals.appendChild(row);
  }
  el.status.textContent =
    result.verdict === "human"
      ? "Verified. You may proceed."
      : result.verdict === "review"
      ? "Borderline — a real deployment would add a second challenge."
      : "Rejected as automated input.";
}

// The rating is REQUIRED — but we don't announce that until verify is pressed.
// The tell: a BOT dutifully rates and then verifies; a HUMAN hits verify and tries
// to skip the busywork. So pressing verify *before* rating is the human signal — we
// record it, THEN force the rating to complete. (Bots that rate-first never trip it.)
function onVerify() {
  if (!recorder.session.slider.moved) {
    recorder.session.triedToSkipRating = true; // <-- the human tell
    el.rating.classList.add("required");
    el.rateHint.textContent = "← required: rate it before verifying";
    el.status.textContent = "One more thing — rate this CAPTCHA to continue.";
    el.rate.focus();
    return;
  }
  const session = recorder.finalize();
  const result = scoreSession(session, currentTopic.text);
  renderVerdict(result);
  // Expose the raw session for inspection / automated testing.
  window.__storyproof = { session, result };
}

el.story.addEventListener("input", update);
el.rate.addEventListener("input", () => {
  el.rateOut.textContent = el.rate.value;
  el.rating.classList.remove("required");
  el.rateHint.textContent = "1 = hostile · 10 = delightful";
});
el.verify.addEventListener("click", onVerify);
el.refresh.addEventListener("click", newRound);

newRound();
