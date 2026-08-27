import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./fitness-core.js", import.meta.url),
  "utf8",
);
const core = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const workout = (id, date, duration = 30, name = "Run") => ({
  id,
  date,
  notes: "",
  exercises: [
    {
      id: `${id}_ex`,
      name,
      duration,
      intensity: "moderate",
      category: "Cardio",
    },
  ],
});

test("validates multi-exercise workouts and rejects unsafe edge cases", () => {
  const valid = core.validateWorkout({
    id: "w1",
    date: "2024-06-10",
    exercises: [
      { name: "Run", duration: 25 },
      { name: "Stretch", duration: 10, intensity: "low" },
    ],
  });
  assert.equal(valid.ok, true);
  assert.equal(core.durationOfWorkout(valid.value), 35);

  assert.equal(
    core.validateWorkout({
      date: "2024-02-30",
      exercises: [{ name: "Run", duration: 20 }],
    }).ok,
    false,
  );
  assert.equal(
    core.validateWorkout({
      date: "2024-06-10",
      exercises: [{ name: "", duration: 20 }],
    }).ok,
    false,
  );
  assert.equal(
    core.validateWorkout({
      date: "2024-06-10",
      exercises: [{ name: "Run", duration: 0 }],
    }).ok,
    false,
  );
  assert.equal(
    core.validateWorkout({
      date: "2024-06-10",
      exercises: [{ name: "Run", duration: 20, intensity: "extreme" }],
    }).ok,
    false,
  );
});

test("loads and migrates legacy storage defensively", () => {
  const legacy = JSON.stringify([
    { id: "old1", date: "2024-06-09", type: "Bike", duration: 45 },
  ]);
  const loaded = core.loadStateFromStorage(legacy);
  assert.equal(loaded.state.version, core.SCHEMA_VERSION);
  assert.equal(loaded.state.workouts.length, 1);
  assert.equal(loaded.state.workouts[0].exercises[0].name, "Bike");
  assert.equal(core.loadStateFromStorage("not-json").state.workouts.length, 0);
  assert.ok(core.loadStateFromStorage("not-json").warnings.length > 0);
});

test("calculates totals, week ranges, and weekly progress without timezone parsing", () => {
  const workouts = [
    workout("mon", "2024-06-10", 30),
    workout("sun", "2024-06-16", 60),
    workout("prev", "2024-06-09", 90),
  ];
  assert.deepEqual(core.totals(workouts), { workouts: 3, minutes: 180 });
  const week = core.getWeekRange("2024-06-12");
  assert.equal(week.start, "2024-06-10");
  assert.equal(week.end, "2024-06-17");
  const progress = core.weeklyProgress(workouts, 120, "2024-06-12");
  assert.equal(progress.minutes, 90);
  assert.equal(progress.percent, 75);
  assert.equal(progress.remaining, 30);
});

test("computes current consecutive-day streak ending on anchor day", () => {
  const workouts = [
    workout("a", "2024-06-10"),
    workout("b", "2024-06-11"),
    workout("c", "2024-06-12"),
    workout("old", "2024-06-08"),
  ];
  assert.equal(core.currentStreak(workouts, "2024-06-12"), 3);
  assert.equal(core.currentStreak(workouts, "2024-06-13"), 0);
});

test("builds activity windows and day details", () => {
  const workouts = [
    workout("a", "2024-06-10", 20),
    workout("b", "2024-06-10", 15),
    workout("c", "2024-06-12", 40),
  ];
  const days = core.activityForLastNDays(workouts, "2024-06-12", 3);
  assert.deepEqual(
    days.map((d) => d.date),
    ["2024-06-10", "2024-06-11", "2024-06-12"],
  );
  assert.equal(days[0].minutes, 35);
  assert.equal(core.dayDetails(workouts, "2024-06-10").workouts.length, 2);
});

test("supports preset add, update, and delete operations", () => {
  const state = { ...core.defaultState(), presets: [] };
  const preset = {
    id: "p1",
    name: "Easy day",
    exercises: [{ name: "Walk", duration: 20, intensity: "low" }],
  };
  const added = core.addPreset(state, preset);
  assert.equal(added.ok, true);
  assert.equal(added.state.presets.length, 1);
  const updated = core.updatePreset(added.state, "p1", {
    ...preset,
    name: "Recovery day",
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.state.presets[0].name, "Recovery day");
  assert.equal(core.deletePreset(updated.state, "p1").presets.length, 0);
});

test("validates import/export round trips and bad imports", () => {
  const state = {
    ...core.defaultState(),
    workouts: [workout("w1", "2024-06-10", 35)],
    presets: [],
    settings: { weeklyGoalMinutes: 200, theme: "dark" },
  };
  const json = core.exportStateJSON(state);
  const imported = core.validateImportJSON(json);
  assert.equal(imported.ok, true);
  assert.equal(imported.summary.workouts, 1);
  assert.equal(imported.summary.weeklyGoalMinutes, 200);
  assert.equal(imported.state.settings.theme, "dark");
  assert.equal(core.validateImportJSON("{bad json").ok, false);
});
