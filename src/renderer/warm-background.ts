import type { GpuFailureReason, shaderRendererGPU } from "shaders/core";

const REDUCED_EFFECTS =
  "(prefers-reduced-motion: reduce), (prefers-reduced-transparency: reduce), (forced-colors: active)";

type FallbackReason = GpuFailureReason | "reduced-effects" | "timeout";

function startBackground(host: HTMLElement, canvas: HTMLCanvasElement): () => void {
  let renderer: ReturnType<typeof shaderRendererGPU> | null = null;
  let observer: ResizeObserver | null = null;
  let stopped = false;
  let frame: number | null = null;
  let painting = false;
  let dirty = true;
  let dimensions = "";
  let paints = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  function stop(): void {
    stopped = true;
    observer?.disconnect();
    observer = null;

    if (timeout !== null) clearTimeout(timeout);

    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    renderer?.setOnUnavailable(null);
    renderer?.cleanup();
    renderer = null;
    canvas.width = 1;
    canvas.height = 1;
    window.removeEventListener("resize", schedulePaint);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  function fallback(reason: FallbackReason): void {
    if (stopped) return;
    host.dataset.background = "fallback";
    host.dataset.fallback = reason;
    stop();
  }

  async function paint(): Promise<void> {
    if (stopped || !renderer || document.hidden || painting) return;
    const current = renderer;
    const rect = canvas.getBoundingClientRect();
    const size = `${rect.width}:${rect.height}:${window.devicePixelRatio}`;

    if (size === dimensions && !dirty) return;
    painting = true;
    dirty = false;

    try {
      current.setResolutionScale(1 / Math.max(1, window.devicePixelRatio));
      current.resize(Math.round(rect.width), Math.round(rect.height));
      await current.renderSyntheticFrame(0);

      if (stopped || current.getFailureReason()) return;
      dimensions = size;
      canvas.dataset.paints = String(++paints);

      if (timeout !== null) clearTimeout(timeout);
      host.dataset.background = "shader";
      delete host.dataset.fallback;
    } catch {
      fallback("render-failed");
    } finally {
      painting = false;

      if (dirty && !stopped) schedulePaint();
    }
  }

  function schedulePaint(): void {
    if (stopped || frame !== null) return;
    dirty = true;
    frame = requestAnimationFrame(() => {
      frame = null;
      void paint();
    });
  }

  function onVisibility(): void {
    if (!document.hidden && dirty) schedulePaint();
  }

  async function initialize(): Promise<void> {
    if (!("gpu" in navigator)) {
      fallback("unsupported");

      return;
    }

    host.dataset.background = "loading";
    timeout = setTimeout(() => fallback("timeout"), 10_000);

    try {
      const adapter = await navigator.gpu.requestAdapter();

      if (stopped) return;

      if (!adapter) {
        fallback("no-adapter");

        return;
      }

      const [core, gradient, grain] = await Promise.all([
        import("shaders/core"),
        import("shaders/core/MultiPointGradient"),
        import("shaders/core/FilmGrain"),
      ]);

      if (stopped) return;
      const current = core.shaderRendererGPU();
      renderer = current;
      current.setOnUnavailable(fallback);
      current.setFrameLocked(true);
      await current.initialize({ canvas, gpu: { adapter }, observeElement: false, colorSpace: "srgb" });

      if (stopped) {
        current.cleanup();

        return;
      }

      if (current.getFailureReason()) return;
      current.registerNode("warm-root", core.rootPassthrough.fragment, null, null, {}, core.rootPassthrough);

      const grainProps = {
        strength: 0.025,
        bias: 0,
        animated: false,
      } satisfies import("shaders/core/FilmGrain").ComponentProps;

      // SAFETY: the SDK's bridge type erases shader-specific transform inputs to unknown. The
      // definition is passed unchanged and only receives grainProps, checked against its props.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      const grainBridge = grain.componentDefinition as unknown as Parameters<typeof core.createGpuUniformsMap>[0];
      current.registerNode(
        "warm-grain",
        grain.componentDefinition.fragment,
        "warm-root",
        null,
        core.createGpuUniformsMap(grainBridge, grainProps, "warm-grain"),
        grain.componentDefinition,
      );

      const gradientProps = {
        colorA: "#f3bd92",
        positionA: { x: 0.12, y: 0.02 },
        colorB: "#f9deac",
        positionB: { x: 0.94, y: 0.08 },
        colorC: "#f7f2ec",
        positionC: { x: 0.12, y: 0.92 },
        colorD: "#f1d0ad",
        positionD: { x: 0.86, y: 0.96 },
        colorE: "#f7f3ee",
        positionE: { x: 0.5, y: 0.52 },
        smoothness: 1.8,
        colorSpace: "oklab",
      } satisfies import("shaders/core/MultiPointGradient").ComponentProps;

      // SAFETY: same SDK variance mismatch as above. gradientProps is checked against the
      // gradient's props, and the definition is passed unchanged.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      const gradientBridge = gradient.componentDefinition as unknown as Parameters<typeof core.createGpuUniformsMap>[0];
      current.registerNode(
        "warm-field",
        gradient.componentDefinition.fragment,
        "warm-grain",
        null,
        core.createGpuUniformsMap(gradientBridge, gradientProps, "warm-field"),
        gradient.componentDefinition,
      );
      await paint();

      if (stopped) return;
      observer = new ResizeObserver(() => {
        const rect = canvas.getBoundingClientRect();

        if (`${rect.width}:${rect.height}:${window.devicePixelRatio}` !== dimensions) schedulePaint();
      });
      observer.observe(canvas);
    } catch {
      fallback("init-failed");
    }
  }

  window.addEventListener("resize", schedulePaint);
  document.addEventListener("visibilitychange", onVisibility);
  void initialize();

  return stop;
}

/**
 * Mounts the warm backdrop, or the CSS fallback while a reduced-effects preference is on, and restarts when that
 * preference changes. The returned function releases GPU resources.
 */
export function mountWarmBackground(host: HTMLElement, canvas: HTMLCanvasElement): () => void {
  const preference = window.matchMedia(REDUCED_EFFECTS);
  let stop: () => void = () => undefined;

  function refresh(): void {
    stop();

    if (preference.matches) {
      host.dataset.background = "fallback";
      host.dataset.fallback = "reduced-effects";
    } else {
      stop = startBackground(host, canvas);
    }
  }

  preference.addEventListener("change", refresh);
  refresh();

  return () => {
    preference.removeEventListener("change", refresh);
    stop();
  };
}
