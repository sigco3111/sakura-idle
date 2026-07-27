import { WIND } from '../lib/wind.js';

/**
 * Ticks the single global wind field, once, before anything samples it.
 * Scaffold-owned — do not edit. Read src/lib/wind.js for the API.
 */
export default {
  name: 'wind',
  order: 1,
  async setup(ctx) {
    WIND.update(0, 0);
    ctx.wind = WIND;
    return { update(dt, time) { WIND.update(dt, time); } };
  },
};
