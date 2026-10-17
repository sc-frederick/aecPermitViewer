# Interface notes

The first user is a permit professional reviewing several saved public records. The surface is an Operate tool in the warm Aether system shared with AEC Plan Search. It is one page with an add-permit card and a "Permits" card holding a table. Details and Settings open in a right-side sheet so the list stays in view.

## Truthfulness rules

- Portal status text appears exactly as the portal displayed it, in neutral styling. The status itself never gets a color or icon.
- The Action column is the one interpretation, and it sits beside the status: AEC when the applicant owes the next step, AHJ when the authority has it, and None when the record is issued, finished, or withdrawn. When in doubt it shows AEC?, and the badge's tooltip gives the reason. Water management district permits and permits without a verified status show a dash, never None. The wording lists are in [the status survey](PERMIT_STATUSES.md).
- Otherwise, color marks only the app's own check results in the "Last check" column and the history timeline: an ink dot for verified, oxide red `#a8331a` for a failed attempt, and a pulsing ember dot for a queued or running check. Cancelled and never-checked use neutral text.
- When the latest check failed, the row keeps the older verified status and its original time. The failure shows only in the Last check column.
- The Show filter uses facts the app recorded ("Failed", "No status yet") and the Action column ("AEC action" lists AEC and AEC?). A filter with nothing to show says "No matches.", never an all-clear.
- Record links are available only after a verified observation.

## Structure

- **Header:** the app icon and the "Permit Monitor" wordmark as the page heading, the time of the next scheduled check, and Settings. Copy is limited to labels and short messages. There are no headlines, stat readouts, section titles, subtitles, helper paragraphs, decorative imagery, or footer.
- **Key banner:** a hairline-framed banner with an ember left rule appears whenever the TypeSafe key is missing or key storage is unavailable.
- **Add a permit:** one card with an explicit issuing-jurisdiction select, the full permit number, "Add permit", and the Show filter with counts. The select groups "Counties and cities" and "Water management districts". The jurisdiction's coverage and access note appears before saving, and the number field's placeholder shows that authority's number format when it has one. Validation errors appear inline under the form.
- **Permits table:** Permit, Status, Action, Verified, Last check, and row actions: Check now or Cancel, and open the verified record. The permit number opens the details sheet. A "Not scheduled" tag marks permits excluded from scheduled checks. The empty state is one short line.
- **Action badges:** AEC has a 1px ember frame, an ember dot, semibold ink text, and a warm fill. Ink text rather than ember keeps small type above AA contrast. AEC? has the same dot with a dashed frame and medium-weight text. AHJ has a fog frame and a prism-cyan dot. None is plain graphite mono text.
- **Projects:** after a permit is added, a small dialog asks for the user's own project number, with Skip or Add. It is prefilled with the last number used and offers recent ones as chips. Once any permit has a project number, the table groups permits under soft warm band headers such as "Project 28069 · 3 permits", in natural order, with "No project" last. Each group is its own `tbody`.
- **Hand-checked authorities:** Check now opens the official search in the browser and a dialog asks for the status shown there, with an optional record link.
- **Details sheet:** current status, verification time, Action badge, Check now, Open record, the project number, the scheduled-check toggle with that permit's next check time, the Accela processing status with each process's latest entry, the full check history, and Remove permit. The project number saves on Enter or when the field loses focus. A blank value clears it.
- **Settings sheet:** the TypeSafe key, the schedule, background and notification switches, signed full-installer updates, the shared list, and local-data deletion. The key field is a password field that sends the key once for encryption, clears itself, and never shows the key again. The key can be replaced or removed. The schedule is Automatic or Manual only, with up to eight check times.
- **Shared list:** while off, Settings shows one line of copy, a Share this list button, and a code field with Follow. While sharing, the code sits in a read-only mono field with Copy, and Stop sharing is a ghost link. While following, Settings offers Stop following. A status line says when the list was last sent or received, or why the latest attempt failed.
- **Sync now:** whenever the app is sharing or following, a ghost button with the Lucide refresh icon sits in the header before Settings. It sends the list, or fetches the newest copy, immediately.
- **Following:** the window shows the followed list read-only. The add form, Check now and Cancel, the scheduled-check toggle, and Remove permit are hidden, the project number field is read-only, and the key banner stays hidden. The header shows "Shared list · updated …" or "Shared list · couldn't update" where the next check time would be. The Show filter, details, history, Action badges, and record links work as usual.
- **Confirmations:** removing a permit, deleting local data, installing an update, following a list over a non-empty list of one's own, stopping sharing, and stopping following all use an in-app confirm dialog.

## Background and notifications

- Closing the window hides it, and Permit Monitor keeps running from the notification area. The first time this happens, one notification explains where the app went. The tray menu offers Open, Check all permits now, a Scheduled checks toggle, and Quit. The tray icon gains an ember dot while any permit's latest check has failed.
- Desktop notifications fire only for facts the app recorded:
  - the first status for a new permit
  - a change in the portal's exact wording, quoting old and new, followed by "Action: AEC" or "Action: AEC?" when the new wording waits on the applicant
  - a new Accela review request
  - the first failure in a row
- Repeat failures and unchanged statuses stay quiet. When the window is in front, the same message shows as an in-app notice instead. Clicking a notification opens that permit's details sheet.
- A missing or unreadable key skips checks without recording failures and shows one notice, plus one for each Check now. A rejected key pauses scheduled checks until a new key is saved.
- Settings has five switches: keep running when closed, start at Windows sign-in, shortcut on the desktop, status-change notifications, and failure notifications. Start at sign-in and the desktop shortcut apply only to the installed Windows app. Start at sign-in is off by default.

## Visual system

The renderer uses the Aether design system shared with AEC Plan Search 0.3.3. The base system is `assets/aether/aether.css`. Product styling and warm overrides are in `src/renderer/styles.css`. The interface is light-only.

- **Color:** warm pearl `#f6f1eb` with peach `#f4c8a2`, amber `#f9dfb6`, and a pale orange lower glow. White-alpha glass surfaces, graphite `#1d1d1f`, slate `#54545a`, contained shadows, soft bevels, and hairlines. Ember and oxide mark only the app's recorded action and check states. Blue is the keyboard focus color.
- **Type:** locally bundled Inter for headings, controls, and text, and JetBrains Mono for permit identifiers and timestamps. Project names use Inter. Body text is 13 to 14px, metadata 11 to 12px, the wordmark 16px semibold, and sheet headings 22px. No serif, uppercase button lettering, or wide tracking.
- **Layout:** a floating command dock, and 20px rounded panels for the add form and the permit table. The table uses restrained rows rather than a card per record. Full review evidence and history live in the details sheet.
- **Controls:** buttons are 36px, dense table buttons 30px, and form inputs 40px. The primary Add button uses a 28px icon chip. Lucide icons inherit `currentColor` at a 1.75px stroke. Close buttons stay centered on hover.
- **Table:** it scrolls inside a padded rounded panel with a sticky column header and balanced column widths. The dock, form, and table share the same fluid gutters and grow with the window, with no desktop width cap. Timestamp columns stay readable. Followed lists use a compact horizontal filter and reserve only the record-button width. Project bands have quiet spacing, and rows share an opaque warm surface.
- **Minimum width:** at the 820px minimum window width, horizontal scrolling keeps every action reachable instead of squeezing columns. The header, add form, and filter stay in view. Both scrollbars use the same inset 8px track with no arrow buttons.
- **Selects:** native customizable selects keep grouped options, keyboard behavior, and accessibility. The top-layer picker has 16px rounded corners, bounded height, inset options, charcoal selection, and an 8px gap below the control. No parent clips the picker.
- **Sheets and dialogs:** Details and Settings are rounded 24px side sheets that scroll independently. Manual checks, project prompts, confirmations, notices, schedule rows, sharing controls, banners, errors, and disabled states use the same system.
- **Background:** a still amber backdrop from locally bundled Shaders 4.0.4, using MultiPointGradient with a non-animated FilmGrain. It probes WebGPU before loading the engine, caps resolution at one pixel per CSS pixel, and paints only at startup and on resize. There is no telemetry or idle animation. The CSS gradient underneath shows on devices without a GPU or when initialization fails. Reduced motion, reduced transparency, and forced colors turn the shader off, and preference changes apply while the window is open. The shader runs within the app's Content Security Policy.
- **Mark:** the FileCheck mark sits in a charcoal circle in the dock, application icon, tray, and installer. Bundled licenses are in `assets/aether` and `assets/fonts`.

Portal content and the API key never render in the app window.
