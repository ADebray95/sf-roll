// engine.js is a classic script: its top-level classes and functions are
// globals, and it also publishes them on window for the other pages.
interface Window {
  Graph: typeof Graph;
  Geometry: typeof Geometry;
  Grid: typeof Grid;
  Bundle: typeof Bundle;
  inflate: typeof inflate;
  loadBundle: typeof loadBundle;
  MinHeap: typeof MinHeap;
}

// Caches Graph builds on first use; declared here so the class need not
// create them up front.
interface Graph {
  _corners?: Uint8Array;
  _rev?: ReverseAdjacency;
  _arcLookup?: Map<number, number>;
}
