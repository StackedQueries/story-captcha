# STORYPROOF — a keystroke-biometric CAPTCHA

**Version:** 0.1 · **Status:** prototype (static page, all scoring client-side)
**One line:** Prove you're human by *writing* — a ~100-character story on a random
easy prompt. It isn't *what* you write that proves humanity, it's *how* you type it,
cross-checked against the fact that you actually answered *this* prompt.

---

## 1. Motivation

Traditional CAPTCHAs (image grids, distorted text) are increasingly solved by ML and
sold as a service. Keystroke dynamics — the micro-timing of how a person presses and
releases keys — is a behavioral biometric that is cheap to capture and hard to fake
*by hand*. A free-text writing task is a natural vehicle: it produces a rich timing
stream **and** content that can be sanity-checked.

But the research is unambiguous about a trap: **timing alone is not sufficient.**
Multiple adversarial studies show that an attacker who samples inter-keystroke
intervals from public human distributions defeats timing-only classifiers at
**≥99.8%** evasion, because keystroke timing carries *zero mutual information about
what was written* — you can wrap any text (or replayed timing) in a human-looking
rhythm.[B] So STORYPROOF deliberately combines three independent signal families and
requires a session to look human on **all three**.

---

## 2. Threat model

| Adversary | Technique | Primary defense |
|---|---|---|
| Naive script | `el.value = "..."`, `execCommand`, `dispatchEvent` | Provenance: untrusted events, keystroke/char ratio |
| Paste / autofill | clipboard, password-manager, drag-drop | Provenance: `paste`/`drop`/`insertFromPaste` |
| Constant-delay bot | type with fixed `setTimeout` delay | Timing: variance (CV), repeated-interval detection |
| Fast bot | type faster than humanly possible | Timing: sub-50ms fraction, chars/sec ceiling |
| Statistical-mimicry bot | sample IKIs from human distributions[B][H] | **Content**: must answer *this random prompt* |
| Replay bot | replay a captured human's timing stream[I] | **Content**: replayed old text ≠ fresh random prompt |
| Headless / scripted mouse | jump cursor, straight-line moves, 0ms clicks | Mouse: curvature, velocity variance, teleports, click dwell |
| Form-filler | dutifully fills every field + rates + submits | Behavior: compliance probe — bots rate-then-verify; humans try to skip (§4.8) |

The mimicry/replay rows are the dangerous ones, and the reason the **random prompt +
relevance check** exists: a forged/replayed timing stream still has to emit text that
responds to a prompt the attacker couldn't see in advance. That's the one thing timing
forgery provably cannot supply.[B] The **required rating** adds a second adaptive step a
naive form-filler won't satisfy (see §4.8).

---

## 3. What we capture (`capture.js`)

High-resolution, monotonic `performance.now()` timeline of every keyboard, mouse, and
interaction event:

- **keydown / keyup** per key → **dwell** (hold = up − down) and **flight / IKI**
  (press-to-press gap, the standard inter-keystroke-interval measure).
- **paste, drop, cut, compositionstart** (IME), **blur**, **focus**.
- **input** with `inputType` (catches autofill/paste even when key events are absent).
- **pointermove** (throttled ~160 Hz, capped) → cursor path `{t,x,y}`; **pointerdown /
  pointerup** → click **dwell** and position; **pointerType** (mouse / touch / pen).
- **slider input** → rating value + change timeline (the required "rate this CAPTCHA").
- A unified **interaction timeline** of salient actions (focus, first keystroke, first
  mouse move, slider change, click) for measuring the gaps *between* interactions.
- **isTrusted** on every event (synthetic JS events are `false`) — incl. fake mouse moves.
- Counts: backspace, delete, paste, drop, untrusted, composition.

No data leaves the browser.

---

## 4. Empirical thresholds (and their sources)

The strongest numeric anchors are from **Dhakal et al., CHI 2018** — the Aalto "136M
Keystrokes" study of **168,000 participants**, the largest keystroke corpus available.[A]
Its task was *transcription* on physical/laptop keyboards, so absolute values transfer
only approximately to free-text composition (composition yields **more** pausing and
correction) and to mobile/touch keyboards — treat them as reference, not law.

### 4.1 Timing — human reference ranges (Dhakal CHI 2018 unless noted)
- **Inter-key interval (IKI / flight):** mean **238.66ms (SD 111.6)**, hard lower bound
  **~60ms**; fast typists ~120ms (SD ~11), slow >480ms (SD >120). Distribution is
  right-skewed (skew ~2.0). *Variance itself is the signal.* STORYPROOF uses the
  coefficient of variation (CV=σ/μ): **CV ≥ 0.5** solidly human, **CV < 0.18** robotic.
- **Dwell (key-hold):** a tight motor constant — mean **116.24ms (SD 23.88)**, staying in
  the **80–150ms** band even for slow typists. Dwell ≈ 0 or a single constant value ⇒
  synthetic. The real tell is the *within-band variance* scripted input lacks.
- **Digraph/bigram latency is structured, not uniform:** hand-alternation 198ms,
  left-hand 215ms, right-hand 204ms, letter-repetition 176ms — key-pair- and
  hand-dependent. Uniform/random bot timings have no such structure.
- **Sub-50ms gaps:** ~**5.82%** of human intervals are <50ms vs ~**21.49%** for bots;[D]
  bots also hold keys briefly (**23.11%** of human keystrokes held <300ms vs **45.42%**
  bot).[D] STORYPROOF flags if **>25%** of gaps are sub-50ms or sustained **>22 chars/s
  (~216 wpm)**. *(2013-era figures — evadable, but reliable against naive scripts.)*

### 4.2 Rollover (key-overlap) — the strongest human-only signal
- Humans press the next key **before releasing** the previous one, so **25–50%** of
  presses overlap (fast typists **40–70%**; every typist group ≥~19%).[A] Naive
  synthetic key injection produces **0%** overlap. A practitioner scorer weights this
  highest (0.25 of its blend).[G] STORYPROOF detects it as the fraction of **negative
  flight times** and treats ≥~20% as full credit, kept *soft* (slow hunt-and-peck and
  some mobile keyboards overlap less, so it lowers the score rather than hard-failing).

### 4.3 Cognitive pauses & bursts
- Natural composition is **burst-and-pause**: the keystroke-logging standard defines a
  burst as text with no IKI longer than **2 seconds**; pauses >2s mark sentence/clause
  boundaries and index planning load, while average IKI stays stable across tasks.[E]
  Individualized thresholds (~2× the writer's median for sentence pauses, ~1.5× for
  within-word) beat a fixed cutoff.[E] For a short ~100-char story STORYPROOF uses a
  softer **>500ms** "micro-pause/planning" proxy and wants **≥1** — a 100-char passage
  with zero hesitations is suspiciously metronomic.

### 4.4 Correction behavior
- Correction is pervasive and a strong human signal: mean **KSPC 1.173 (SD 0.094)**,
  ~**6.3%** of keystrokes corrected, **2.29** corrections/sentence (99th pct ~8.5
  backspaces/sentence).[A] **Near-zero backspaces or KSPC = 1.0 is atypical** of genuine
  typing (and composition corrects *more* than the transcription task these come from).
  A true "revision" is deletion **plus retyped replacement**, not a lone backspace.[F]
  STORYPROOF treats corrections as a **soft positive** (absence is a warning, not a hard
  fail — a clean short sentence is plausible).

### 4.5 Why content is mandatory, not optional
- Timing alone is **evadable**: statistical forgeries reach **~15% false-acceptance**
  when the attacker has target-user data, and a dedicated liveness classifier hits only
  1–2% FAR/FRR **against weak (general-population-data) attackers**.[C] Because keystroke
  timing carries *zero information about what was written*, the **random prompt +
  relevance check** is the cheap, backend-free defense forgery/replay cannot satisfy —
  it must produce text answering a prompt the attacker couldn't see in advance.

### 4.6 Mouse dynamics
- The behavioral-biometrics survey literature defines the discriminating features straight
  from raw `(x,y,t)`:[J] **curvature** κ = 1/r (exactly 0 for a straight line), **straightness
  / efficiency** = displacement ÷ path-distance (→ 1.0 for bot-like straight paths),
  **tremor/jitter** = interpolated ÷ actual path length (→ 1.0 = no micro-jitter), plus
  **velocity, acceleration, tangential jerk, angular velocity** distributions. Human motion
  also has **neuromotor structure** (Sigma-Lognormal): an initial acceleration burst and a
  final **low-velocity fine-correction** as the cursor nears the target — "difficult to
  emulate for bots"; a single trajectory scores ~93% human-vs-bot in BeCAPTCHA-Mouse.[K]
- **Clicks** are their own signal: mousedown→mouseup **dwell**, time-to-click, pause count,
  and paused-ratio.[J] Bots show no hover-before-click and ≈ 0ms dwell.
- STORYPROOF computes a usable subset *only when a real mouse/pen moved:* curvature (mean
  direction change/sample + straightness), velocity-CV, **teleports** (>160px jump in
  <16ms = no intermediate samples), and click dwell.
- ⚠️ **No hard velocity cutoffs.** Verification *refuted* the specific 2013 numbers (human
  ~427 px/s vs bot ~1521 px/s; efficiency > 0.94 cutoff) — treat speed/efficiency as
  directional, not authoritative. STORYPROOF keys on *variance and structure*, not absolute
  px/s.
- *Caveat:* touch and keyboard-only users produce no usable cursor path — those sessions
  mark the mouse signal **n/a** and reweight onto keystrokes (never a hard fail).

### 4.7 Interaction timing
- Distinct UI actions are separated by **human reaction time**: mean simple reaction time
  is **~210–240ms** with a **hard anticipatory floor near 110ms** — responses faster than
  ~110ms are excluded as non-genuine.[L] STORYPROOF builds a unified timeline (focus →
  first key → mouse → slider → click) and flags sessions where a large fraction of
  inter-action gaps fall **below ~120ms** (sub-reaction-time) or have near-zero spread —
  the signature of a script firing actions instantly or at one uniform delay.

### 4.8 Behavior — the required rating as a compliance probe
- A 1–10 **rating slider defaults to 10** and is **required to complete** — but the page
  never says so until "Verify I'm human" is pressed. The discriminator is *not* whether you
  rate it (everyone must, eventually) — it's whether you **tried to skip** it:
  - **A bot is dutiful**: it sees the rating control, rates it, then clicks verify. It never
    trips the hidden requirement → scored as **compliant (bot-leaning, −5)**.
  - **A human dodges busywork**: they hit "Verify I'm human" and ignore the rating; the page
    then reveals it's required and forces them to rate to continue. That **skip attempt**
    (verify-before-rate) is the human tell → **+8**.
- It is a **weak, deliberately playful signal** — it nudges the score, adds an adaptive step
  and extra interaction-timing surface; it is *not* load-bearing, and a bot that learns to
  verify-first defeats it. (Reaction-time of the skip→forced-rate sequence is also captured
  by §4.7.)

---

## 5. Scoring (`score.js`)

Six families. Provenance and content are gates; timing, mouse, and interaction are blended;
behavior nudges.

**A. Provenance (hard gates — any one ⇒ reject):**
1. No paste / drop / `insertFromPaste`-style input.
2. No untrusted (synthetic) events — incl. fake `pointermove`.
3. keystrokes/char ratio ≥ 0.5 (else value was set programmatically).
4. ≥70 chars and ≥40 keystrokes (else "not enough" — forgiven only as data, not a tell).

**B. Keystroke timing (blended, weights below):**

| Signal | Weight | Human-pass | Bot-fail |
|---|---|---|---|
| Rhythm variability (CV) | 0.22 | CV ≥ 0.5 | CV < 0.18 |
| Plausible speed | 0.15 | <12 chars/s, <8% sub-50ms | >22 chars/s or >25% sub-50ms |
| Dwell profile | 0.16 | median 25–250ms, σ > 5ms | dwell ≈ 0 / constant |
| Key-overlap (rollover) | 0.15 | ≥20% negative flights | 0% overlap |
| Non-repeating intervals | 0.14 | >50% unique gap values | <50% unique (metronomic) |
| Cognitive pauses | 0.10 | ≥1 pause >500ms | none |
| Correction behavior | 0.08 | ≥1 backspace/delete | none (soft) |

**C. Content (anti-replay / anti-mimicry):**
1. *Reads like language* — ≥8 words, avg word length 2.5–12, unique-word ratio >0.35.
2. *On-topic* — overlaps ≥1 content word with the randomized prompt.

**D. Mouse** (0..1, only if a real mouse/pen moved): curvature 0.4 · velocity-CV 0.3 ·
no-teleport 0.2 · click-dwell 0.1. **E. Interaction timing** (0..1): `(1 − sub-120ms
fraction) · 0.6 + (gap-CV) · 0.4`. **F. Behavior**: **+8** if they tried to skip the rating
(hit verify before rating — human), **−5** if they rated then verified (compliant — bot).

**Composite:** `base = mouseUsed ? ks·0.55 + mouse·0.25 + interaction·0.20 : ks·0.75 +
interaction·0.25`, then `×100 + slider bonus`. Floors: `!sane → ≤20`, `tooFast ||
metronomic → ≤35`, any hard provenance fail → ≤8; minus a relevance penalty.

**Verdict bands:** `human ≥ 70` · `review 48–69` · `bot < 48`.
(`review` = borderline; a real deployment escalates to a second challenge.)

---

## 6. Known limitations (be honest)

- **CDP/driver input can be trusted.** Playwright/Puppeteer `type()` produces trusted
  events and *can* inject per-key delay jitter. STORYPROOF catches naive versions via
  variance + content, but a tool that samples human IKIs *and* writes a relevant story
  on the fly would pass — consistent with the ≥99.8% timing-evasion result.[B] The
  random prompt raises the cost (the attacker needs real-time relevant generation), it
  doesn't make it impossible. A production system pairs this with rate limiting,
  proof-of-work, and server-side replay/nonce checks.
- **Accessibility.** Switch access, dictation, on-screen keyboards, and IME users
  produce atypical timing. The `review` band and a non-keystroke fallback challenge are
  required for a real deployment — never hard-fail on timing alone.
- **Mobile / touch / trackpad.** Touch keyboards have different dwell/flight profiles and
  autocorrect rewrites; touch produces **no cursor path** (mouse signal goes n/a);
  trackpad motion is choppier than a mouse. Thresholds here are tuned for physical
  keyboard + mouse and would need device-class profiles.
- **Mouse mimicry.** Humanlike-cursor libraries (e.g. ghost-cursor) and GAN/RNN trajectory
  synthesis reproduce curvature, tremor, and velocity profiles — so mouse dynamics, like
  keystroke timing, defeat naive bots but not a determined mimic. It is one weak signal in
  the blend, never a gate.
- **The required-rating compliance probe is theater, not security.** It exploits that
  naive bots dutifully rate-then-verify while humans try to skip the busywork — but a bot
  that learns to click verify first defeats it, and an over-eager human who rates first
  gets dinged (−5, never fatal). Treat it as a tarpit/telemetry nudge, not a real barrier.
- **Client-side scoring is inspectable.** This prototype scores in-browser for demo
  transparency (`window.__storyproof`). Production must score server-side from the raw
  event log so the attacker can't read the rubric.

---

## 7. Files

| File | Role |
|---|---|
| `index.html` | Page shell + prompt UI |
| `styles.css` | Cyber-brutalist dark theme |
| `topics.js` | Random easy-prompt bank + picker |
| `capture.js` | Keystroke + mouse + interaction-timeline + slider recorder (capture only) |
| `score.js` | Six-family humanness scorer + thresholds |
| `app.js` | Wiring: prompt → record → score → verdict; required-rating gate |
| `test-score.mjs` | Node fixture tests (keystroke / mouse / interaction / slider) |

---

## 8. Sources

Synthesized from two fan-out research passes — keystroke dynamics (19 sources, 88 claims,
25 verified → 20 confirmed) and mouse/interaction dynamics (20 sources, 87 claims, 25
verified → 21 confirmed). Confirmed claims drive the numbers above; the refuted ones are
why §4 avoids brittle single cutoffs.

**Keystroke dynamics [A–I]:**

- **[A]** Dhakal, Feit, Kristensson & Oulasvirta, *Observations on Typing from 136 Million
  Keystrokes*, **CHI 2018** (n=168,000). The primary anchor — IKI 238.66ms (SD 111.6),
  dwell 116.24ms (SD 23.88), hand-dependent bigram latencies, rollover 25–70%, KSPC 1.173.
  `dl.acm.org/doi/pdf/10.1145/3173574.3174220`
- **[B]** *On the Insecurity of Keystroke-Based AI Authorship Detection: Timing-Forgery
  Attacks* — arXiv:2601.17280. Three forgery attacks reach **≥99.8%** evasion of five
  classifiers; timing carries zero content information.
- **[C]** Gonzalez et al., *Spoofing & liveness in free-text keystroke dynamics*,
  **Systems and Soft Computing 4 (2022)**, Elsevier. Best forgery ~**15% FAR** with
  target-user data; liveness classifier **1–2% FAR/FRR** only against weak attackers.
  `sciencedirect.com/science/article/pii/S2772941922000047`
- **[D]** Chu, Wang et al., *Blog-bot detection via keystroke/timing*, **Computer Networks
  2013**, Elsevier. Sub-50ms gaps **5.82%** human vs **21.49%** bot; dwell <300ms
  **23.11%** human vs **45.42%** bot; fixed-timer clustering ⇒ low entropy.
  `eecis.udel.edu/~hnw/paper/comnet13.pdf`
- **[E]** Van Waes et al., *Bursts & pauses in writing* (**Reading and Writing 2019**,
  Springer) + Rosenqvist 2015 — 2s burst boundary; individualized pause thresholds
  (~2× median sentence, ~1.5× within-word). `link.springer.com/article/10.1007/s11145-019-09953-8`
- **[F]** Conijn et al., *Automated extraction of revision events from keystroke data*
  (**Reading and Writing 2021**, Springer) — a revision = deletion **+** retyped
  replacement, not a lone backspace.
- **[G]** *isHumanCadence* (open-source) — practical six-signal cadence scorer that weights
  rollover highest (0.25) and implements paste/constant-interval/uniform-jitter/replay
  detectors. *Non-peer-reviewed; its weights are design choices.* `github.com/RoloBits/isHumanCadence`
- **[H]** *Conditional GAN for Keystroke Presentation Attack* (arXiv:2212.08445) +
  Stefan, Shu & Yao, *Robustness of Keystroke-Dynamics Against Synthetic Forgeries*
  (GaussianBot / NoiseBot) — statistical/GAN synthesis of human-like dwell/flight.
- **[I]** *Spoofing keystroke dynamics … from screen-recorded video* (**J. Big Data 2022**,
  Springer) — replay of genuine captured timing.

**Mouse & interaction dynamics [J–M]:**

- **[J]** Khan, Devlen, Manno & Hou, *Mouse Dynamics Behavioral Biometrics: A Survey*,
  **ACM Computing Surveys 2024** (DOI 10.1145/3640311 = arXiv:2208.09061). The feature
  taxonomy — curvature κ=1/r, straightness=displacement/path-distance, tremor=interpolated/
  actual path, velocity/acceleration/jerk/angular-velocity, and click dwell/pause features.
- **[K]** Acien, Morales, Fierrez & Vera-Rodriguez, *BeCAPTCHA-Mouse*, **Pattern Recognition
  2022** (arXiv:2005.00890). Sigma-Lognormal neuromotor model — human initial-acceleration +
  final low-velocity fine-correction; ~93% single-trajectory bot detection (own benchmark;
  velocity-profile synthetics still fooled it up to ~17%).
- **[L]** Woods et al., *Factors influencing simple reaction time*, **Front. Hum. Neurosci.
  2015** (PMC4374455, n=1,469). Mean SRT ~231ms (213 hardware-corrected); 110–1000ms valid
  response window — the ~110ms anticipatory floor grounds the sub-reaction-time heuristic.
- **[M]** *ghost-cursor* (`github.com/Xetera/ghost-cursor`) + *DMTG: diffusion mouse-trajectory
  generator* (arXiv:2410.18233, 2024). The mimicry frontier — Bézier + Fitts's-law point
  counts + deliberate overshoot/re-adjust; diffusion/GAN synthesis degrades detectors
  4.75–9.73%. Why mouse dynamics is a weak blended signal, never a gate.

**Verification *refuted* (do not implement):** *(keystroke)* a fixed flight-SD <20ms cutoff;
a per-keystroke "sub-60ms is physically impossible" rule; "100% detection" claims; and
"zero corrections is normal for half of typists" (it is **atypical**). *(mouse)* the 2013
absolute velocity cutoffs (human ~427 vs bot ~1521 px/s, ~3500 px/s cap) and the
straightness=1.0 / efficiency>0.94 hard thresholds — directional only. All are why
STORYPROOF scores aggregate distributions and blends many weak signals instead of trusting
one hard line.
