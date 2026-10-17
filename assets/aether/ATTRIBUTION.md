# Renderer attribution

The interface adapts the Aether design system by Uiverse Design (https://design.uiverse.io/).
Copyright © 2026 Uiverse. See LICENSE-aether-uiverse.md. The original design files are not
redistributed.

Inter and JetBrains Mono are self-hosted Latin subsets under the SIL Open Font License 1.1.
Their licenses are in assets/fonts. Lucide icons are used under the license in LICENSE-lucide.txt.

Shaders 4.0.4 (Shader Effects Inc., MIT) renders the window background with its
MultiPointGradient and FilmGrain effects on WebGPU. It draws one frame at startup and on
resize, with no animation loop, telemetry, or network requests. Unsupported GPUs, reduced
motion, reduced transparency, and forced colors fall back to a CSS background. Notices for
its dependencies TypeGPU 0.12.3, typed-binary, tinyest, and tsover-runtime (Apache 2.0) are
in this folder.
