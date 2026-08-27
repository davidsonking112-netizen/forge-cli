# Fitness Tracker Pro

A polished, dependency-free, local-first browser fitness tracker. It runs as static files and keeps workouts, presets, settings, and theme preferences in this browser's `localStorage`.

## Run locally

From `examples/fitness-tracker`:

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000>.

No build step, package install, CDN, or network request is required.

## Test the domain module

```bash
node --test fitness-core.test.mjs
```

The test file imports the browser ES module without requiring a repository-wide `type: module` setting.

## Feature summary

- Responsive dashboard with:
  - Today card
  - Weekly goal progress and editable goal minutes
  - Current consecutive-day streak
  - All-time workout and minute totals
  - Keyboard-operable seven-day activity chart
  - Day details from the chart
  - Recent workout history
- Workout logging:
  - Multiple exercises per workout
  - Exercise name, minutes, intensity, and category
  - Workout date and optional notes
  - Edit and delete workouts with confirmation for destructive actions
- Presets:
  - Save the current exercise list as a reusable preset
  - Apply presets to quickly fill the workout form
  - Edit and delete presets with confirmation for destructive actions
- Data management:
  - Versioned localStorage schema
  - Defensive loading and migration of simple legacy workout records
  - JSON export
  - JSON import with validation, preview, and replace confirmation
  - Clear-data action with confirmation
- Accessibility and UX:
  - Semantic landmarks and headings
  - Labels for controls
  - Strong focus states
  - Light/dark theme toggle persisted locally
  - Toast/status announcements
  - Empty states
  - Reduced-motion support
  - User-provided strings are rendered with `textContent`/safe DOM construction, not injected as HTML

## Data and privacy behavior

Fitness Tracker Pro is local-only. It does not send data to a server and does not use third-party scripts. Data is stored under:

- `fitness-tracker-pro:v2` for app data
- `fitness-tracker-pro:theme` for theme preference

Exports are plain JSON files. Treat them as private health/activity records.

## Acceptance checklist

- [x] Dependency-free vanilla HTML/CSS/ES modules
- [x] Runnable with `python3 -m http.server`
- [x] Pure domain logic separated in `fitness-core.js`
- [x] Node `node:test` coverage for validation, migration/loading, totals, weekly filtering/progress, streaks, presets, import/export, and edge cases
- [x] Versioned localStorage schema with defensive fallback
- [x] No network calls or external CDNs
- [x] Safe rendering of user content
- [x] Responsive layout and polished light/dark theme
- [x] Keyboard-operable chart/history/form controls

## Honest limitations

This is a local-first v1. There is no cloud sync, account system, wearable import, or multi-device conflict resolution. Browser storage can be cleared by the user or the browser, so export JSON periodically if the data matters.
