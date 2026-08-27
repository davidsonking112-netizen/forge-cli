// Fitness Tracker — vanilla JS single-file app
(() => {
  const LS_KEY = "ft.workouts.v1";
  const PRESET_KEY = "ft.presets.v1";
  const META_KEY = "ft.meta.v1";

  function qs(id) {
    return document.getElementById(id);
  }
  const state = {
    workouts: [],
    presets: [],
    meta: { goalMinutes: 150, lastActiveDate: null, streak: 0 },
  };

  // Utilities
  function saveAll() {
    localStorage.setItem(LS_KEY, JSON.stringify(state.workouts));
    localStorage.setItem(PRESET_KEY, JSON.stringify(state.presets));
    localStorage.setItem(META_KEY, JSON.stringify(state.meta));
  }
  function loadAll() {
    try {
      const workouts = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
      const presets = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]");
      const meta = JSON.parse(localStorage.getItem(META_KEY) || "null");
      state.workouts = Array.isArray(workouts) ? workouts : [];
      state.presets = Array.isArray(presets) ? presets : [];
      state.meta = Object.assign(
        state.meta,
        meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {},
      );
    } catch (e) {
      console.error("Load error", e);
      state.workouts = [];
      state.presets = [];
    }
  }

  function isoDate(d) {
    return new Date(d).toISOString().slice(0, 10);
  }
  function todayIso() {
    return isoDate(new Date());
  }

  // Validation
  function validMinutes(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 1440;
  }

  // Render
  function renderPresets() {
    const list = qs("preset-list");
    list.innerHTML = "";
    if (state.presets.length === 0) {
      const li = document.createElement("li");
      li.className = "muted small";
      li.textContent = "No presets yet — add one to speed logging.";
      list.appendChild(li);
      return;
    }
    state.presets.forEach((p, idx) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = p.name;
      name.style.flex = "1";
      const at = document.createElement("span");
      at.className = "muted small";
      at.textContent = p.default ? `${p.default} min` : "";
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.className = "btn";
      edit.type = "button";
      edit.setAttribute("aria-label", `Edit ${p.name} preset`);
      edit.onclick = () => {
        openPresetEditor(idx);
      };
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Remove preset";
      del.type = "button";
      del.setAttribute("aria-label", `Remove ${p.name} preset`);
      del.onclick = () => {
        if (confirm("Remove preset?")) {
          state.presets.splice(idx, 1);
          saveAll();
          renderAll();
        }
      };
      li.append(name, at, edit, del);
      list.appendChild(li);
    });
  }

  function openPresetEditor(idx) {
    const p = state.presets[idx];
    const name = prompt("Preset name", p.name);
    if (!name) return;
    const def = prompt(
      "Default minutes (leave empty for none)",
      p.default || "",
    );
    if (def && !validMinutes(def)) {
      alert("Enter a valid minutes value");
      return;
    }
    state.presets[idx] = {
      name: name.trim(),
      default: def ? Number(def) : null,
    };
    saveAll();
    renderAll();
  }

  function renderExercises(container, workout) {
    container.innerHTML = "";
    (workout.exercises || []).forEach((ex, i) => {
      const row = document.createElement("div");
      row.className = "exercise";
      const input = document.createElement("input");
      input.value = ex.name;
      input.placeholder = "Exercise (e.g., Running)";
      input.setAttribute("aria-label", `Exercise ${i + 1} name`);
      input.required = true;
      input.oninput = () => (ex.name = input.value);
      const minutes = document.createElement("input");
      minutes.type = "number";
      minutes.min = "1";
      minutes.max = "1440";
      minutes.inputMode = "numeric";
      minutes.setAttribute("aria-label", `Exercise ${i + 1} minutes`);
      minutes.value = ex.minutes || "";
      minutes.oninput = () => (ex.minutes = Number(minutes.value));
      const note = document.createElement("input");
      note.placeholder = "Notes";
      note.setAttribute("aria-label", `Exercise ${i + 1} notes`);
      note.value = ex.note || "";
      note.oninput = () => (ex.note = note.value);
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Remove exercise";
      del.type = "button";
      del.setAttribute("aria-label", `Remove exercise ${i + 1}`);
      del.onclick = () => {
        workout.exercises.splice(i, 1);
        renderExercises(container, workout);
      };
      row.append(input, minutes, note, del);
      container.appendChild(row);
    });
  }

  function renderHistory() {
    const list = qs("history-list");
    list.innerHTML = "";
    if (state.workouts.length === 0) {
      qs("log-empty").style.display = "block";
      list.appendChild(
        Object.assign(document.createElement("div"), {
          className: "muted small",
          textContent: "No workouts logged yet.",
        }),
      );
      return;
    }
    qs("log-empty").style.display = "none";
    const sorted = [...state.workouts].sort((a, b) =>
      b.date.localeCompare(a.date),
    );
    sorted.slice(0, 50).forEach((w) => {
      const item = document.createElement("div");
      item.className = "history-item";
      const left = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = `${w.date} — ${w.exercises.map((e) => e.name).join(", ")}`;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${w.totalMinutes} min • ${w.exercises.length} exercises`;
      left.append(title, meta);
      const actions = document.createElement("div");
      const view = document.createElement("button");
      view.textContent = "View";
      view.className = "btn";
      view.onclick = () => {
        populateFormWith(w);
      };
      const rem = document.createElement("button");
      rem.textContent = "Delete";
      rem.className = "btn";
      rem.onclick = () => {
        if (confirm("Delete workout?")) {
          state.workouts = state.workouts.filter((x) => x.id !== w.id);
          saveAll();
          renderAll();
        }
      };
      actions.append(view, rem);
      item.append(left, actions);
      list.appendChild(item);
    });
  }

  function renderSummary() {
    const week = lastNDays(7);
    const perDay = week.map((d) => ({ date: d, minutes: 0, workouts: [] }));
    state.workouts.forEach((w) => {
      const idx = perDay.findIndex((p) => p.date === w.date);
      if (idx >= 0) {
        perDay[idx].minutes += w.totalMinutes;
        perDay[idx].workouts.push(w);
      }
    });
    qs("weekly-minutes").textContent = String(
      perDay.reduce((s, p) => s + p.minutes, 0),
    );
    qs("workout-count").textContent = String(
      perDay.reduce((s, p) => s + p.workouts.length, 0),
    );
    // streak
    updateStreak(perDay);
    // progress
    const goal = state.meta.goalMinutes || 0;
    const achieved = perDay.reduce((s, p) => s + p.minutes, 0);
    const pct = goal ? Math.min(100, Math.round((achieved / goal) * 100)) : 0;
    const bar = qs("goal-progress");
    bar.style.width = pct + "%";
    bar.setAttribute("aria-valuenow", String(pct));
    bar.setAttribute(
      "aria-valuetext",
      goal ? `${achieved} of ${goal} minutes this week` : "No weekly goal set",
    );
    qs("goal-summary").textContent = goal
      ? `${achieved} of ${goal} min (${pct}%) this week`
      : "No weekly goal set.";

    // week chart
    const chart = qs("week-chart");
    chart.innerHTML = "";
    perDay.forEach((p, i) => {
      const bar = document.createElement("button");
      bar.type = "button";
      bar.className = "bar" + (p.minutes > 0 ? " active" : "");
      bar.title = `${p.date}: ${p.minutes} min`;
      bar.setAttribute("aria-label", `${p.date}: ${p.minutes} minutes`);
      bar.style.height =
        (p.minutes > 0 ? Math.min(100, (p.minutes / (goal || 60)) * 100) : 6) +
        "%";
      bar.onclick = () => showDayDetails(p);
      const label = document.createElement("div");
      label.className = "muted small";
      label.textContent = p.date.slice(5);
      bar.appendChild(label);
      chart.appendChild(bar);
    });
  }

  function showDayDetails(day) {
    if (!day.workouts.length) {
      alert("No workouts on " + day.date);
      return;
    }
    const list = day.workouts
      .map(
        (w) =>
          `${w.date}: ${w.totalMinutes} min — ${w.exercises.map((e) => `${e.name}(${e.minutes})`).join(", ")}`,
      )
      .join("\n");
    alert(list);
  }

  // helpers
  function lastNDays(n) {
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(isoDate(d));
    }
    return days;
  }

  function updateStreak(perDay) {
    const activeDates = new Set(
      state.workouts
        .filter((w) => w && typeof w.date === "string" && w.totalMinutes > 0)
        .map((w) => w.date),
    );
    const cursor = new Date();
    let streak = 0;
    while (activeDates.has(todayIso(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    state.meta.streak = streak;
    qs("current-streak").textContent = String(streak);
    // lastActiveDate
    const lastActive = state.workouts.length
      ? state.workouts
          .map((w) => w.date)
          .sort()
          .slice(-1)[0]
      : null;
    state.meta.lastActiveDate = lastActive;
    saveAll();
  }

  function renderAll() {
    renderPresets();
    renderHistory();
    renderSummary();
  }

  // Form handling
  function addExerciseRow(container, ex) {
    if (!ex) ex = { name: "", minutes: null, note: "" };
    if (!container.workout) container.workout = { exercises: [] };
    container.workout.exercises.push(ex);
    renderExercises(container, container.workout);
  }

  function populateFormWith(workout) {
    const form = qs("workout-form");
    form.dataset.editId = workout.id;
    qs("workout-date").value = workout.date;
    const container = qs("exercises-container");
    container.workout = JSON.parse(JSON.stringify(workout));
    renderExercises(container, container.workout);
  }

  function clearForm() {
    const form = qs("workout-form");
    delete form.dataset.editId;
    qs("workout-date").value = todayIso();
    const container = qs("exercises-container");
    container.workout = { exercises: [] };
    renderExercises(container, container.workout);
  }

  // persist workout
  function saveWorkoutFromForm(e) {
    e && e.preventDefault();
    const date = qs("workout-date").value;
    if (!date) {
      alert("Please choose a date");
      return;
    }
    const container = qs("exercises-container");
    const workout = container.workout || { exercises: [] };
    if (!workout.exercises.length) {
      alert("Add at least one exercise");
      return;
    }
    for (const ex of workout.exercises) {
      ex.name = String(ex.name || "").trim();
      ex.note = String(ex.note || "").trim();
      if (!ex.name || !validMinutes(ex.minutes)) {
        alert("Each exercise needs a name and valid minutes");
        return;
      }
    }
    workout.date = date;
    workout.totalMinutes = workout.exercises.reduce(
      (s, x) => s + Number(x.minutes),
      0,
    );
    workout.id = qs("workout-form").dataset.editId || "w_" + Date.now();
    // replace if editing
    state.workouts = state.workouts
      .filter((w) => w.id !== workout.id)
      .concat([workout]);
    saveAll();
    renderAll();
    clearForm();
  }

  // preset add
  function addPresetFromForm(e) {
    e && e.preventDefault();
    const name = qs("preset-name").value.trim();
    const def = qs("preset-default").value.trim();
    if (!name) {
      alert("Enter preset name");
      return;
    }
    if (def && !validMinutes(def)) {
      alert("Default minutes invalid");
      return;
    }
    state.presets.push({ name, default: def ? Number(def) : null });
    qs("preset-name").value = "";
    qs("preset-default").value = "";
    saveAll();
    renderAll();
  }

  // update goal
  function saveGoal() {
    const v = qs("goal-input").value;
    if (!validMinutes(v)) {
      alert("Enter a valid weekly minutes goal");
      return;
    }
    state.meta.goalMinutes = Number(v);
    saveAll();
    renderAll();
  }

  // preset quick fill
  function presetQuickFill(preset) {
    const container = qs("exercises-container");
    if (!container.workout) container.workout = { exercises: [] };
    container.workout.exercises.push({
      name: preset.name,
      minutes: preset.default || 30,
      note: "",
    });
    renderExercises(container, container.workout);
  }

  // wire up
  function init() {
    loadAll(); // set defaults if empty
    if (!state.meta.goalMinutes) state.meta.goalMinutes = 150;
    qs("goal-input").value = state.meta.goalMinutes;
    // forms
    qs("workout-form").addEventListener("submit", saveWorkoutFromForm);
    qs("add-exercise").addEventListener("click", () => {
      const container = qs("exercises-container");
      addExerciseRow(container);
    });
    qs("clear-form").addEventListener("click", clearForm);
    qs("preset-form").addEventListener("submit", addPresetFromForm);
    qs("save-goal").addEventListener("click", saveGoal);

    // presets clickable quick-fill
    document.getElementById("preset-list").addEventListener("click", (ev) => {
      const target = ev.target;
      if (target.tagName === "SPAN") {
        const name = target.textContent;
        const p = state.presets.find((x) => x.name === name);
        if (p) presetQuickFill(p);
      }
    });

    // double click preset to quick add
    qs("preset-list").addEventListener("dblclick", (ev) => {
      const t = ev.target;
      if (t.tagName === "SPAN") {
        const name = t.textContent;
        const p = state.presets.find((x) => x.name === name);
        if (p) presetQuickFill(p);
      }
    });

    // populate today
    clearForm();
    renderAll();
    // accessible keyboard: allow pressing Enter on selected history items
    qs("history-list").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const btn = e.target.querySelector("button");
        btn && btn.click();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
