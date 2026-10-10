import type { CollisionWorld } from './collision';
import type { Vec3 } from './vec';

/**
 * Player movement modelled on the GoldSrc/Quake "pmove" code that gives
 * classic tactical shooters their feel: ground friction with a stop-speed
 * floor, acceleration toward a wish velocity, and very limited air control
 * (air wish speed is capped, so strafing in the air curves rather than
 * steers). Units are metres; constants are the classic Hammer-unit values
 * converted at 1 unit = 0.0254 m.
 */
const U = 0.0254;

/**
 * Game pace: every ground speed is the classic value times this. At the
 * original 1:1 speeds the owner found the game too fast and moving targets
 * too hard to hit (2026-10 playtest feedback), so everything runs at 80%:
 * 5.1 m/s running instead of 6.35. Weapon speed ratios are unchanged.
 */
export const PACE = 0.8;

export const PHYS = {
  gravity: 800 * U,
  jumpSpeed: Math.sqrt(2 * 800 * 45) * U, // reaches a 45-unit jump apex
  friction: 4,
  stopSpeed: 100 * U,
  accelerate: 5,
  airAccelerate: 10,
  airWishCap: 30 * U,
  maxSpeed: 250 * U * PACE,
  /** Ledges up to this height are climbed by walking (classic 18 units). */
  stepHeight: 18 * U,
  walkScale: 0.52,
  crouchScale: 0.34,
  halfWidth: 16 * U,
  standHeight: 72 * U,
  crouchHeight: 46 * U,
  standEye: 64 * U,
  crouchEye: 38 * U,
  /** Velocity cap so a bad frame can never launch anyone through the map. */
  maxVelocity: 2000 * U,
} as const;

const LAND_SLOW_EPS = 1e-3;

export interface MoveInput {
  forward: number; // -1..1
  side: number; // -1..1 (positive = right)
  jump: boolean;
  crouch: boolean;
  walk: boolean;
  yaw: number;
}

export interface MoveBody {
  pos: Vec3; // feet centre
  vel: Vec3;
  onGround: boolean;
  crouched: boolean;
  jumpHeld: boolean;
  /** Seconds a landing slows the player (CS-style landing penalty). */
  landSlow: number;
}

export function makeBody(pos: Vec3): MoveBody {
  return { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, onGround: false, crouched: false, jumpHeld: false, landSlow: 0 };
}

export const bodyHeight = (b: MoveBody): number => (b.crouched ? PHYS.crouchHeight : PHYS.standHeight);
export const eyeHeight = (b: MoveBody): number => (b.crouched ? PHYS.crouchEye : PHYS.standEye);

function applyFriction(b: MoveBody, dt: number): void {
  const speed = Math.hypot(b.vel.x, b.vel.z);
  if (speed < 1e-4) {
    b.vel.x = 0;
    b.vel.z = 0;
    return;
  }
  const control = speed < PHYS.stopSpeed ? PHYS.stopSpeed : speed;
  const drop = control * PHYS.friction * dt;
  const ns = Math.max(speed - drop, 0) / speed;
  b.vel.x *= ns;
  b.vel.z *= ns;
}

function accelerate(b: MoveBody, wx: number, wz: number, wishSpeed: number, accel: number, cap: number, dt: number): void {
  const capped = Math.min(wishSpeed, cap);
  const current = b.vel.x * wx + b.vel.z * wz;
  const add = capped - current;
  if (add <= 0) return;
  const accelSpeed = Math.min(accel * dt * wishSpeed, add);
  b.vel.x += accelSpeed * wx;
  b.vel.z += accelSpeed * wz;
}

/**
 * Advances one fixed simulation step. `maxSpeed` is the carried weapon's speed
 * limit. Returns true on the tick the body lands (for footstep/land audio).
 */
export function stepMovement(world: CollisionWorld, b: MoveBody, input: MoveInput, maxSpeed: number, dt: number): { landed: boolean; jumped: boolean } {
  let jumped = false;

  // Crouch / uncrouch (uncrouching needs headroom).
  if (input.crouch && !b.crouched) {
    b.crouched = true;
  } else if (!input.crouch && b.crouched) {
    if (!world.hullBlocked(b.pos, PHYS.halfWidth, PHYS.standHeight)) b.crouched = false;
  }

  // Wish direction from view yaw (yaw 0 faces -Z, see vec.dirFromAngles).
  const fx = -Math.sin(input.yaw);
  const fz = -Math.cos(input.yaw);
  const rx = Math.cos(input.yaw);
  const rz = -Math.sin(input.yaw);
  let wx = fx * input.forward + rx * input.side;
  let wz = fz * input.forward + rz * input.side;
  const wl = Math.hypot(wx, wz);
  let wishSpeed = 0;
  if (wl > 1e-6) {
    wx /= wl;
    wz /= wl;
    wishSpeed = maxSpeed * Math.min(wl, 1);
    if (b.crouched) wishSpeed *= PHYS.crouchScale;
    else if (input.walk) wishSpeed *= PHYS.walkScale;
    if (b.landSlow > LAND_SLOW_EPS) wishSpeed *= 0.7;
  }
  // Snapshots round landSlow to 1 ms, so anything under that counts as over;
  // otherwise client and server can disagree by one tick about when it ends.
  b.landSlow = b.landSlow - dt > LAND_SLOW_EPS ? b.landSlow - dt : 0;

  if (b.onGround) {
    if (input.jump && !b.jumpHeld) {
      b.vel.y = PHYS.jumpSpeed;
      b.onGround = false;
      jumped = true;
    }
  }
  b.jumpHeld = input.jump;

  if (b.onGround) {
    applyFriction(b, dt);
    accelerate(b, wx, wz, wishSpeed, PHYS.accelerate, Infinity, dt);
  } else {
    accelerate(b, wx, wz, wishSpeed, PHYS.airAccelerate, PHYS.airWishCap, dt);
  }

  // Gravity (half before, half after the move — standard symmetric integration).
  b.vel.y -= PHYS.gravity * dt * 0.5;
  const hs = Math.hypot(b.vel.x, b.vel.z);
  if (hs > PHYS.maxVelocity) {
    b.vel.x *= PHYS.maxVelocity / hs;
    b.vel.z *= PHYS.maxVelocity / hs;
  }

  const wasAirborne = !b.onGround;
  const fallSpeed = -b.vel.y;
  const start = { ...b.pos };
  const delta = { x: b.vel.x * dt, y: b.vel.y * dt, z: b.vel.z * dt };
  let res = world.moveHull(b.pos, PHYS.halfWidth, bodyHeight(b), delta);

  // Step up (as in the classic StepSlideMove): if a grounded, non-jumping
  // move was blocked, retry it lifted by the step height and then set back
  // down. Keep whichever attempt got further. This is what lets players walk
  // up stairs and onto low ledges without jumping.
  if (res.hitWall && !wasAirborne && !jumped) {
    const p2 = { ...start };
    world.moveHull(p2, PHYS.halfWidth, bodyHeight(b), { x: 0, y: PHYS.stepHeight, z: 0 });
    const lifted = p2.y - start.y;
    if (lifted > 0.01) {
      const side = world.moveHull(p2, PHYS.halfWidth, bodyHeight(b), { x: delta.x, y: 0, z: delta.z });
      const down = world.moveHull(p2, PHYS.halfWidth, bodyHeight(b), { x: 0, y: -(lifted + 0.05), z: 0 });
      const stepped = Math.hypot(p2.x - start.x, p2.z - start.z);
      const plain = Math.hypot(b.pos.x - start.x, b.pos.z - start.z);
      if (down.onGround && stepped > plain + 1e-6) {
        b.pos.x = p2.x;
        b.pos.y = p2.y;
        b.pos.z = p2.z;
        res = { onGround: true, hitWall: side.hitWall, hitCeiling: false };
      }
    }
  }
  // Stay on the ground going down stairs or small ledges (as Source's
  // StayOnGround): without this a player walking down steps is airborne for
  // a few ticks per step, which costs air accuracy and skips footsteps.
  if (!res.onGround && !wasAirborne && !jumped && b.vel.y <= 0) {
    const p3 = { ...b.pos };
    const down = world.moveHull(p3, PHYS.halfWidth, bodyHeight(b), { x: 0, y: -PHYS.stepHeight, z: 0 });
    if (down.onGround) {
      b.pos.y = p3.y;
      res = { ...res, onGround: true };
    }
  }
  b.vel.y -= PHYS.gravity * dt * 0.5;

  if (res.onGround) {
    b.vel.y = 0;
    b.onGround = true;
  } else {
    b.onGround = false;
  }
  if (res.hitCeiling && b.vel.y > 0) b.vel.y = 0;

  // Kill velocity into walls so the player slides along them instead of
  // "sticking" with stored speed.
  if (res.hitWall) {
    const probe = { ...b.pos };
    const blockedX = world.hullBlocked({ x: probe.x + Math.sign(b.vel.x) * 0.01, y: probe.y + 0.01, z: probe.z }, PHYS.halfWidth, bodyHeight(b) - 0.02);
    const blockedZ = world.hullBlocked({ x: probe.x, y: probe.y + 0.01, z: probe.z + Math.sign(b.vel.z) * 0.01 }, PHYS.halfWidth, bodyHeight(b) - 0.02);
    if (blockedX) b.vel.x = 0;
    if (blockedZ) b.vel.z = 0;
  }

  const landed = wasAirborne && b.onGround;
  if (landed && fallSpeed > 5) b.landSlow = 0.25;
  return { landed, jumped };
}
