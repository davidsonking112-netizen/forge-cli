# Fitness tracker browser smoke test

Date: 2026-08-27

The generated app was served with `python3 -m http.server 8123` from `examples/fitness-tracker` and opened at `http://127.0.0.1:8123/`.

Initial load succeeded. The page rendered the Fitness Tracker heading, weekly goal input and progress bar, activity/streak counters, exercise presets form, workout logging form, recent workouts panel, seven-day summary bars, and localStorage/no-network note. The browser reported no visible runtime failure during load.

Clicking `+ Add exercise` succeeded and dynamically added an exercise name input, numeric minutes input, notes input, and remove button. The browser interaction list updated to expose those controls. Further testing should enter a workout, save it, confirm counters/history/chart update, reload to test localStorage persistence, and exercise invalid-input paths.

The browser test entered `Running` for 30 minutes and clicked Save Workout. The UI updated successfully: weekly minutes became 30, workouts this week became 1, the progress bar became 20% of the 150-minute goal, day streak became 1, and Recent Workouts displayed the saved entry with View/Delete controls. The current week chart showed an active bar for the current date.

Reloading the page preserved the saved workout and all derived values, confirming localStorage persistence. Entering a `Morning Run` preset with a 30-minute default was accepted in the preset form and ready for save. The app remained responsive and rendered consistently after reload.

After entering `Morning Run` and `30`, the attempted preset Add click did not update the preset list; the form values remained visible and the empty-state message remained. This is a discovered interaction defect requiring investigation. The browser smoke test therefore confirms core workout logging and persistence, but preset creation is not yet verified as working.

The preset Add click did not update the list in the browser automation path, but submitting the same filled form with Enter succeeded. The list then displayed `Morning Run`, `30 min`, Edit, and remove controls. This indicates the application form handler works and the earlier failure was likely click targeting rather than application logic. The preset list’s visible text and controls are now confirmed.

The goal field accepted the typed value `-5` at the HTML-input layer, but the UI remained at the previous 150-minute summary until the Save action. The next step is to submit and confirm the application rejects the negative value without changing stored state.

After hardening the artifact, a fresh browser load at `http://localhost:8123/` succeeded. The new preset minutes field is a numeric input with an accessible label, and weekly chart bars are keyboard-focusable button elements with date/minutes labels. The dashboard rendered without the earlier native-alert blockage or visible runtime failure. The clean browser session starts with empty localStorage, as expected for a new origin/session.
