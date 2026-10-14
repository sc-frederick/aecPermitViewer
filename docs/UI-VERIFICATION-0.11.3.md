# Shared publication responsiveness — 0.11.3

The warm Aether interface and fullscreen polish are unchanged from the
[0.11.1 verification](UI-VERIFICATION-0.11.1.md).

The isolated Mac history benchmark still measured a 117 ms event-loop turn,
including a 96 ms history read. Shared-list publication now yields between each
retained-history read and preparation of its JSON entry so those costs do not
accumulate in one turn. It retains the same 120-day window, exact wire bytes,
encryption, scheduling and store-revision check that rebuilds a list if data
changes while yielding. Daily reads also reuse the newest verified successful
run instead of querying and parsing it a second time. Failed checks and success
rows without observations retain the indexed fallback. Regression tests cover
those cases and equal timestamps against the existing daily-history selection.
The database schema and sharing protocol are unchanged.

The existing 100 ms read/turn limits remain intact, and CI runs the benchmark
separately from parallel browser/SQLite tests. A regression compares asynchronous
and synchronous wire bytes for empty/populated lists, manual/scheduled checks and
history with outstanding/approved reviews. Existing end-to-end tests verify
encrypted follower updates and fresh publication after a store mutation.

The failed 0.11.1 and 0.11.2 tags remain intact. A manual Windows/Mac package run
checks this candidate before its matching annotated release tag is published.
