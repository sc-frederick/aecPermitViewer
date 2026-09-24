# Interface notes

The first user is a permit professional reviewing several saved public records. The surface is an Operate tool: one page with an add-permit card and a "Permits" card with a table. Detail and settings open in a right-side sheet so the list stays in view.

## Truthfulness rules

- Portal status text is shown exactly as the portal displayed it, in neutral styling. It never gets a color, icon, or interpretation. "In Process" is not an action request.
- Color only marks the app's own check results in the "Last check" column and the history timeline: green for verified, amber for a failed attempt, blue (pulsing) for a queued or running check. Cancelled and never-checked use neutral text.
- When the latest check failed, the row keeps the older verified status and its original time; the failure shows only in the Last check column.
- The filter tabs use facts the app recorded ("Failed", "No status yet"), never portal-status meaning.
- Record links are available only after a verified observation.

## Structure

- Header: product name (the page heading) and Settings. Copy is kept to labels and short messages. No subtitles, helper paragraphs, or footer.
- A warning-tinted banner appears whenever the key is missing or key storage is unavailable.
- Add a permit: an explicit jurisdiction select (one supported profile), the full permit number, and "Add permit". Validation errors appear inline under the form.
- Permits: filter tabs with counts, the Schedule select, and a table with Permit, Status, Verified, Last check, and row actions (Check now or Cancel, plus open the verified record). The permit number opens the details sheet. A "Not scheduled" tag marks permits excluded from scheduled checks. The list heading shows when the next scheduled check will run.
- Details sheet: current status and verification time, Check now, Open record, the scheduled-check toggle with that permit's next check time, the full check history, and Remove permit.
- Settings sheet: TypeSafe key (a password field that sends the key once for encryption, clears itself, and never shows the key again; replace or remove), background and notification switches, signed full-installer updates, and local-data deletion.
- Destructive or disruptive actions (remove permit, delete local data, install update) use an in-app confirm dialog.

## Background and notifications

- Closing the window hides it; Permit Monitor keeps running from the notification area. The first time this happens, one notification explains where the app went. The tray menu offers Open, Check all permits now, a Scheduled checks toggle, and Quit. The tray icon gains an amber dot while any permit's latest check has failed.
- Desktop notifications fire only for facts the app recorded: the first status for a new permit, a change in the portal's exact wording (old and new quoted), and the first failure in a row. Repeat failures and unchanged statuses stay quiet, and a missing key produces one notice per session. When the window is in front, the same message shows as an in-app notice instead.
- Clicking a notification opens that permit's details sheet.
- Settings has four switches: keep running when closed, start at Windows sign-in (installed app only, off by default), status-change notifications, and failure notifications.

## Visual system

Tokens live at the top of `src/renderer/styles.css`, with a dark theme under `prefers-color-scheme: dark`, so the app follows Windows light or dark mode. The font is Segoe UI Variable / Segoe UI. The palette is a cool neutral background, white cards (12px radius, 1px border, no shadow), a single restrained blue accent for primary actions and the selected filter, and amber for check failures. Type runs from 12px (meta) to 14px (body and data) to 17px (section headings) to 28px (page title). Motion is limited to state changes: the sheet slides in, new rows flash briefly, and a queued or running check pulses. Reduced-motion users get a simple fade instead.

Portal content and the API key never render in the app window. Keep future jurisdiction options explicit, with authority type and coverage visible before a permit is saved.
