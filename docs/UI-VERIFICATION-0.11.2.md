# Publication follow-up — 0.11.2

This release contains the warm Aether interface and fullscreen polish verified
in [0.11.1](UI-VERIFICATION-0.11.1.md). Renderer styling and application behavior
are identical; the package version and CI execution order are the follow-up.
The source includes the current proprietary project license alongside third-party
notices.

Two Mac runs of the parallel 378-test suite hit the existing history benchmark's
100 ms latency limit; the other 377 tests passed. The standalone local benchmark
passed with maximum event-loop delays of 28 and 20 ms while materializing exactly
9,000 observations from 82,125 and 246,375 stored observations.

Windows and Mac package jobs now run the 377-test parallel suite followed by the
unchanged history benchmark in its own process. No latency threshold, assertion,
runtime history implementation or publication gate was relaxed. Signed update
manifest publication still waits for both packaged-browser smoke checks and the
publication regression suite.

The 0.11.1 tag was left intact after its failed build, and the live feed stayed on
0.10.1. The matching annotated 0.11.2 tag starts the existing release process.
