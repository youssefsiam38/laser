/**
 * The one measurement a headless DOM cannot give the transcript.
 *
 * The transcript is a `@legendapp/list` (D-306) and the list mounts rows only
 * once its scroller has been laid out: a scroller with no box is a surface
 * nobody can read, and it renders nothing rather than guessing. happy-dom
 * lays nothing out, so every suite that renders the real thread and then
 * looks for a message needs the scroller to have a size.
 *
 * This gives exactly that and nothing else: the element the transcript marks
 * as its viewport reports one window-sized box. Every other element keeps the
 * empty box happy-dom gives it, so no test learns a geometry it did not ask
 * for, and a suite that brings its own layout engine (`test/thread/virtual-rig.tsx`)
 * replaces this wholesale.
 */
const VIEWPORT = "thread-viewport";
const HEIGHT = 900;
const WIDTH = 800;

// Suites that run in node have no DOM at all, and nothing to give a box to.
if (typeof Element !== "undefined") install();

function install() {
const original = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function boundingClientRect(this: Element): DOMRect {
  if (this instanceof HTMLElement && this.dataset["slot"] === VIEWPORT && !Object.hasOwn(this, "clientHeight")) {
    return new DOMRect(0, 0, WIDTH, HEIGHT);
  }
  return original.call(this);
};

for (const [name, value] of [["clientHeight", HEIGHT], ["clientWidth", WIDTH]] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
  Object.defineProperty(Element.prototype, name, {
    configurable: true,
    get(this: Element) {
      if (this instanceof HTMLElement && this.dataset["slot"] === VIEWPORT) return value;
      return descriptor?.get?.call(this) ?? 0;
    },
  });
}
}
