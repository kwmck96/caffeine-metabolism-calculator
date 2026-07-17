import React, { useState, useRef, useEffect } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

/* ============================================================================
   TUNABLE SCIENCE PARAMETERS
   All of the modeling assumptions live here so they're easy to find and change.
   Sources are summarized in the "Model & sources" panel at the bottom of the app.
   ========================================================================== */
const CONFIG = {
  // Elimination half-life (hours) by habitual daily caffeine intake, non-smoker.
  // Baseline for a healthy adult is ~4–5 h. The gradient by habitual use is
  // DIRECTIONALLY supported (caffeine mildly induces its own CYP1A2 metabolism)
  // but the magnitude is a rough approximation, and is far smaller than the
  // genetic (CYP1A2) variation between people. Treated as low-confidence.
  halfLifeByUse: {
    none: 5.5,
    low: 5.2,
    moderate: 5.0,
    high: 4.5,
  },
  defaultUse: "moderate",
  // Smoking (combustible tobacco) multiplier on half-life. Cigarette SMOKE — not
  // nicotine itself — induces CYP1A2 and speeds clearance ~40–65% (t½ ~6h -> ~3.5h).
  // Vaping / gum / patches do NOT have this effect.
  smokingMultiplier: 0.6,
  // First-order absorption half-life (minutes). ~8.5 min yields a time-to-peak of
  // ~45 min at a 5 h elimination half-life (caffeine is ~99% absorbed by ~45 min;
  // plasma peaks ~15–120 min after intake). Actual time-to-peak is derived from
  // this plus the user's elimination rate, so it shifts a little with half-life.
  absorptionHalfLifeMin: 8.5,
  negligibleMg: 10, // "Completely metabolized" threshold, in mg remaining in body.
  safeDailyLimitMg: 400, // EFSA/FDA guidance for healthy, non-pregnant adults.
};

/* ---------- palette (cool, clinical light theme; amber = caffeine) --------- */
const C = {
  page: "#F5F6F8",
  card: "#FFFFFF",
  ink: "#161A20",
  muted: "#5C6470",
  faint: "#8A929E",
  border: "#E3E6EB",
  caffeine: "#C2751A", // amber curve
  caffeineSoft: "rgba(194,117,26,0.16)",
  dose: "#8A5A2B", // brown dotted line
  workout: "#0E9F6E", // green
  bedtime: "#5B60E6", // indigo
  warnText: "#B42318",
  warnBg: "#FEF3F2",
  warnBorder: "#FDA29B",
};

/* ============================================================================
   TIME + MODEL HELPERS
   ========================================================================== */
const pad = (n) => String(n).padStart(2, "0");

function parseHM(str) {
  // "HH:MM" -> minutes from midnight, or null
  if (!str || typeof str !== "string" || !str.includes(":")) return null;
  const [h, m] = str.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToClock(min) {
  const m = (((Math.round(min) % 1440) + 1440) % 1440);
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${pad(mm)} ${period}`;
}

function durationText(min) {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Caffeine remaining in the body (mg) at absolute time t (minutes), summing all
// doses. Model: first-order absorption + first-order elimination (the Bateman
// function), so each dose ramps to a peak (~45 min) before decaying.
//   ke = elimination rate (per min), ka = absorption rate (per min)
function caffeineAt(t, doses, ke, ka) {
  const factor = ka / (ka - ke);
  let total = 0;
  for (const d of doses) {
    if (d.min <= t) {
      const dt = t - d.min;
      total += d.mg * factor * (Math.exp(-ke * dt) - Math.exp(-ka * dt));
    }
  }
  return total;
}

// Time-to-peak (minutes) for a single dose under the Bateman model.
function timeToPeak(ke, ka) {
  return Math.log(ka / ke) / (ka - ke);
}

/* ============================================================================
   IMPACT CONTENT (dose-dependent, based on mg present at the event)
   ========================================================================== */
function workoutImpact(mg, weightKg) {
  // With body weight, bracket by mg/kg — the dosing metric used in the
  // literature (~3–6 mg/kg is the established ergogenic range). Without it,
  // fall back to absolute-mg brackets and a weight caveat.
  if (weightKg && weightKg > 0) {
    const perKg = mg / weightKg;
    const tag = `≈ ${perKg.toFixed(1)} mg/kg`;
    if (perKg < 1) {
      return {
        weighted: true,
        level: `Sub-ergogenic (${tag})`,
        cardio: ["Below the ~3–6 mg/kg range; unlikely to change endurance or perceived effort much."],
        power: ["Minimal expected effect on strength or power."],
      };
    }
    if (perKg < 3) {
      return {
        weighted: true,
        level: `Low–moderate (${tag})`,
        cardio: ["Under the classic 3–6 mg/kg range, but endurance gains and lower perceived effort can still show up at low doses."],
        power: ["Small, variable benefit to power and muscular endurance."],
      };
    }
    if (perKg <= 6) {
      return {
        weighted: true,
        level: `Established ergogenic range (${tag})`,
        cardio: ["In the 3–6 mg/kg sweet spot: expect better endurance and time-to-exhaustion with reduced perceived effort (~2–4% in trials)."],
        power: ["Likely small gains in power and muscular endurance; maximal-strength effects are smaller and more variable."],
      };
    }
    return {
      weighted: true,
      level: `Above the ergogenic range (${tag})`,
      cardio: ["Past ~6 mg/kg the endurance benefit plateaus while jitters, elevated heart rate and GI distress get more likely."],
      power: ["No reliable added power benefit here, and higher side-effect risk."],
    };
  }

  // ---- no weight given: absolute-mg fallback ----
  if (mg < 50) {
    return {
      level: "Sub-ergogenic for most adults",
      cardio: [
        "Unlikely to meaningfully change endurance or perceived effort at this level.",
      ],
      power: ["Minimal expected effect on strength or power output."],
    };
  }
  if (mg < 150) {
    return {
      level: "Low–moderate",
      cardio: [
        "May modestly improve endurance and lower perceived effort — endurance is caffeine's most reliable benefit.",
        "Effect scales with dose-per-kg, so it depends on your body weight.",
      ],
      power: [
        "Small, less consistent benefit to power and muscular endurance at this level.",
      ],
    };
  }
  if (mg < 300) {
    return {
      level: "Moderate–high (near the typical ergogenic dose for many adults)",
      cardio: [
        "Around the 3–6 mg/kg range for most adults: expect improved endurance and time-to-exhaustion with reduced perceived effort (~2–4% in trials).",
      ],
      power: [
        "Likely small gains in power and muscular endurance; maximal-strength effects are smaller and more variable.",
      ],
    };
  }
  return {
    level: "High — at or above the typical ergogenic dose",
    cardio: [
      "At/above 3–6 mg/kg for most people. Endurance benefit doesn't keep climbing with dose, while jitters, elevated heart rate and GI upset get more likely.",
    ],
    power: [
      "Possible small power benefit, but higher doses raise side-effect risk (tremor, GI distress) without proportional gains.",
    ],
  };
}

function sleepImpact(mg) {
  if (mg < 20) {
    return {
      level: "Negligible",
      points: ["Little measurable effect on sleep for most people at this level."],
    };
  }
  if (mg < 75) {
    return {
      level: "Low",
      points: [
        "May slightly lengthen the time it takes to fall asleep and trim deep (slow-wave) sleep.",
        "Highly individual — genetics and sensitivity matter a lot.",
      ],
    };
  }
  if (mg < 150) {
    return {
      level: "Moderate",
      points: [
        "Likely to delay sleep onset and reduce sleep efficiency and deep sleep.",
        "You may not notice it even when it's measurable — perception underestimates the effect.",
      ],
    };
  }
  return {
    level: "High",
    points: [
      "Expect meaningful disruption: longer to fall asleep, lighter and more fragmented sleep, less deep sleep.",
      "Objective impact often exceeds what people feel. Peak effect on sleep-onset delay lands ~3 h after intake.",
    ],
  };
}

/* ============================================================================
   SMALL UI PIECES
   ========================================================================== */
function Field({ label, hint, required, children }) {
  return (
    <div className="cmc-field">
      <div className="cmc-field-head">
        <span className="cmc-label">
          {label}
          {required && <span className="cmc-req"> *</span>}
        </span>
        {hint && <span className="cmc-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/* ============================================================================
   MAIN APP
   ========================================================================== */
export default function App() {
  const [showDisclaimer, setShowDisclaimer] = useState(true);

  // inputs
  const [use, setUse] = useState(null); // null = not chosen (defaults to moderate)
  const [smokes, setSmokes] = useState(false);
  const [weight, setWeight] = useState("");
  const [weightUnit, setWeightUnit] = useState("lb");
  const [doses, setDoses] = useState([{ mg: "", time: "" }]);
  const [workouts, setWorkouts] = useState([{ time: "" }]);
  const [bedtime, setBedtime] = useState("");

  // results / interaction
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [openDetail, setOpenDetail] = useState(null); // e.g. "workout-0" | "bed"
  const rowRefs = useRef({});

  useEffect(() => {
    if (openDetail && rowRefs.current[openDetail]) {
      rowRefs.current[openDetail].scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [openDetail]);

  /* ---------- input mutators ---------- */
  const updateDose = (i, key, val) =>
    setDoses((d) => d.map((row, idx) => (idx === i ? { ...row, [key]: val } : row)));
  const addDose = () => setDoses((d) => [...d, { mg: "", time: "" }]);
  const removeDose = (i) =>
    setDoses((d) => (d.length === 1 ? d : d.filter((_, idx) => idx !== i)));

  const updateWorkout = (i, val) =>
    setWorkouts((w) => w.map((row, idx) => (idx === i ? { time: val } : row)));
  const addWorkout = () => setWorkouts((w) => [...w, { time: "" }]);
  const removeWorkout = (i) =>
    setWorkouts((w) => (w.length === 1 ? w : w.filter((_, idx) => idx !== i)));

  const clearForm = () => {
    setUse(null);
    setSmokes(false);
    setWeight("");
    setWeightUnit("lb");
    setDoses([{ mg: "", time: "" }]);
    setWorkouts([{ time: "" }]);
    setBedtime("");
    setResult(null);
    setError("");
    setOpenDetail(null);
  };

  /* ---------- calculate ---------- */
  const calculate = () => {
    setOpenDetail(null);

    const parsedDoses = doses
      .map((d) => ({ mg: parseFloat(d.mg), min: parseHM(d.time), rawTime: d.time }))
      .filter((d) => !Number.isNaN(d.mg) && d.mg > 0 && d.min !== null);

    if (parsedDoses.length === 0) {
      setResult(null);
      setError(
        "Add at least one caffeine dose with a milligram amount and a time to run the model."
      );
      return;
    }
    setError("");

    const halfLifeHours = (CONFIG.halfLifeByUse[use ?? CONFIG.defaultUse]) *
      (smokes ? CONFIG.smokingMultiplier : 1);
    const halfLifeMin = halfLifeHours * 60;
    const ke = Math.LN2 / halfLifeMin;
    const ka = Math.LN2 / CONFIG.absorptionHalfLifeMin;
    const tmaxMin = timeToPeak(ke, ka);

    // Optional body weight -> kg
    const wVal = parseFloat(weight);
    const weightKg =
      !Number.isNaN(wVal) && wVal > 0
        ? weightUnit === "kg"
          ? wVal
          : wVal * 0.453592
        : null;

    // Anchor timeline at the earliest dose; roll any event with an earlier
    // clock time to the next day (assumes a single forward ~24h window).
    const firstDoseMin = Math.min(...parsedDoses.map((d) => d.min));
    const normalize = (min) => (min < firstDoseMin ? min + 1440 : min);

    const dosesN = parsedDoses.map((d) => ({ ...d, min: normalize(d.min) }));
    dosesN.sort((a, b) => a.min - b.min);
    const lastDoseMin = Math.max(...dosesN.map((d) => d.min));

    const workoutsN = workouts
      .map((w) => parseHM(w.time))
      .filter((m) => m !== null)
      .map((m) => normalize(m));
    const bedMinRaw = parseHM(bedtime);
    const bedMin = bedMinRaw === null ? null : normalize(bedMinRaw);

    const totalIntake = dosesN.reduce((s, d) => s + d.mg, 0);

    // Peak (scan a fine grid)
    const scanStart = firstDoseMin;
    const scanEnd = lastDoseMin + 60 * 72; // cap search at +72h
    let peak = { mg: 0, min: firstDoseMin };
    for (let t = scanStart; t <= scanEnd; t += 1) {
      const mg = caffeineAt(t, dosesN, ke, ka);
      if (mg > peak.mg) peak = { mg, min: t };
      // stop only after the final dose has passed its peak and decayed away
      if (t > lastDoseMin + tmaxMin && mg < CONFIG.negligibleMg) break;
    }

    // Time to negligible after final dose
    let negligibleAbsMin = lastDoseMin;
    const searchStart = Math.ceil(lastDoseMin + tmaxMin); // past the final peak
    for (let t = searchStart; t <= scanEnd; t += 1) {
      if (caffeineAt(t, dosesN, ke, ka) < CONFIG.negligibleMg) {
        negligibleAbsMin = t;
        break;
      }
    }
    const timeToNegligibleMin = negligibleAbsMin - lastDoseMin;

    // Chart data
    const eventMins = [
      ...dosesN.map((d) => d.min),
      ...workoutsN,
      ...(bedMin !== null ? [bedMin] : []),
    ];
    const tStart = Math.min(firstDoseMin, ...eventMins) - 20;
    const tEnd = Math.max(negligibleAbsMin, ...eventMins) + 25;
    const data = [];
    for (let t = tStart; t <= tEnd; t += 2) {
      data.push({ t, mg: Math.round(caffeineAt(t, dosesN, ke, ka) * 10) / 10 });
    }

    // Hourly ticks
    const ticks = [];
    const firstTick = Math.ceil(tStart / 60) * 60;
    for (let t = firstTick; t <= tEnd; t += 60) ticks.push(t);

    // Event timeline (chronological)
    const timeline = [];
    dosesN.forEach((d, i) => {
      // "before" excludes this dose (its Bateman contribution is 0 at t = dose time);
      // "peak" is the total body level when this dose reaches its individual peak.
      const before = caffeineAt(d.min, dosesN, ke, ka);
      const peakLevel = caffeineAt(d.min + tmaxMin, dosesN, ke, ka);
      timeline.push({
        kind: "dose",
        idx: i,
        min: d.min,
        mg: d.mg,
        before: Math.max(0, before),
        peak: peakLevel,
        lag: Math.round(tmaxMin),
      });
    });
    workoutsN.forEach((m, i) => {
      timeline.push({
        kind: "workout",
        idx: i,
        min: m,
        level: caffeineAt(m, dosesN, ke, ka),
      });
    });
    if (bedMin !== null) {
      timeline.push({
        kind: "bed",
        idx: 0,
        min: bedMin,
        level: caffeineAt(bedMin, dosesN, ke, ka),
      });
    }
    timeline.sort((a, b) => a.min - b.min);

    setResult({
      halfLifeHours,
      tmaxMin,
      weightKg,
      totalIntake,
      overLimit: totalIntake > CONFIG.safeDailyLimitMg,
      peak,
      timeToNegligibleMin,
      negligibleAbsMin,
      data,
      ticks,
      tStart,
      tEnd,
      dosesN,
      workoutsN,
      bedMin,
      timeline,
    });
  };

  /* ---------- chart tooltip ---------- */
  const ChartTip = ({ active, payload }) => {
    if (!active || !payload || !payload.length) return null;
    const p = payload[0].payload;
    return (
      <div className="cmc-tip">
        <div className="cmc-tip-time">{minutesToClock(p.t)}</div>
        <div className="cmc-tip-mg">
          {Math.round(p.mg)} <span>mg</span>
        </div>
      </div>
    );
  };

  /* ---------- clickable label render for workout / bedtime ---------- */
  const eventLabel = (text, color, key) => ({ viewBox }) => {
    const x = viewBox.x;
    const y = viewBox.y;
    const w = text.length * 6.4 + 20;
    const clampedX = Math.max(2, Math.min(x - w / 2, viewBox.width + viewBox.x - w));
    return (
      <g
        transform={`translate(${clampedX}, ${y + 4})`}
        style={{ cursor: "pointer" }}
        onClick={() => setOpenDetail(key)}
      >
        <rect width={w} height={18} rx={9} fill={color} />
        <text
          x={w / 2}
          y={13}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#fff"
        >
          {text} ▸
        </text>
      </g>
    );
  };

  const doseLabel = (mg) => ({ viewBox }) => (
    <text
      x={viewBox.x}
      y={viewBox.y + viewBox.height - 4}
      textAnchor="middle"
      fontSize={10}
      fontWeight={600}
      fill={C.dose}
    >
      {Math.round(mg)}
    </text>
  );

  return (
    <div className="cmc-root">
      <style>{CSS}</style>

      {/* ---------- Disclaimer modal ---------- */}
      {showDisclaimer && (
        <div className="cmc-modal-scrim" role="dialog" aria-modal="true">
          <div className="cmc-modal">
            <h2 className="cmc-modal-title">Before you start</h2>
            <p className="cmc-modal-body">
              Everything this tool shows is a <strong>rough estimate</strong> from a
              simplified pharmacokinetic model. Real caffeine metabolism varies widely
              between people — genetics, medications, pregnancy, liver function and more
              can shift it substantially. Do not treat these numbers as medically
              accurate, and talk to your doctor about how caffeine may affect you.
            </p>
            <button className="cmc-btn cmc-btn-primary" onClick={() => setShowDisclaimer(false)}>
              I understand
            </button>
          </div>
        </div>
      )}

      <div className="cmc-container">
        {/* ---------- Header ---------- */}
        <header className="cmc-header">
          <div className="cmc-eyebrow">Pharmacokinetic estimate</div>
          <h1 className="cmc-title">Caffeine Metabolism Calculator</h1>
          <p className="cmc-sub">
            Model how much caffeine is in your body through the day, and what it means
            for a workout or for sleep.
          </p>
        </header>

        {/* ---------- Inputs ---------- */}
        <section className="cmc-card">
          <Field
            label="Habitual caffeine use"
            hint="Nudges the half-life used. Optional — defaults to moderate."
          >
            <div className="cmc-segmented" role="group" aria-label="Habitual caffeine use">
              {[
                ["none", "None"],
                ["low", "Low"],
                ["moderate", "Moderate"],
                ["high", "High"],
              ].map(([val, lbl]) => (
                <button
                  key={val}
                  className={"cmc-seg" + (use === val ? " cmc-seg-on" : "")}
                  onClick={() => setUse(use === val ? null : val)}
                  type="button"
                >
                  {lbl}
                </button>
              ))}
            </div>
            <div className="cmc-seg-legend">
              None · Low &lt;100mg/day · Moderate 100–250mg/day · High &gt;250mg/day
            </div>
          </Field>

          <Field
            label="Do you smoke tobacco?"
            hint="Combustible tobacco only — not vaping, gum or patches."
          >
            <label className="cmc-check">
              <input
                type="checkbox"
                checked={smokes}
                onChange={(e) => setSmokes(e.target.checked)}
              />
              <span>I smoke cigarettes / cigars / pipe tobacco</span>
            </label>
          </Field>

          <Field
            label="Body weight"
            hint="Optional — sharpens the workout estimate (mg/kg)."
          >
            <div className="cmc-weight-row">
              <div className="cmc-input-wrap cmc-weight-input">
                <input
                  className="cmc-input"
                  type="number"
                  min="0"
                  inputMode="decimal"
                  placeholder={weightUnit === "kg" ? "e.g. 68" : "e.g. 150"}
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                />
                <span className="cmc-unit">{weightUnit}</span>
              </div>
              <div className="cmc-unit-toggle" role="group" aria-label="Weight unit">
                {["lb", "kg"].map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={"cmc-unit-btn" + (weightUnit === u ? " cmc-unit-on" : "")}
                    onClick={() => setWeightUnit(u)}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
          </Field>

          <Field label="Caffeine doses" required hint="Milligrams and the time taken.">
            <div className="cmc-rows">
              {doses.map((d, i) => (
                <div className="cmc-dose-row" key={i}>
                  <div className="cmc-input-wrap">
                    <input
                      className="cmc-input"
                      type="number"
                      min="0"
                      inputMode="numeric"
                      placeholder="e.g. 150"
                      value={d.mg}
                      onChange={(e) => updateDose(i, "mg", e.target.value)}
                    />
                    <span className="cmc-unit">mg</span>
                  </div>
                  <input
                    className="cmc-input cmc-time"
                    type="time"
                    value={d.time}
                    onChange={(e) => updateDose(i, "time", e.target.value)}
                  />
                  <button
                    className="cmc-icon-btn"
                    onClick={() => removeDose(i)}
                    disabled={doses.length === 1}
                    aria-label="Remove dose"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button className="cmc-add" onClick={addDose} type="button">
              + Add another dose
            </button>
          </Field>

          <div className="cmc-two-col">
            <Field label="Workout time(s)" hint="Optional.">
              <div className="cmc-rows">
                {workouts.map((w, i) => (
                  <div className="cmc-dose-row" key={i}>
                    <input
                      className="cmc-input cmc-time"
                      type="time"
                      value={w.time}
                      onChange={(e) => updateWorkout(i, e.target.value)}
                    />
                    <button
                      className="cmc-icon-btn"
                      onClick={() => removeWorkout(i)}
                      disabled={workouts.length === 1}
                      aria-label="Remove workout"
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button className="cmc-add" onClick={addWorkout} type="button">
                + Add workout
              </button>
            </Field>

            <Field label="Bedtime" hint="Optional.">
              <input
                className="cmc-input cmc-time"
                type="time"
                value={bedtime}
                onChange={(e) => setBedtime(e.target.value)}
              />
            </Field>
          </div>

          {error && <div className="cmc-error">{error}</div>}

          <button className="cmc-btn cmc-btn-primary cmc-calc" onClick={calculate} type="button">
            Calculate
          </button>
        </section>

        {/* ---------- Results ---------- */}
        {result && (
          <section className="cmc-results">
            {result.overLimit && (
              <div className="cmc-warn">
                <strong>Whoa there — that's a lot of caffeine.</strong> The safe daily
                limit for a healthy adult is 400&nbsp;mg; consistently taking more than
                that may lead to side effects. Your total here is{" "}
                {Math.round(result.totalIntake)}&nbsp;mg.
              </div>
            )}

            {/* Chart */}
            <div className="cmc-card cmc-chart-card">
              <div className="cmc-chart-head">
                <span className="cmc-chart-title">Estimated caffeine in body</span>
                <span className="cmc-chart-note">
                  half-life used: {result.halfLifeHours.toFixed(1)} h · hover or tap the
                  curve
                </span>
              </div>
              <div className="cmc-chart-wrap">
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={result.data} margin={{ top: 26, right: 12, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="cafFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.caffeine} stopOpacity={0.22} />
                        <stop offset="100%" stopColor={C.caffeine} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={C.border} vertical={false} />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={[result.tStart, result.tEnd]}
                      ticks={result.ticks}
                      tickFormatter={minutesToClock}
                      tick={{ fontSize: 11, fill: C.faint }}
                      stroke={C.border}
                      interval="preserveStartEnd"
                      minTickGap={28}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: C.faint }}
                      stroke={C.border}
                      width={44}
                      label={{
                        value: "mg",
                        angle: -90,
                        position: "insideLeft",
                        fontSize: 11,
                        fill: C.faint,
                        dy: 20,
                      }}
                    />
                    <Tooltip content={<ChartTip />} cursor={{ stroke: C.faint, strokeDasharray: "3 3" }} />

                    {result.dosesN.map((d, i) => (
                      <ReferenceLine
                        key={"d" + i}
                        x={d.min}
                        stroke={C.dose}
                        strokeDasharray="3 3"
                        label={doseLabel(d.mg)}
                      />
                    ))}
                    {result.workoutsN.map((m, i) => (
                      <ReferenceLine
                        key={"w" + i}
                        x={m}
                        stroke={C.workout}
                        strokeDasharray="4 3"
                        label={eventLabel("Workout", C.workout, "workout-" + i)}
                      />
                    ))}
                    {result.bedMin !== null && (
                      <ReferenceLine
                        x={result.bedMin}
                        stroke={C.bedtime}
                        strokeDasharray="4 3"
                        label={eventLabel("Bed", C.bedtime, "bed")}
                      />
                    )}

                    <Area
                      type="monotone"
                      dataKey="mg"
                      stroke={C.caffeine}
                      strokeWidth={2.4}
                      fill="url(#cafFill)"
                      activeDot={{ r: 4, fill: C.caffeine, stroke: "#fff", strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Key metrics */}
              <div className="cmc-metrics">
                <div className="cmc-metric">
                  <div className="cmc-metric-label">Peak concentration</div>
                  <div className="cmc-metric-val">
                    {Math.round(result.peak.mg)} <span>mg</span>
                  </div>
                  <div className="cmc-metric-sub">at {minutesToClock(result.peak.min)}</div>
                </div>
                <div className="cmc-metric">
                  <div className="cmc-metric-label">Fully metabolized</div>
                  <div className="cmc-metric-val cmc-metric-val-sm">
                    {durationText(result.timeToNegligibleMin)}
                  </div>
                  <div className="cmc-metric-sub">
                    after final dose (&lt;{CONFIG.negligibleMg} mg, ~{minutesToClock(result.negligibleAbsMin)})
                  </div>
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div className="cmc-card">
              <div className="cmc-timeline-title">At each marked time</div>
              <div className="cmc-timeline">
                {result.timeline.map((ev, i) => {
                  if (ev.kind === "dose") {
                    return (
                      <div className="cmc-tl-row" key={i}>
                        <span className="cmc-tl-dot" style={{ background: C.dose }} />
                        <span className="cmc-tl-time">{minutesToClock(ev.min)}</span>
                        <span className="cmc-tl-desc">
                          Took {Math.round(ev.mg)} mg
                          <span className="cmc-tl-lag"> · peak in ~{ev.lag}m</span>
                        </span>
                        <span className="cmc-tl-val">
                          {Math.round(ev.before)} → <strong>{Math.round(ev.peak)} mg</strong>
                        </span>
                      </div>
                    );
                  }
                  const key = ev.kind === "bed" ? "bed" : "workout-" + ev.idx;
                  const isOpen = openDetail === key;
                  const color = ev.kind === "bed" ? C.bedtime : C.workout;
                  return (
                    <div
                      className="cmc-tl-block"
                      key={i}
                      ref={(el) => (rowRefs.current[key] = el)}
                    >
                      <button
                        className={"cmc-tl-row cmc-tl-btn" + (isOpen ? " cmc-tl-open" : "")}
                        onClick={() => setOpenDetail(isOpen ? null : key)}
                        aria-expanded={isOpen}
                        type="button"
                      >
                        <span className="cmc-tl-dot" style={{ background: color }} />
                        <span className="cmc-tl-time">{minutesToClock(ev.min)}</span>
                        <span className="cmc-tl-desc">
                          {ev.kind === "bed" ? "Bedtime" : "Workout"}
                        </span>
                        <span className="cmc-tl-val">
                          <strong>{Math.round(ev.level)} mg</strong>
                        </span>
                        <span className="cmc-tl-caret">{isOpen ? "▾" : "▸"}</span>
                      </button>

                      {isOpen && ev.kind === "workout" && (
                        <WorkoutDetail mg={ev.level} weightKg={result.weightKg} />
                      )}
                      {isOpen && ev.kind === "bed" && <SleepDetail mg={ev.level} />}
                    </div>
                  );
                })}
              </div>

              <button className="cmc-btn cmc-btn-ghost cmc-clear" onClick={clearForm} type="button">
                Clear form
              </button>
            </div>

            {/* Model & sources */}
            <details className="cmc-sources">
              <summary>Model &amp; sources</summary>
              <div className="cmc-sources-body">
                <p>
                  <strong>Model.</strong> First-order absorption plus first-order
                  elimination (a one-compartment Bateman model), so each dose ramps to a
                  peak roughly 45 min after intake before decaying. The Y-axis is
                  estimated caffeine remaining in the body (mg), not blood concentration —
                  that would additionally need volume of distribution. Body weight, when
                  provided, is used to express the workout effect in mg/kg.
                </p>
                <p>
                  <strong>Half-life.</strong> Baseline ~5 h for a healthy adult (range
                  ~4–5 h). Smoking multiplier {CONFIG.smokingMultiplier}× reflects
                  cigarette-smoke induction of CYP1A2 (~40–65% faster clearance). The
                  habitual-use gradient (
                  {Object.entries(CONFIG.halfLifeByUse)
                    .map(([k, v]) => `${k} ${v}h`)
                    .join(", ")}
                  ) is directionally supported but low-confidence, and is dwarfed by
                  genetic (CYP1A2) variation between individuals.
                </p>
                <p>
                  Key references: Gardiner et al., <em>Sleep Med Rev</em> 2023
                  (caffeine &amp; sleep meta-analysis); ISSN position stand on caffeine
                  &amp; exercise (Guest et al. 2021); reviews of caffeine
                  pharmacokinetics and CYP1A2. Full pointers in the accompanying notes.
                </p>
              </div>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}

/* ---------- detail panels ---------- */
function WorkoutDetail({ mg, weightKg }) {
  const info = workoutImpact(mg, weightKg);
  return (
    <div className="cmc-detail">
      <div className="cmc-detail-level">{info.level}</div>
      <div className="cmc-detail-group">
        <span className="cmc-detail-tag" style={{ color: C.workout }}>
          Cardio
        </span>
        <ul>
          {info.cardio.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>
      <div className="cmc-detail-group">
        <span className="cmc-detail-tag" style={{ color: C.workout }}>
          Power / strength
        </span>
        <ul>
          {info.power.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>
      <div className="cmc-detail-foot">
        {info.weighted
          ? "Based on your body weight. Individual response still varies (genetics, tolerance, training status)."
          : "Ergogenic dosing is weight-based (~3–6 mg/kg) — add body weight above for a sharper read."}
      </div>
    </div>
  );
}

function SleepDetail({ mg }) {
  const info = sleepImpact(mg);
  return (
    <div className="cmc-detail">
      <div className="cmc-detail-level">Expected sleep impact: {info.level}</div>
      <ul>
        {info.points.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
      <div className="cmc-detail-foot">
        Individual response varies widely (genetics, tolerance). Tolerance to the
        alertness buzz is not the same as tolerance to sleep disruption.
      </div>
    </div>
  );
}

/* ============================================================================
   STYLES
   ========================================================================== */
const CSS = `
.cmc-root{
  --ink:${C.ink}; --muted:${C.muted}; --faint:${C.faint};
  --border:${C.border}; --card:${C.card}; --page:${C.page}; --caf:${C.caffeine};
  background:${C.page}; color:${C.ink}; min-height:100%;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.cmc-container{max-width:720px;margin:0 auto;padding:28px 18px 64px;}

.cmc-header{margin-bottom:22px;}
.cmc-eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--caf);font-weight:700;margin-bottom:8px;}
.cmc-title{font-size:30px;line-height:1.08;font-weight:750;letter-spacing:-.02em;margin:0 0 8px;}
.cmc-sub{margin:0;color:var(--muted);font-size:15px;line-height:1.5;max-width:52ch;}

.cmc-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:16px;}

.cmc-field{margin-bottom:18px;}
.cmc-field:last-child{margin-bottom:0;}
.cmc-field-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:8px;flex-wrap:wrap;}
.cmc-label{font-size:14px;font-weight:650;}
.cmc-req{color:var(--caf);}
.cmc-hint{font-size:12px;color:var(--faint);}

.cmc-segmented{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}
.cmc-seg{border:1px solid var(--border);background:#fff;color:var(--muted);border-radius:10px;padding:9px 4px;font-size:13px;font-weight:600;cursor:pointer;transition:all .12s;}
.cmc-seg:hover{border-color:#cfd4db;}
.cmc-seg-on{background:var(--ink);color:#fff;border-color:var(--ink);}
.cmc-seg-legend{font-size:11px;color:var(--faint);margin-top:7px;}

.cmc-check{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--muted);cursor:pointer;}
.cmc-check input{width:17px;height:17px;accent-color:var(--caf);cursor:pointer;}

.cmc-rows{display:flex;flex-direction:column;gap:8px;}
.cmc-dose-row{display:flex;gap:8px;align-items:center;}
.cmc-input-wrap{position:relative;flex:1;}
.cmc-input{width:100%;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:14px;color:var(--ink);background:#fff;font-family:inherit;box-sizing:border-box;}
.cmc-input:focus{outline:none;border-color:var(--caf);box-shadow:0 0 0 3px rgba(194,117,26,.14);}
.cmc-input-wrap .cmc-input{padding-right:38px;}
.cmc-unit{position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--faint);pointer-events:none;}
.cmc-time{flex:0 0 130px;font-variant-numeric:tabular-nums;}
.cmc-icon-btn{flex:0 0 auto;width:36px;height:36px;border:1px solid var(--border);background:#fff;border-radius:10px;color:var(--faint);font-size:20px;line-height:1;cursor:pointer;}
.cmc-icon-btn:hover:not(:disabled){border-color:${C.warnBorder};color:${C.warnText};}
.cmc-icon-btn:disabled{opacity:.35;cursor:not-allowed;}
.cmc-add{margin-top:9px;background:none;border:none;color:var(--caf);font-size:13px;font-weight:650;cursor:pointer;padding:2px 0;}

.cmc-weight-row{display:flex;gap:8px;align-items:stretch;}
.cmc-weight-input{max-width:190px;}
.cmc-unit-toggle{display:inline-flex;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#fff;}
.cmc-unit-btn{border:none;background:#fff;color:var(--muted);font-size:13px;font-weight:650;padding:0 15px;cursor:pointer;font-family:inherit;}
.cmc-unit-btn+.cmc-unit-btn{border-left:1px solid var(--border);}
.cmc-unit-on{background:var(--ink);color:#fff;}

.cmc-two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px;}

.cmc-error{margin-top:14px;background:${C.warnBg};border:1px solid ${C.warnBorder};color:${C.warnText};font-size:13px;padding:10px 12px;border-radius:10px;}

.cmc-btn{border-radius:11px;font-size:14px;font-weight:650;cursor:pointer;padding:12px 18px;border:1px solid transparent;transition:all .12s;font-family:inherit;}
.cmc-btn-primary{background:var(--ink);color:#fff;}
.cmc-btn-primary:hover{background:#000;}
.cmc-btn-ghost{background:#fff;border-color:var(--border);color:var(--muted);}
.cmc-btn-ghost:hover{border-color:#cfd4db;color:var(--ink);}
.cmc-calc{width:100%;margin-top:18px;}

.cmc-warn{background:${C.warnBg};border:1px solid ${C.warnBorder};color:${C.warnText};padding:13px 15px;border-radius:12px;font-size:13.5px;line-height:1.5;margin-bottom:16px;}
.cmc-warn strong{font-weight:700;}

.cmc-chart-card{padding-bottom:16px;}
.cmc-chart-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px;}
.cmc-chart-title{font-size:14px;font-weight:650;}
.cmc-chart-note{font-size:11px;color:var(--faint);}
.cmc-chart-wrap{margin:0 -6px;position:relative;}

.cmc-tip{background:var(--ink);color:#fff;border-radius:9px;padding:7px 10px;box-shadow:0 6px 20px rgba(0,0,0,.18);}
.cmc-tip-time{font-size:11px;opacity:.7;margin-bottom:1px;font-variant-numeric:tabular-nums;}
.cmc-tip-mg{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;}
.cmc-tip-mg span{font-size:11px;font-weight:500;opacity:.7;}

.cmc-metrics{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px;}
.cmc-metric{border:1px solid var(--border);border-radius:12px;padding:14px;background:#FBFBFC;}
.cmc-metric-label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);font-weight:700;margin-bottom:6px;}
.cmc-metric-val{font-size:26px;font-weight:750;font-variant-numeric:tabular-nums;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:-.01em;line-height:1;}
.cmc-metric-val-sm{font-size:22px;}
.cmc-metric-val span{font-size:13px;font-weight:500;color:var(--muted);}
.cmc-metric-sub{font-size:12px;color:var(--muted);margin-top:6px;}

.cmc-timeline-title{font-size:14px;font-weight:650;margin-bottom:12px;}
.cmc-timeline{display:flex;flex-direction:column;}
.cmc-tl-row{display:flex;align-items:center;gap:11px;padding:11px 2px;border-bottom:1px solid var(--border);width:100%;text-align:left;}
.cmc-tl-block:last-child .cmc-tl-row,.cmc-timeline>.cmc-tl-row:last-child{border-bottom:none;}
.cmc-tl-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}
.cmc-tl-time{font-size:13px;font-variant-numeric:tabular-nums;color:var(--muted);flex:0 0 74px;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;}
.cmc-tl-desc{font-size:14px;flex:1;}
.cmc-tl-lag{color:var(--faint);font-size:12px;font-weight:500;}
.cmc-tl-val{font-size:13px;font-variant-numeric:tabular-nums;color:var(--muted);font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;}
.cmc-tl-val strong{color:var(--ink);font-weight:700;}
.cmc-tl-btn{background:none;border:none;border-bottom:1px solid var(--border);cursor:pointer;font-family:inherit;}
.cmc-tl-btn:hover{background:#FBFBFC;}
.cmc-tl-caret{color:var(--faint);font-size:12px;flex:0 0 auto;width:14px;}
.cmc-tl-open{background:#FBFBFC;}

.cmc-detail{padding:4px 2px 16px 32px;font-size:13.5px;color:var(--muted);line-height:1.55;}
.cmc-detail-level{font-weight:650;color:var(--ink);margin:8px 0 10px;font-size:13.5px;}
.cmc-detail-group{margin-bottom:8px;}
.cmc-detail-tag{font-size:11px;letter-spacing:.05em;text-transform:uppercase;font-weight:700;}
.cmc-detail ul{margin:4px 0 0;padding-left:18px;}
.cmc-detail li{margin-bottom:3px;}
.cmc-detail-foot{margin-top:10px;font-size:12px;color:var(--faint);font-style:italic;}

.cmc-clear{width:100%;margin-top:18px;}

.cmc-sources{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:4px 18px;}
.cmc-sources summary{cursor:pointer;font-size:13px;font-weight:650;padding:12px 0;color:var(--muted);}
.cmc-sources-body{font-size:12.5px;color:var(--muted);line-height:1.55;padding-bottom:14px;}
.cmc-sources-body p{margin:0 0 10px;}
.cmc-sources-body strong{color:var(--ink);}

.cmc-modal-scrim{position:fixed;inset:0;background:rgba(20,24,32,.5);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50;backdrop-filter:blur(2px);}
.cmc-modal{background:#fff;border-radius:18px;max-width:440px;padding:26px;box-shadow:0 24px 60px rgba(0,0,0,.28);}
.cmc-modal-title{font-size:20px;font-weight:750;margin:0 0 12px;}
.cmc-modal-body{font-size:14px;line-height:1.6;color:var(--muted);margin:0 0 20px;}
.cmc-modal-body strong{color:var(--ink);}
.cmc-modal .cmc-btn{width:100%;}

@media (max-width:560px){
  .cmc-title{font-size:25px;}
  .cmc-two-col{grid-template-columns:1fr;gap:18px;}
  .cmc-metrics{grid-template-columns:1fr;}
  .cmc-time{flex-basis:118px;}
}
@media (prefers-reduced-motion:reduce){
  *{transition:none !important;scroll-behavior:auto !important;}
}
`;
