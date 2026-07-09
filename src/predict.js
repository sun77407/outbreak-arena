/**
 * predict.js — Client-side movement prediction mirror of server/world-server.js.
 *
 * CRITICAL: The math here must stay bit-for-bit identical to world-server.js.
 * Any divergence causes prediction drift ? reconciliation fires every tick.
 *
 * Uses flat collider format: { type:'sphere'|'box', cx, cz, r, hw, hd }
 * NOT Three.js Vector3 objects — so this module has zero Three.js dependency.
 *
 * The flatColliders[] array is built by src/world.js alongside its Three.js
 * colliders[], so both share the same seeded-PRNG scatter sequence.
 */

import { PLAYER_RADIUS, ARENA_HALF } from './constants.js';

/**
 * Check if a circle at (x, z) with given radius overlaps any collider or the
 * arena boundary. Returns true if blocked.
 * Identical algorithm to world-server.js checkCollision().
 */
export function checkCollisionFlat(x, z, radius, colliders) {
  // Arena bounds (1-unit inset so player cannot stand on the very edge)
  if (x < -(ARENA_HALF - 1) || x > (ARENA_HALF - 1) ||
      z < -(ARENA_HALF - 1) || z > (ARENA_HALF - 1)) {
    return true;
  }

  for (const c of colliders) {
    if (c.type === 'sphere') {
      const dx = x - c.cx;
      const dz = z - c.cz;
      if (dx * dx + dz * dz < (radius + c.r) * (radius + c.r)) return true;
    } else if (c.type === 'box') {
      const dx = Math.abs(x - c.cx);
      const dz = Math.abs(z - c.cz);
      if (dx < c.hw + radius && dz < c.hd + radius) return true;
    }
  }
  return false;
}

/**
 * Apply a (dx, dz) movement step with wall-sliding.
 * Returns the new { x, z } position after collision resolution.
 * Identical algorithm to world-server.js applyMove().
 *
 * @param {number} x            current X
 * @param {number} z            current Z
 * @param {number} dx           desired X delta this tick
 * @param {number} dz           desired Z delta this tick
 * @param {number} radius       player collision radius (use PLAYER_RADIUS)
 * @param {Array}  colliders    flatColliders[] from world.js
 * @returns {{ x: number, z: number }}
 */
export function applyMoveFlat(x, z, dx, dz, radius, colliders) {
  const nx = x + dx;
  const nz = z + dz;

  // Attempt full move
  if (!checkCollisionFlat(nx, nz, radius, colliders)) {
    return { x: nx, z: nz };
  }
  // Slide along X axis
  if (!checkCollisionFlat(nx, z, radius, colliders)) {
    return { x: nx, z };
  }
  // Slide along Z axis
  if (!checkCollisionFlat(x, nz, radius, colliders)) {
    return { x, z: nz };
  }
  // Fully blocked
  return { x, z };
}

/**
 * Run one prediction tick for the local player.
 * Mirrors gameTick() movement section in server/index.js exactly.
 *
 * @param {number} x
 * @param {number} z
 * @param {{ x: number, y: number }} move   normalised direction from input (-1..1)
 * @param {number} speed                     current player speed (units/sec)
 * @param {number} dt                        tick duration in seconds (TICK_MS/1000)
 * @param {Array}  flatColliders
 * @returns {{ x: number, z: number, rotY: number }}
 */
export function predictTick(x, z, move, speed, dt, flatColliders) {
  const { x: mx, y: my } = move;
  if (mx === 0 && my === 0) return { x, z, rotY: null };

  const len = Math.sqrt(mx * mx + my * my);
  const nx = mx / len;
  const ny = my / len;
  const dx = nx * speed * dt;
  const dz = ny * speed * dt;
  const moved = applyMoveFlat(x, z, dx, dz, PLAYER_RADIUS, flatColliders);
  return { x: moved.x, z: moved.z, rotY: Math.atan2(nx, ny) };
}
