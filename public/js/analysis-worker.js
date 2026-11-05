// Runs the expensive segmentation off the main thread so the page stays responsive.
import { segmentAndMeasure } from './analysis.js';

self.onmessage = (event) => {
  const { id, width, height, buffer, options } = event.data;
  try {
    const data = new Uint8ClampedArray(buffer);
    const result = segmentAndMeasure({ data, width, height }, options || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
