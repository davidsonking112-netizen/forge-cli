export const SCHEMA_VERSION = 2;
export const DEFAULT_WEEKLY_GOAL_MINUTES = 150;
export const INTENSITIES = ["", "low", "moderate", "high"];

const DEFAULT_PRESETS = [
  {
    id: "preset_walk_mobility",
    name: "Walk + mobility",
    exercises: [
      {
        id: "ex_walk",
        name: "Brisk walk",
        duration: 30,
        intensity: "moderate",
        category: "Cardio",
      },
      {
        id: "ex_mobility",
        name: "Mobility",
        duration: 10,
        intensity: "low",
        category: "Recovery",
      },
    ],
  },
  {
    id: "preset_strength",
    name: "Strength basics",
    exercises: [
      {
        id: "ex_squats",
        name: "Squats",
        duration: 15,
        intensity: "moderate",
        category: "Strength",
      },
      {
        id: "ex_push",
        name: "Push-ups",
        duration: 10,
        intensity: "moderate",
        category: "Strength",
      },
      {
        id: "ex_core",
        name: "Core work",
        duration: 10,
        intensity: "moderate",
        category: "Strength",
      },
    ],
  },
];

export function todayISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function parts(iso) {
  return iso.split("-").map(Number);
}
function utcDate(iso) {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d));
}
function isoFromUTC(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function addDaysISO(iso, days) {
  if (!isValidISODate(iso)) throw new Error("Invalid ISO date");
  const dt = utcDate(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoFromUTC(dt);
}

export function compareISODate(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

export function getWeekRange(anchorISO = todayISO(), weekStartsOn = 1) {
  if (!isValidISODate(anchorISO)) throw new Error("Invalid ISO date");
  const anchor = utcDate(anchorISO);
  const day = anchor.getUTCDay();
  const diff = (day - weekStartsOn + 7) % 7;
  const start = addDaysISO(anchorISO, -diff);
  const days = Array.from({ length: 7 }, (_, index) =>
    addDaysISO(start, index),
  );
  return { start, end: addDaysISO(start, 7), days };
}

function cleanString(value, max = 1000) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}
function cleanId(value, fallback) {
  const id = cleanString(value, 100);
  return id || fallback;
}
function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function uniqueId(prefix, index) {
  return `${prefix}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

export function validateExercise(input, index = 0) {
  const errors = [];
  const name = cleanString(input?.name, 80);
  const duration = numberOr(input?.duration, NaN);
  const rounded = Math.round(duration);
  const intensity = cleanString(input?.intensity, 20).toLowerCase();
  const category = cleanString(input?.category, 40);
  if (!name) errors.push(`Exercise ${index + 1} needs a name.`);
  if (!Number.isInteger(duration) || rounded < 1 || rounded > 1440)
    errors.push(
      `Exercise ${index + 1} duration must be a whole number from 1 to 1440 minutes.`,
    );
  if (!INTENSITIES.includes(intensity))
    errors.push(
      `Exercise ${index + 1} intensity must be low, moderate, high, or blank.`,
    );
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: cleanId(input?.id, uniqueId("ex", index)),
      name,
      duration: rounded,
      intensity,
      category,
    },
  };
}

export function validateWorkout(input) {
  const errors = [];
  const date = cleanString(input?.date, 10);
  if (!isValidISODate(date))
    errors.push("Workout date must be a valid YYYY-MM-DD date.");
  const rawExercises = Array.isArray(input?.exercises) ? input.exercises : [];
  if (!rawExercises.length) errors.push("Add at least one exercise.");
  const exercises = [];
  rawExercises.forEach((exercise, index) => {
    const checked = validateExercise(exercise, index);
    if (checked.ok) exercises.push(checked.value);
    else errors.push(...checked.errors);
  });
  const notes = cleanString(input?.notes, 1000);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: cleanId(input?.id, uniqueId("workout", 0)),
      date,
      notes,
      exercises,
      createdAt: cleanString(input?.createdAt, 40),
      updatedAt: cleanString(input?.updatedAt, 40),
    },
  };
}

export function makeWorkout(input) {
  return {
    ...input,
    exercises: Array.isArray(input?.exercises) ? input.exercises : [],
  };
}

export function validatePreset(input) {
  const errors = [];
  const name = cleanString(input?.name, 80);
  if (!name) errors.push("Preset needs a name.");
  const rawExercises = Array.isArray(input?.exercises) ? input.exercises : [];
  if (!rawExercises.length) errors.push("Preset needs at least one exercise.");
  const exercises = [];
  rawExercises.forEach((exercise, index) => {
    const checked = validateExercise(exercise, index);
    if (checked.ok) exercises.push(checked.value);
    else errors.push(...checked.errors);
  });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: cleanId(input?.id, uniqueId("preset", 0)),
      name,
      exercises,
      createdAt: cleanString(input?.createdAt, 40),
      updatedAt: cleanString(input?.updatedAt, 40),
    },
  };
}

export function makePreset(input) {
  return {
    ...input,
    exercises: Array.isArray(input?.exercises) ? input.exercises : [],
  };
}

export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    settings: {
      weeklyGoalMinutes: DEFAULT_WEEKLY_GOAL_MINUTES,
      theme: "light",
    },
    workouts: [],
    presets: DEFAULT_PRESETS.map((preset) => validatePreset(preset).value),
  };
}

function migrateLegacyWorkout(input, index) {
  if (Array.isArray(input?.exercises)) return input;
  const name = input?.exercise || input?.name || input?.type || "Workout";
  return {
    id: input?.id || `legacy_${index}`,
    date: input?.date,
    notes: input?.notes || "",
    exercises: [
      {
        id: `legacy_ex_${index}`,
        name,
        duration: input?.duration || input?.minutes,
        intensity: input?.intensity || "",
        category: input?.category || "",
      },
    ],
    createdAt: input?.createdAt || "",
    updatedAt: input?.updatedAt || "",
  };
}

export function normalizeState(input, options = {}) {
  const warnings = [];
  const base = defaultState();
  const source = input && typeof input === "object" ? input : {};
  const rawSettings =
    source.settings && typeof source.settings === "object"
      ? source.settings
      : source;
  const weeklyGoal = Math.round(
    numberOr(
      rawSettings.weeklyGoalMinutes ??
        rawSettings.weeklyGoal ??
        rawSettings.goalMinutes,
      base.settings.weeklyGoalMinutes,
    ),
  );
  const theme = rawSettings.theme === "dark" ? "dark" : "light";
  const workouts = [];
  const rawWorkouts = Array.isArray(source.workouts)
    ? source.workouts
    : Array.isArray(source)
      ? source
      : [];
  rawWorkouts.forEach((workout, index) => {
    const checked = validateWorkout(migrateLegacyWorkout(workout, index));
    if (checked.ok) workouts.push(checked.value);
    else
      warnings.push(
        `Skipped workout ${index + 1}: ${checked.errors.join(" ")}`,
      );
  });
  const rawPresets = Array.isArray(source.presets)
    ? source.presets
    : options.keepDefaultPresets === false
      ? []
      : base.presets;
  const presets = [];
  rawPresets.forEach((preset, index) => {
    const checked = validatePreset(preset);
    if (checked.ok) presets.push(checked.value);
    else
      warnings.push(`Skipped preset ${index + 1}: ${checked.errors.join(" ")}`);
  });
  return {
    state: {
      version: SCHEMA_VERSION,
      settings: {
        weeklyGoalMinutes:
          Number.isInteger(weeklyGoal) && weeklyGoal >= 1 && weeklyGoal <= 10080
            ? weeklyGoal
            : base.settings.weeklyGoalMinutes,
        theme,
      },
      workouts: sortWorkouts(workouts),
      presets,
    },
    warnings,
  };
}

export function loadStateFromStorage(raw) {
  if (!raw) return { state: defaultState(), warnings: [] };
  try {
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    return {
      state: defaultState(),
      warnings: [
        "Stored data was not valid JSON, so a safe empty state was loaded.",
      ],
    };
  }
}

export function sortWorkouts(workouts) {
  return [...workouts].sort(
    (a, b) =>
      compareISODate(b.date, a.date) ||
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
  );
}

export function durationOfWorkout(workout) {
  return (workout.exercises || []).reduce(
    (sum, exercise) => sum + Number(exercise.duration || 0),
    0,
  );
}
export function totals(workouts) {
  return {
    workouts: workouts.length,
    minutes: workouts.reduce(
      (sum, workout) => sum + durationOfWorkout(workout),
      0,
    ),
  };
}

export function workoutsInRange(workouts, startISO, endISO) {
  return workouts.filter(
    (workout) => workout.date >= startISO && workout.date < endISO,
  );
}

export function weeklyProgress(
  workouts,
  goalMinutes = DEFAULT_WEEKLY_GOAL_MINUTES,
  anchorISO = todayISO(),
) {
  const range = getWeekRange(anchorISO);
  const minutes = totals(
    workoutsInRange(workouts, range.start, range.end),
  ).minutes;
  const goal = Math.max(
    1,
    Math.min(
      10080,
      Math.round(numberOr(goalMinutes, DEFAULT_WEEKLY_GOAL_MINUTES)),
    ),
  );
  const percent = Math.min(100, Math.round((minutes / goal) * 100));
  return {
    ...range,
    minutes,
    goal,
    percent,
    remaining: Math.max(0, goal - minutes),
  };
}

export function activityForLastNDays(
  workouts,
  anchorISO = todayISO(),
  count = 7,
) {
  const safeCount = Math.max(1, Math.min(31, Math.round(numberOr(count, 7))));
  const byDate = new Map();
  for (let i = safeCount - 1; i >= 0; i -= 1) {
    const date = addDaysISO(anchorISO, -i);
    byDate.set(date, { date, minutes: 0, workouts: 0 });
  }
  for (const workout of workouts) {
    const row = byDate.get(workout.date);
    if (row) {
      row.minutes += durationOfWorkout(workout);
      row.workouts += 1;
    }
  }
  return [...byDate.values()];
}

export function dayDetails(workouts, iso) {
  const dayWorkouts = sortWorkouts(
    workouts.filter((workout) => workout.date === iso),
  );
  return {
    date: iso,
    workouts: dayWorkouts,
    minutes: totals(dayWorkouts).minutes,
  };
}

export function currentStreak(workouts, anchorISO = todayISO()) {
  const activeDays = new Set(
    workouts
      .filter(
        (workout) =>
          durationOfWorkout(workout) > 0 && workout.date <= anchorISO,
      )
      .map((workout) => workout.date),
  );
  let count = 0;
  let cursor = anchorISO;
  while (activeDays.has(cursor)) {
    count += 1;
    cursor = addDaysISO(cursor, -1);
  }
  return count;
}

export function addPreset(state, preset) {
  const checked = validatePreset(preset);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return {
    ok: true,
    state: { ...state, presets: [...state.presets, checked.value] },
  };
}
export function updatePreset(state, id, preset) {
  const checked = validatePreset({ ...preset, id });
  if (!checked.ok) return { ok: false, errors: checked.errors };
  if (!state.presets.some((p) => p.id === id))
    return { ok: false, errors: ["Preset not found."] };
  return {
    ok: true,
    state: {
      ...state,
      presets: state.presets.map((p) => (p.id === id ? checked.value : p)),
    },
  };
}
export function deletePreset(state, id) {
  return {
    ...state,
    presets: state.presets.filter((preset) => preset.id !== id),
  };
}

export function exportStateJSON(state) {
  const normalized = normalizeState(state, { keepDefaultPresets: false }).state;
  return JSON.stringify(normalized, null, 2);
}

export function validateImportJSON(raw) {
  try {
    const parsed = JSON.parse(raw);
    const { state, warnings } = normalizeState(parsed, {
      keepDefaultPresets: false,
    });
    if (!parsed || typeof parsed !== "object")
      return {
        ok: false,
        errors: [
          "Import must be a JSON object exported from Fitness Tracker Pro.",
        ],
      };
    return {
      ok: true,
      state,
      warnings,
      summary: {
        workouts: state.workouts.length,
        presets: state.presets.length,
        weeklyGoalMinutes: state.settings.weeklyGoalMinutes,
        minutes: totals(state.workouts).minutes,
      },
    };
  } catch {
    return { ok: false, errors: ["Import file is not valid JSON."] };
  }
}
