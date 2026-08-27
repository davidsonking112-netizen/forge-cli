import {
  addDaysISO,
  activityForLastNDays,
  currentStreak,
  dayDetails,
  durationOfWorkout,
  exportStateJSON,
  loadStateFromStorage,
  makePreset,
  makeWorkout,
  sortWorkouts,
  todayISO,
  totals,
  validateImportJSON,
  validatePreset,
  validateWorkout,
  weeklyProgress,
} from "./fitness-core.js";

const STORAGE_KEY = "fitness-tracker-pro:v2";
const THEME_KEY = "fitness-tracker-pro:theme";

const $ = (selector) => document.querySelector(selector);
const elements = {
  themeToggle: $("#themeToggle"),
  exportButton: $("#exportButton"),
  importFile: $("#importFile"),
  clearButton: $("#clearButton"),
  todayTitle: $("#todayTitle"),
  todaySummary: $("#todaySummary"),
  todayMeta: $("#todayMeta"),
  weeklyTitle: $("#weeklyTitle"),
  weeklyMeta: $("#weeklyMeta"),
  weeklyProgress: $("#weeklyProgress"),
  weeklyGoal: $("#weeklyGoal"),
  goalForm: $("#goalForm"),
  streakValue: $("#streakValue"),
  streakMeta: $("#streakMeta"),
  totalWorkouts: $("#totalWorkouts"),
  totalMinutes: $("#totalMinutes"),
  activityChart: $("#activityChart"),
  dayDetails: $("#dayDetails"),
  historyList: $("#historyList"),
  toastRegion: $("#toastRegion"),
  workoutForm: $("#workoutForm"),
  workoutDate: $("#workoutDate"),
  workoutNotes: $("#workoutNotes"),
  editingWorkoutId: $("#editingWorkoutId"),
  exerciseList: $("#exerciseList"),
  addExerciseButton: $("#addExerciseButton"),
  resetFormButton: $("#resetFormButton"),
  cancelEditButton: $("#cancelEditButton"),
  saveWorkoutButton: $("#saveWorkoutButton"),
  formTitle: $("#formTitle"),
  presetForm: $("#presetForm"),
  presetName: $("#presetName"),
  editingPresetId: $("#editingPresetId"),
  presetList: $("#presetList"),
  savePresetButton: $("#savePresetButton"),
  cancelPresetEditButton: $("#cancelPresetEditButton"),
};

const loaded = loadStateFromStorage(safeGet(STORAGE_KEY));
let state = loaded.state;
let selectedDay = todayISO();
if (!state.settings.theme) state.settings.theme = safeGet(THEME_KEY) || "light";

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    toast(
      "Unable to save locally. Browser storage may be full or disabled.",
      "error",
    );
    return false;
  }
}
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function nowStamp() {
  return new Date().toISOString();
}

function createElement(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "hidden") node.hidden = Boolean(value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null)
      node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

function toast(message, type = "success") {
  const node = createElement("div", {
    className: `toast ${type}`,
    role: type === "error" ? "alert" : "status",
    text: message,
  });
  elements.toastRegion.append(node);
  setTimeout(() => node.remove(), 4200);
}

function persist(message) {
  state.workouts = sortWorkouts(state.workouts);
  if (safeSet(STORAGE_KEY, exportStateJSON(state))) {
    safeSet(THEME_KEY, state.settings.theme || "light");
    if (message) toast(message);
  }
}

function applyTheme() {
  const theme = state.settings.theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  elements.themeToggle.textContent =
    theme === "dark" ? "Use light theme" : "Use dark theme";
  elements.themeToggle.setAttribute(
    "aria-pressed",
    theme === "dark" ? "true" : "false",
  );
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
function humanDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
function shortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function render() {
  applyTheme();
  renderSummary();
  renderChart();
  renderHistory();
  renderPresets();
}

function renderSummary() {
  const today = todayISO();
  const details = dayDetails(state.workouts, today);
  elements.todayTitle.textContent = humanDate(today);
  elements.todaySummary.textContent = `${details.minutes} min`;
  elements.todayMeta.textContent = details.workouts.length
    ? `${plural(details.workouts.length, "workout")} logged today.`
    : "No workouts logged today yet.";

  const progress = weeklyProgress(
    state.workouts,
    state.settings.weeklyGoalMinutes,
    today,
  );
  elements.weeklyGoal.value = String(state.settings.weeklyGoalMinutes);
  elements.weeklyTitle.textContent = `${progress.minutes} / ${progress.goal} min`;
  elements.weeklyProgress.value = String(progress.percent);
  elements.weeklyProgress.setAttribute(
    "aria-label",
    `Weekly goal progress: ${progress.minutes} of ${progress.goal} minutes, ${progress.percent} percent.`,
  );
  elements.weeklyMeta.textContent =
    progress.remaining === 0
      ? "Goal reached. Extra minutes still count in your history."
      : `${progress.remaining} minutes remaining through Sunday.`;

  const streak = currentStreak(state.workouts, today);
  elements.streakValue.textContent = String(streak);
  elements.streakMeta.textContent = streak
    ? `You have moved for ${plural(streak, "consecutive day")}.`
    : "Log a workout today to start a streak.";
  const total = totals(state.workouts);
  elements.totalWorkouts.textContent = String(total.workouts);
  elements.totalMinutes.textContent = String(total.minutes);
}

function renderChart() {
  const days = activityForLastNDays(state.workouts, selectedDay, 7);
  const max = Math.max(30, ...days.map((d) => d.minutes));
  elements.activityChart.replaceChildren();
  for (const day of days) {
    const pressed = day.date === selectedDay;
    const button = createElement("button", {
      type: "button",
      className: "day-bar",
      role: "listitem",
      "aria-pressed": pressed ? "true" : "false",
      "aria-label": `${humanDate(day.date)}: ${day.minutes} minutes. Select to view details.`,
      onClick: () => {
        selectedDay = day.date;
        renderChart();
      },
    });
    button.append(
      createElement("span", { className: "bar-track", "aria-hidden": "true" }, [
        createElement("span", {
          className: "bar-fill",
          style: {
            height: `${Math.max(4, Math.round((day.minutes / max) * 100))}%`,
          },
        }),
      ]),
      createElement("span", {
        className: "bar-label",
        text: shortDate(day.date).replace(",", ""),
      }),
      createElement("span", {
        className: "bar-value",
        text: `${day.minutes}m`,
      }),
    );
    elements.activityChart.append(button);
  }
  const details = dayDetails(state.workouts, selectedDay);
  const box = createElement("div");
  box.append(
    createElement("p", {
      className: "item-title",
      text: `${humanDate(selectedDay)} · ${details.minutes} minutes`,
    }),
  );
  if (!details.workouts.length) {
    box.append(
      createElement("p", {
        className: "muted compact",
        text: "No workout logged for this day.",
      }),
    );
  } else {
    const list = createElement("ul");
    for (const workout of details.workouts) {
      list.append(
        createElement("li", {
          text: `${durationOfWorkout(workout)} min — ${workout.exercises.map((e) => e.name).join(", ")}`,
        }),
      );
    }
    box.append(list);
  }
  elements.dayDetails.replaceChildren(box);
}

function renderHistory() {
  elements.historyList.replaceChildren();
  const workouts = sortWorkouts(state.workouts).slice(0, 30);
  if (!workouts.length) {
    elements.historyList.append(
      createElement("div", {
        className: "empty-state",
        text: "Your history is empty. Add a workout to see trends, streaks, and weekly progress.",
      }),
    );
    return;
  }
  for (const workout of workouts) {
    const item = createElement("article", { className: "history-item" });
    const heading = createElement("div");
    heading.append(
      createElement("p", {
        className: "item-title",
        text: `${humanDate(workout.date)} · ${durationOfWorkout(workout)} min`,
      }),
    );
    if (workout.notes)
      heading.append(
        createElement("p", { className: "item-meta", text: workout.notes }),
      );
    const actions = createElement("div", { className: "item-actions" }, [
      createElement("button", {
        type: "button",
        className: "button small ghost",
        text: "Edit",
        onClick: () => editWorkout(workout.id),
      }),
      createElement("button", {
        type: "button",
        className: "button small danger-ghost",
        text: "Delete",
        onClick: () => deleteWorkout(workout.id),
      }),
    ]);
    item.append(
      createElement("div", { className: "item-header" }, [heading, actions]),
      exerciseChips(workout.exercises),
    );
    elements.historyList.append(item);
  }
}

function exerciseChips(exercises) {
  const chips = createElement("div", { className: "chip-list" });
  for (const ex of exercises) {
    const bits = [`${ex.name}`, `${ex.duration}m`];
    if (ex.intensity) bits.push(ex.intensity);
    if (ex.category) bits.push(ex.category);
    chips.append(
      createElement("span", { className: "chip", text: bits.join(" · ") }),
    );
  }
  return chips;
}

function renderPresets() {
  elements.presetList.replaceChildren();
  if (!state.presets.length) {
    elements.presetList.append(
      createElement("div", {
        className: "empty-state",
        text: "No presets yet. Configure exercises above, name the preset, then save it.",
      }),
    );
    return;
  }
  for (const preset of state.presets) {
    const item = createElement("article", { className: "preset-item" });
    const title = createElement("div");
    title.append(
      createElement("p", { className: "item-title", text: preset.name }),
    );
    title.append(
      createElement("p", {
        className: "item-meta",
        text: `${preset.exercises.length} ${preset.exercises.length === 1 ? "exercise" : "exercises"} · ${preset.exercises.reduce((sum, e) => sum + e.duration, 0)} min`,
      }),
    );
    const actions = createElement("div", { className: "item-actions" }, [
      createElement("button", {
        type: "button",
        className: "button small",
        text: "Apply",
        onClick: () => applyPreset(preset.id),
      }),
      createElement("button", {
        type: "button",
        className: "button small ghost",
        text: "Edit",
        onClick: () => editPreset(preset.id),
      }),
      createElement("button", {
        type: "button",
        className: "button small danger-ghost",
        text: "Delete",
        onClick: () => deletePreset(preset.id),
      }),
    ]);
    item.append(
      createElement("div", { className: "item-header" }, [title, actions]),
      exerciseChips(preset.exercises),
    );
    elements.presetList.append(item);
  }
}

function blankExercise() {
  return { id: uid("ex"), name: "", duration: 30, intensity: "", category: "" };
}
function renderExerciseInputs(exercises = [blankExercise()]) {
  elements.exerciseList.replaceChildren();
  exercises.forEach((exercise, index) => {
    const row = createElement("div", {
      className: "exercise-card",
      "data-exercise-id": exercise.id || uid("ex"),
    });
    const fields = createElement("div", { className: "exercise-fields" });
    const name = inputLabel(
      "Exercise name",
      createElement("input", {
        type: "text",
        value: exercise.name || "",
        maxlength: "80",
        required: "required",
        placeholder: "Run, cycling, squats",
      }),
    );
    const duration = inputLabel(
      "Minutes",
      createElement("input", {
        type: "number",
        min: "1",
        max: "1440",
        step: "1",
        inputmode: "numeric",
        value: String(exercise.duration || 30),
        required: "required",
      }),
    );
    const intensity = inputLabel(
      "Intensity",
      intensitySelect(exercise.intensity || ""),
    );
    const category = inputLabel(
      "Category optional",
      createElement("input", {
        type: "text",
        maxlength: "40",
        value: exercise.category || "",
        placeholder: "Cardio, strength",
      }),
    );
    const remove = createElement("button", {
      type: "button",
      className: "button small danger-ghost",
      text: "Remove",
      "aria-label": `Remove exercise ${index + 1}`,
      onClick: () => {
        row.remove();
        if (!elements.exerciseList.children.length)
          renderExerciseInputs([blankExercise()]);
      },
    });
    fields.append(name, duration, intensity, category, remove);
    row.append(fields);
    elements.exerciseList.append(row);
  });
}
function inputLabel(text, control) {
  const label = createElement("label");
  label.append(document.createTextNode(text), control);
  return label;
}
function intensitySelect(value) {
  const select = createElement("select");
  const options = [
    ["", "Not specified"],
    ["low", "Low"],
    ["moderate", "Moderate"],
    ["high", "High"],
  ];
  for (const [val, text] of options) {
    const option = createElement("option", { value: val, text });
    if (val === value) option.selected = true;
    select.append(option);
  }
  return select;
}

function getFormExercises() {
  return [...elements.exerciseList.querySelectorAll(".exercise-card")].map(
    (row) => {
      const controls = row.querySelectorAll("input, select");
      return {
        id: row.dataset.exerciseId || uid("ex"),
        name: controls[0].value,
        duration: controls[1].value,
        intensity: controls[2].value,
        category: controls[3].value,
      };
    },
  );
}
function resetWorkoutForm() {
  elements.editingWorkoutId.value = "";
  elements.workoutDate.value = todayISO();
  elements.workoutNotes.value = "";
  elements.formTitle.textContent = "Add a session";
  elements.saveWorkoutButton.textContent = "Save workout";
  elements.cancelEditButton.hidden = true;
  renderExerciseInputs([blankExercise()]);
}

function saveWorkout(event) {
  event.preventDefault();
  const editingId = elements.editingWorkoutId.value;
  const existing = state.workouts.find((w) => w.id === editingId);
  const candidate = makeWorkout({
    id: editingId || uid("workout"),
    date: elements.workoutDate.value,
    notes: elements.workoutNotes.value,
    exercises: getFormExercises(),
    createdAt: existing?.createdAt || nowStamp(),
    updatedAt: nowStamp(),
  });
  const checked = validateWorkout(candidate);
  if (!checked.ok) {
    toast(checked.errors.join(" "), "error");
    return;
  }
  if (editingId)
    state.workouts = state.workouts.map((w) =>
      w.id === editingId ? checked.value : w,
    );
  else state.workouts.push(checked.value);
  selectedDay = checked.value.date;
  persist(editingId ? "Workout updated." : "Workout saved.");
  resetWorkoutForm();
  render();
}
function editWorkout(id) {
  const workout = state.workouts.find((w) => w.id === id);
  if (!workout) return;
  elements.editingWorkoutId.value = workout.id;
  elements.workoutDate.value = workout.date;
  elements.workoutNotes.value = workout.notes || "";
  elements.formTitle.textContent = "Edit workout";
  elements.saveWorkoutButton.textContent = "Update workout";
  elements.cancelEditButton.hidden = false;
  renderExerciseInputs(workout.exercises);
  elements.workoutForm.scrollIntoView({ behavior: "smooth", block: "start" });
  elements.workoutDate.focus();
}
function deleteWorkout(id) {
  const workout = state.workouts.find((w) => w.id === id);
  if (!workout) return;
  if (
    !confirm(
      `Delete the ${durationOfWorkout(workout)} minute workout from ${humanDate(workout.date)}? This cannot be undone.`,
    )
  )
    return;
  state.workouts = state.workouts.filter((w) => w.id !== id);
  persist("Workout deleted.");
  render();
}

function savePreset(event) {
  event.preventDefault();
  const editingId = elements.editingPresetId.value;
  const existing = state.presets.find((p) => p.id === editingId);
  const candidate = makePreset({
    id: editingId || uid("preset"),
    name: elements.presetName.value,
    exercises: getFormExercises(),
    createdAt: existing?.createdAt || nowStamp(),
    updatedAt: nowStamp(),
  });
  const checked = validatePreset(candidate);
  if (!checked.ok) {
    toast(checked.errors.join(" "), "error");
    return;
  }
  if (editingId)
    state.presets = state.presets.map((p) =>
      p.id === editingId ? checked.value : p,
    );
  else state.presets.push(checked.value);
  resetPresetForm();
  persist(editingId ? "Preset updated." : "Preset saved.");
  renderPresets();
}
function applyPreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  renderExerciseInputs(preset.exercises.map((e) => ({ ...e, id: uid("ex") })));
  toast(`Applied preset: ${preset.name}.`);
}
function editPreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  elements.editingPresetId.value = preset.id;
  elements.presetName.value = preset.name;
  elements.savePresetButton.textContent = "Update preset";
  elements.cancelPresetEditButton.hidden = false;
  renderExerciseInputs(preset.exercises);
  elements.presetName.focus();
}
function deletePreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  if (
    !confirm(
      `Delete preset “${preset.name}”? Workouts already logged will not be changed.`,
    )
  )
    return;
  state.presets = state.presets.filter((p) => p.id !== id);
  persist("Preset deleted.");
  renderPresets();
}
function resetPresetForm() {
  elements.editingPresetId.value = "";
  elements.presetName.value = "";
  elements.savePresetButton.textContent = "Save preset";
  elements.cancelPresetEditButton.hidden = true;
}

function exportData() {
  const blob = new Blob([exportStateJSON(state)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = createElement("a", {
    href: url,
    download: `fitness-tracker-pro-${todayISO()}.json`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("Export created. Keep the JSON somewhere private.");
}
function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = validateImportJSON(String(reader.result || ""));
    elements.importFile.value = "";
    if (!result.ok) {
      toast(result.errors.join(" "), "error");
      return;
    }
    const summary = result.summary;
    const message = `Import preview:\n\n${summary.workouts} workouts\n${summary.presets} presets\nWeekly goal: ${summary.weeklyGoalMinutes} minutes\n\nReplace all current local data with this file?`;
    if (!confirm(message)) {
      toast("Import cancelled.");
      return;
    }
    state = result.state;
    selectedDay = todayISO();
    persist("Import complete.");
    resetWorkoutForm();
    resetPresetForm();
    render();
  };
  reader.onerror = () => toast("Could not read that file.", "error");
  reader.readAsText(file);
}

function clearData() {
  if (
    !confirm(
      "Clear all workouts, presets, and settings in this browser? This cannot be undone unless you have an export.",
    )
  )
    return;
  localStorage.removeItem(STORAGE_KEY);
  const fresh = loadStateFromStorage(null);
  state = fresh.state;
  selectedDay = todayISO();
  resetWorkoutForm();
  resetPresetForm();
  persist("All local data cleared.");
  render();
}

elements.themeToggle.addEventListener("click", () => {
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
  persist();
  applyTheme();
});
elements.exportButton.addEventListener("click", exportData);
elements.importFile.addEventListener("change", () =>
  importData(elements.importFile.files?.[0]),
);
elements.clearButton.addEventListener("click", clearData);
elements.goalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const goal = Number(elements.weeklyGoal.value);
  if (!Number.isInteger(goal) || goal < 1 || goal > 10080) {
    toast("Weekly goal must be between 1 and 10,080 minutes.", "error");
    return;
  }
  state.settings.weeklyGoalMinutes = goal;
  persist("Weekly goal updated.");
  renderSummary();
});
elements.workoutForm.addEventListener("submit", saveWorkout);
elements.addExerciseButton.addEventListener("click", () =>
  renderExerciseInputs([...getFormExercises(), blankExercise()]),
);
elements.resetFormButton.addEventListener("click", resetWorkoutForm);
elements.cancelEditButton.addEventListener("click", resetWorkoutForm);
elements.presetForm.addEventListener("submit", savePreset);
elements.cancelPresetEditButton.addEventListener("click", resetPresetForm);

if (loaded.warnings.length)
  toast(`Loaded with repairs: ${loaded.warnings.join(" ")}`, "error");
resetWorkoutForm();
render();
