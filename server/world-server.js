/**
 * world-server.js
 * Server-side world geometry: seeded PRNG + collision math.
 * No Three.js — pure number arithmetic so it can run in Node.
 * Must stay in sync with src/world.js (same ARENA_HALF, same maze walls,
 * same obstacle scatter algorithm, same collider shapes).
 */

'use strict';

const ARENA_HALF = 25;

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32
// Converts a string seed (room code) into a deterministic float sequence.
// ---------------------------------------------------------------------------
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function makePRNG(seed) {
  let s = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return function () {
    s |= 0; s = s + 0x6d2b79f5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fixed maze walls — must match buildInnerMazes() in src/world.js exactly.
// Each entry: { cx, cz, hw, hd } (half-widths)
// ---------------------------------------------------------------------------
const MAZE_WALLS = [
  { cx: 10,  cz: 10,  hw: 6,   hd: 0.5 },
  { cx: -10, cz: 10,  hw: 6,   hd: 0.5 },
  { cx: 10,  cz: -10, hw: 0.5, hd: 6   },
  { cx: -10, cz: -10, hw: 0.5, hd: 6   },
  { cx: 0,   cz: 15,  hw: 4,   hd: 0.5 },
  { cx: 0,   cz: -15, hw: 4,   hd: 0.5 },
];

// ---------------------------------------------------------------------------
// Build the full collider list for a room (called once on game start).
// Returns an array of collider objects understood by checkCollision().
// ---------------------------------------------------------------------------
function buildColliders(seed) {
  const rng = makePRNG(seed);
  const colliders = [];

  // Arena boundary (handled separately in checkCollision, not as explicit objects)

  // Maze walls
  for (const w of MAZE_WALLS) {
    colliders.push({ type: 'box', cx: w.cx, cz: w.cz, hw: w.hw, hd: w.hd });
  }

  // Scattered obstacles (90 attempts, same as world.js scatterObstacles count)
  const OBSTACLE_COUNT = 90;
  const placed = [];
  const MIN_DIST_SQ = 3.5 * 3.5;

  for (let i = 0; i < OBSTACLE_COUNT; i++) {
    let x, z, rotY, scaleJitter, valid = false;

    for (let attempts = 0; attempts < 30; attempts++) {
      x = (rng() - 0.5) * 44;
      z = (rng() - 0.5) * 44;
      rotY = rng() * Math.PI * 2;   // consumed but not used server-side
      scaleJitter = 0.85 + rng() * 0.4;

      if (Math.abs(x) < 5 && Math.abs(z) < 5) continue;

      valid = true;
      for (const p of placed) {
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < MIN_DIST_SQ) {
          valid = false;
          break;
        }
      }
      if (valid) break;
    }

    if (!valid) continue;
    placed.push({ x, z });

    // Tighter radius (0.25) so players can slip between trees without getting stuck
    colliders.push({ type: 'sphere', cx: x, cz: z, r: 0.25 * scaleJitter });
  }

  return colliders;
}

// ---------------------------------------------------------------------------
// Collision check — returns true if a circle at (x, z) with given radius
// overlaps any collider or the arena boundary.
// ---------------------------------------------------------------------------
function checkCollision(x, z, radius, colliders) {
  // Arena bounds
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

// ---------------------------------------------------------------------------
// Move helper — applies a (dx, dz) step with wall-sliding.
// Returns the new { x, z } after collision resolution.
// ---------------------------------------------------------------------------
function applyMove(x, z, dx, dz, radius, colliders) {
  const nx = x + dx;
  const nz = z + dz;

  if (!checkCollision(nx, nz, radius, colliders)) {
    return { x: nx, z: nz };
  }
  // Slide along X
  if (!checkCollision(nx, z, radius, colliders)) {
    return { x: nx, z };
  }
  // Slide along Z
  if (!checkCollision(x, nz, radius, colliders)) {
    return { x, z: nz };
  }
  // Fully blocked
  return { x, z };
}

// ---------------------------------------------------------------------------
// Safe-zone check (for future use)
// ---------------------------------------------------------------------------
function isInSafeZone(x, z) {
  const sx = 0, sz = -15, sr = 3;
  const dx = x - sx, dz = z - sz;
  return dx * dx + dz * dz < sr * sr;
}

module.exports = { buildColliders, checkCollision, applyMove, isInSafeZone, makePRNG, ARENA_HALF };
