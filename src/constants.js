/**
 * constants.js — Single source of truth for physics/gameplay constants.
 *
 * Imported by:
 *   - src/predict.js       (client-side prediction)
 *   - src/player.js        (local player updateLocal)
 *   - src/world.js         (collider radii)
 *   - server/index.js      (game loop)
 *   - server/world-server.js (collision math)
 *
 * Dual-module: works as both ES module (import) and CJS (require).
 */

export const PLAYER_RADIUS      = 0.5;
export const BASE_SPEED_SURV    = 5.0;
export const BASE_SPEED_ZOMBIE  = 5.5;
export const POWERUP_SPEED_MULT = 1.5;
export const TICK_MS            = 50;    // 20 Hz
export const ARENA_HALF         = 25;
