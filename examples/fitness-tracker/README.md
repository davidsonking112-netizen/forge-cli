# Fitness Tracker

A lightweight, local-only browser fitness tracker built with vanilla HTML, CSS, and JavaScript. It has no package dependencies, sends no network requests, and stores workouts, presets, goals, and derived progress in browser `localStorage`.

## Run it

From this directory, start a static server:

```bash
python3 -m http.server 8000
```

Open <http://127.0.0.1:8000> in a browser.

## Features

The dashboard supports weekly minute goals, workout logging with multiple exercises and notes, editable exercise presets, recent-workout history, seven-day activity bars, goal progress, and a current-day streak. Controls include validation for required fields and minute ranges, confirmation before deleting data, visible empty states, responsive layout, and keyboard-focus styling.

Data is local to the browser origin. No account, server, or remote database is used. Clearing site data removes the stored tracker data.

## Acceptance checklist

1. Open the app and confirm the dashboard renders without a console error.
2. Add a `Morning Run` preset with a 30-minute default and submit it with the Add button or Enter.
3. Add a workout, choose a date, add an exercise, enter a positive duration, and save it.
4. Confirm weekly minutes, workout count, goal progress, streak, history, and the current week bar update.
5. Reload the page and confirm the workout and preset remain.
6. Try an empty workout, a missing exercise name, a zero/negative duration, and an invalid goal; confirm no invalid record is saved.
7. Use View, Edit, and Delete controls and confirm the corresponding state changes.
8. Resize the viewport to a narrow width and confirm the form and dashboard remain usable.
