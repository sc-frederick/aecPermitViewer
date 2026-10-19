export function element(id: string): HTMLElement;

export function element<T extends Element>(id: string, type: new () => T): T;

export function element(id: string, type: new () => Element = HTMLElement): Element {
  const node = document.getElementById(id);

  if (!(node instanceof type)) throw new Error(`Missing interface element: ${id} (${type.name})`);

  return node;
}

export function eventButton(event: Event, selector: string): HTMLButtonElement | null {
  const button = event.target instanceof Element ? event.target.closest(selector) : null;

  return button instanceof HTMLButtonElement ? button : null;
}

export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (className) node.className = className;

  if (text !== undefined) node.textContent = text;

  return node;
}

export function icon(name: string, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);

  return svg;
}

export async function busy<T>(control: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
  control.disabled = true;
  control.setAttribute("aria-busy", "true");

  try {
    return await work();
  } finally {
    control.disabled = false;
    control.removeAttribute("aria-busy");
  }
}

export function setInlineError(input: HTMLInputElement, error: HTMLElement, message: string | null): void {
  error.hidden = !message;
  error.textContent = message ?? "";

  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}
