import assert from "node:assert/strict";
import test from "node:test";
import { loadModule, readSource } from "../scripts/benchmark-discover.mjs";

test("Back to Top checks a final scroll event inside its throttle window", () => {
  const timers = new Map();
  const frames = new Map();
  const listeners = new Map();
  let now = 0;
  let nextId = 0;
  let shown = false;
  let cleanup;
  const scroller = {
    scrollTop: 0,
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event),
  };
  const { BackToTop } = loadModule(
    readSource("src/components/back-to-top.tsx"),
    {
      react: {
        useEffect: (effect) => {
          cleanup = effect();
        },
        useState: (initial) => [
          initial,
          (value) => {
            shown = value;
          },
        ],
      },
      "react/jsx-runtime": { jsx: () => null },
      "lucide-react": { ArrowUp: () => null },
      "@/lib/i18n": { useT: () => (label) => label },
    },
    {
      performance: { now: () => now },
      window: {
        setTimeout: (task) => (timers.set(++nextId, task), nextId),
        clearTimeout: (id) => timers.delete(id),
      },
      requestAnimationFrame: (task) => (frames.set(++nextId, task), nextId),
      cancelAnimationFrame: (id) => frames.delete(id),
    },
  );
  const flush = (queue) => {
    const pending = Array.from(queue.values());
    queue.clear();
    pending.forEach((run) => run());
  };
  BackToTop({ scrollRef: { current: scroller } });
  now = 40;
  scroller.scrollTop = 900;
  listeners.get("scroll")();
  assert.equal(shown, false);
  now = 100;
  flush(timers);
  flush(frames);
  assert.equal(shown, true);

  now = 130;
  scroller.scrollTop = 0;
  listeners.get("scroll")();
  now = 200;
  flush(timers);
  flush(frames);
  assert.equal(shown, false);

  now = 225;
  listeners.get("scroll")();
  cleanup();
  assert.equal(timers.size + frames.size + listeners.size, 0);
});

test("scroll memory saves the outgoing anchor before navigation parks the layer", () => {
  const source = readSource("src/lib/view.tsx");
  const start = source.indexOf("function anchorOffsetIn(");
  const end = source.indexOf("\n}", source.indexOf("}, [active, key, ref, rememberScroll", start));
  assert.ok(start >= 0 && end > start);
  const listeners = new Map();
  const timers = new Map();
  const savers = new Set();
  const snapshots = new Map();
  let parked = false;
  let reads = 0;
  let cleanup;
  let position = 0;
  let nextId = 0;
  const anchor = {
    dataset: { scrollAnchor: "row-3" },
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: 1000 - position, height: 300 }),
  };
  const scroller = {
    get scrollTop() {
      reads++;
      return position;
    },
    set scrollTop(value) {
      position = value;
    },
    get clientHeight() {
      return parked ? 0 : 800;
    },
    scrollHeight: 6000,
    closest: () => (parked ? {} : null),
    querySelectorAll: () => [anchor],
    querySelector: () => anchor,
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event),
  };
  const { useScrollMemory } = loadModule(
    source.slice(start, end + 2),
    {},
    {
      useView: () => ({
        rememberScroll: (key, snapshot) => snapshots.set(key, snapshot),
        recallScroll: (key) => snapshots.get(key),
        registerScrollSave: (save) => {
          savers.add(save);
          return () => savers.delete(save);
        },
      }),
      useSettings: () => ({ settings: { smoothScroll: false } }),
      useSmoothWheel: () => {},
      useEffect: () => {},
      useLayoutEffect: (effect) => {
        cleanup = effect();
      },
      noteScrollActivity: () => {},
      performance: { now: () => 10 },
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      CSS: { escape: (value) => value },
      window: { setTimeout: (task) => (timers.set(++nextId, task), nextId) },
      clearTimeout: (id) => timers.delete(id),
    },
  );
  const ref = { current: scroller };
  useScrollMemory("discover", ref);
  position = 700;
  listeners.get("scroll")();
  position = 1200;
  listeners.get("scroll")();
  assert.equal(reads, 0);

  for (const save of savers) save();
  parked = true;
  cleanup();
  assert.deepEqual(snapshots.get("discover"), { anchor: "row-3", delta: 200, fallback: 1200 });
  assert.equal(savers.size, 0);
  assert.equal(timers.size, 0);

  parked = false;
  position = 0;
  useScrollMemory("discover", ref);
  assert.equal(position, 1200);
  cleanup();
});
