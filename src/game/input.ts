import type { PlayerCmd } from '../shared/sim';
import type { WeaponSlot } from '../shared/weapons';

/**
 * Keyboard + mouse input. Mouse look only applies while the pointer is
 * locked to the game canvas. Discrete actions (weapon slot, reload, menus)
 * are queued so a quick tap between two simulation ticks is never lost.
 *
 * Weapons are selected only with the keys 1 / 2 / 3 (top row or numpad).
 * The mouse wheel deliberately does nothing: touch-surface mice (e.g. the
 * Apple Magic Mouse) send wheel events from any finger movement, which used
 * to switch weapons by accident.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  sensitivity = 2.5;
  invertY = false;
  /** Multiplier applied while scoped. */
  zoomSensitivity = 1;
  /** When true, behave as if locked (used by automated tests). */
  testMode = false;
  enabled = true;

  private readonly keys = new Set<string>();
  private mouse0 = false;
  private mouse2 = false;
  private pendingSlot: WeaponSlot | 0 = 0;
  private pendingReload = false;
  private pendingDrop = false;
  private readonly target: HTMLElement;
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  private lockRequested = 0;

  onAction: (action: 'scoreboard-on' | 'scoreboard-off' | 'buy' | 'pause') => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};
  onLockError: () => void = () => {};

  constructor(target: HTMLElement) {
    this.target = target;
    this.on(document, 'keydown', (e) => this.keyDown(e as KeyboardEvent));
    this.on(document, 'keyup', (e) => this.keyUp(e as KeyboardEvent));
    this.on(document, 'mousemove', (e) => this.mouseMove(e as MouseEvent));
    this.on(document, 'mousedown', (e) => this.mouseDown(e as MouseEvent));
    this.on(document, 'mouseup', (e) => this.mouseUp(e as MouseEvent));
    this.on(document, 'contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    this.on(document, 'pointerlockchange', () => {
      if (!this.locked) this.releaseAll();
      this.onLockChange(this.locked);
    });
    this.on(document, 'pointerlockerror', () => this.onLockError());
    this.on(window, 'blur', () => this.releaseAll());
  }

  private on(t: EventTarget, type: string, fn: EventListener): void {
    t.addEventListener(type, fn, { passive: false } as AddEventListenerOptions);
    this.listeners.push([t, type, fn]);
  }

  dispose(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    if (this.locked) document.exitPointerLock();
  }

  get locked(): boolean {
    return this.testMode || document.pointerLockElement === this.target;
  }

  /** Must be called from a user gesture (click / keydown). */
  requestLock(): void {
    if (this.testMode || this.locked) return;
    const now = performance.now();
    if (now - this.lockRequested < 300) return;
    this.lockRequested = now;
    const el = this.target as HTMLElement & { requestPointerLock(opts?: unknown): Promise<void> | void };
    try {
      // Raw (un-accelerated) mouse input where supported, like a classic engine.
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          const r2 = el.requestPointerLock();
          if (r2 && typeof (r2 as Promise<void>).catch === 'function') (r2 as Promise<void>).catch(() => this.onLockError());
        });
      }
    } catch {
      this.onLockError();
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private releaseAll(): void {
    this.keys.clear();
    this.mouse0 = false;
    this.mouse2 = false;
  }

  private keyDown(e: KeyboardEvent): void {
    if (!this.enabled || isTextEntry(e.target)) return;
    const k = e.code;
    if (k === 'Tab') {
      e.preventDefault();
      if (!e.repeat) this.onAction('scoreboard-on');
      return;
    }
    if (k === 'Escape') {
      // Browsers release pointer lock on Escape themselves; we only handle
      // the case where the game is unlocked (e.g. close a menu).
      if (!this.locked) this.onAction('pause');
      return;
    }
    if (!this.locked) {
      if (k === 'KeyB' && !e.repeat) this.onAction('buy'); // toggles the buy menu closed
      return;
    }
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(k)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(k);
    switch (k) {
      case 'Digit1': case 'Numpad1': this.queueSlot(1); break;
      case 'Digit2': case 'Numpad2': this.queueSlot(2); break;
      case 'Digit3': case 'Numpad3': this.queueSlot(3); break;
      case 'KeyR': this.pendingReload = true; break;
      case 'KeyG': this.pendingDrop = true; break;
      case 'KeyB': this.onAction('buy'); break;
      case 'Backquote': this.onAction('pause'); break;
    }
  }

  private keyUp(e: KeyboardEvent): void {
    if (e.code === 'Tab') {
      e.preventDefault();
      this.onAction('scoreboard-off');
    }
    this.keys.delete(e.code);
  }

  private queueSlot(s: WeaponSlot): void {
    this.pendingSlot = s;
  }

  private mouseMove(e: MouseEvent): void {
    if (!this.locked || !this.enabled) return;
    const scale = this.sensitivity * 0.022 * (Math.PI / 180) * this.zoomSensitivity;
    this.yaw -= e.movementX * scale;
    this.pitch -= e.movementY * scale * (this.invertY ? -1 : 1);
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    this.yaw = ((this.yaw % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  }

  private mouseDown(e: MouseEvent): void {
    if (!this.locked || !this.enabled) return;
    if (e.button === 0) this.mouse0 = true;
    if (e.button === 2) this.mouse2 = true;
  }

  private mouseUp(e: MouseEvent): void {
    if (e.button === 0) this.mouse0 = false;
    if (e.button === 2) this.mouse2 = false;
  }

  queueSlotExternal(s: WeaponSlot): void {
    this.pendingSlot = s;
  }

  /** Snapshot the current input as a simulation command. */
  sample(): PlayerCmd {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const cmd: PlayerCmd = {
      forward: k('KeyW') - k('KeyS'),
      side: k('KeyD') - k('KeyA'),
      jump: this.keys.has('Space'),
      // Crouch is C, not Ctrl: Ctrl+W would close the browser tab mid-game.
      crouch: this.keys.has('KeyC'),
      walk: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      yaw: this.yaw,
      pitch: this.pitch,
      fire: this.mouse0,
      altFire: this.mouse2,
      reload: this.pendingReload,
      slot: this.pendingSlot,
      use: this.keys.has('KeyE'),
      drop: this.pendingDrop,
    };
    this.pendingReload = false;
    this.pendingDrop = false;
    this.pendingSlot = 0;
    return cmd;
  }

  /** Test hooks: drive input without real devices. */
  setKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  setMouse(button: 0 | 2, down: boolean): void {
    if (button === 0) this.mouse0 = down;
    else this.mouse2 = down;
  }
}

/** Keys typed into a text field must never drive the game. */
function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t.type);
}
