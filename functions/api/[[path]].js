// Cloudflare Pages Functions entry: lets the same /api code run on a Pages project.
// (On a Workers project, src/worker.js is used directly and this folder is ignored.)
import worker from '../../src/worker.js';

export const onRequest = (context) => worker.fetch(context.request, context.env);
