# Interface notes

The first user is a permit professional reviewing several saved public records. The surface is an Operate tool: one page with an add-permit card and a "Permits" card with a table. Detail and settings open in a right-side sheet so the list stays in view.

## Truthfulness rules

- Portal status text is shown exactly as the portal displayed it, in neutral styling. It never gets a color, icon, or interpretation. "In Process" is not an action request.
- Color only marks the app's own check results in the "Last check" column and the history timeline: an ink dot for verified, oxide red (`#a8331a`) for a failed attempt, and a pulsing ember dot for a queued or running check. Cancelled and never-checked use neutral text.
- When the latest check failed, the row keeps the older verified status and its original time; the failure shows only in the Last check column.
- The filter tabs use facts the app recorded ("Failed", "No status yet"), never portal-status meaning.
- Record links are available only after a verified observation.

## Structure

- Header: the app icon and "Permit *Monitor*" wordmark (the page heading), when the next scheduled check runs, and Settings. The layout stays minimal: copy is kept to labels and short messages. No headlines, stat readouts, section titles, subtitles, helper paragraphs, decorative imagery, or footer.
- A hairline-framed banner with an ember left rule appears whenever the key is missing or key storage is unavailable.
- Add a permit: one card with an explicit issuing-jurisdiction select, the full permit number, "Add permit", and the Show filter (with counts). The jurisdiction's coverage and access note appears before saving. Validation errors appear inline under the form.
- Permits: a table with Permit, Status, Verified, Last check, and row actions (Check now or Cancel, plus open the verified record). The permit number opens the details sheet. A "Not scheduled" tag marks permits excluded from scheduled checks. The empty state is one serif line.
- Projects: after a permit is added, a small dialog asks for the user's own project number (Skip or Add), prefilled with the last one used and offering recent ones as chips. Once any permit has a project number, the table groups permits under parchment band headers ("Project 28069 · 3 permits") in natural order, with "No project" last; each group is its own `tbody`.
- Details sheet: current status and verification time, Check now, Open record, the project number (saved on Enter or leaving the field; blank clears it), the scheduled-check toggle with that permit's next check time, the full check history, and Remove permit.
- Settings sheet: TypeSafe key (a password field that sends the key once for encryption, clears itself, and never shows the key again; replace or remove), background and notification switches, signed full-installer updates, and local-data deletion.
- Destructive or disruptive actions (remove permit, delete local data, install update) use an in-app confirm dialog.

## Background and notifications

- Closing the window hides it; Permit Monitor keeps running from the notification area. The first time this happens, one notification explains where the app went. The tray menu offers Open, Check all permits now, a Scheduled checks toggle, and Quit. The tray icon gains an ember dot while any permit's latest check has failed.
- Desktop notifications fire only for facts the app recorded: the first status for a new permit, a change in the portal's exact wording (old and new quoted), and the first failure in a row. Repeat failures and unchanged statuses stay quiet, and a missing key produces one notice per session. When the window is in front, the same message shows as an in-app notice instead.
- Clicking a notification opens that permit's details sheet.
- Settings has four switches: keep running when closed, start at Windows sign-in (installed app only, off by default), status-change notifications, and failure notifications.

## Visual system

The renderer follows the Zephyr Atlas design system: an editorial, print-like look with parchment paper, ink hairlines, and three type voices. Tokens live at the top of `src/renderer/styles.css`. It is light-only; there is no dark theme.

- Palette: parchment `#f1ede4` page, bone `#f8f5ec` raised surfaces, ink `#141312` for type, rules, and primary buttons, graphite and fog for secondary text and soft rules. Ember `#c8521c` is reserved for live things (a running check, the missing-key banner rule). Oxide `#a8331a` marks failed checks and field errors. The design system's prism colors are not used.
- Type: Instrument Serif for the wordmark, sheet and dialog titles, and quoted portal status; Inter Tight for body and controls; JetBrains Mono for permit numbers, timestamps, uppercase tracked labels, and buttons. The fonts are bundled latin subsets in `assets/fonts` (SIL OFL, see `LICENSES.txt`) because the CSP allows no remote fonts.
- Surfaces: parchment page; the add card and table card are bone with a 1px ink frame.
- Shape and depth: flat. Radius is 0 except the 2px micro-radius on buttons; the orb and dots are the only circles. Depth comes from 1px ink hairlines and 2px ink rules, not shadows. Focus is a two-stop ink ring.
- Controls: inputs and selects are bottom-rule only with mono labels above; the rule thickens to 2px ink on focus. Selects use Chromium's customizable select (`appearance: base-select`), so the open picker is a bone panel with a 1px ink frame, soft hairlines between 40px options, a hover wash, and an ink check on the chosen option, while keeping native keyboard and screen-reader behavior. Time fields hide the OS picker (it can't take the styling); times are typed or stepped with the arrow keys. Checkboxes are 14px hairline squares that fill with ink.
- Icons: Lucide at 1.5px stroke, inlined as an SVG sprite in `index.html` (ISC license noted there), colored with `currentColor` only.
- Motion is limited to state changes: sheets slide in, pickers fade down, new rows wash in bone, and running checks pulse ember. Reduced-motion users get a simple fade and no pulses.
- App icon: an Instrument Serif "P" over a short rule, bone on an ink tile with the 2px micro-radius, so it reads as part of the masthead. In the nav it matches the wordmark's cap height and sits on its baseline. `assets/icon.svg` is the source for `icon.png` (256px; window title bar and notifications) and the 40–256px frames of `icon.ico` (installer, exe, and taskbar). `assets/tray.svg` is a small-size cut with a heavier P and a pixel-snapped rule; it renders the 16–32px `icon.ico` frames and the 16/32px tray images. `assets/tray-attention.svg` adds the ember dot shown while a check has failed.

Portal content and the API key never render in the app window. Keep each jurisdiction's coverage and access limits visible before a permit is saved.
