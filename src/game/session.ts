import * as THREE from 'three';
import type { GameAudio } from '../audio/audio';
import { GameRenderer } from '../render/renderer';
import type { Settings } from '../settings';
import { BotDirector, type Difficulty } from '../shared/bot';
import { buildMap, type MapDef, type Team } from '../shared/map';
import { PHYS, eyeHeight } from '../shared/movement';
import { Simulation, TEAM_NAME, TICK_DT, emptyCmd, type BuyItem, type SimEvent, type SimPlayer } from '../shared/sim';
import { angleDiff, lerp, type Vec3 } from '../shared/vec';
import { WEAPONS, type WeaponSlot } from '../shared/weapons';
import { spreadToPixels } from '../ui/crosshair';
import { Hud } from '../ui/hud';
import type { NetClient, NetStatus } from '../net/client';
import { NetMirror } from '../net/mirror';
import type { RoomInfo, ServerMsg } from '../shared/protocol';
import { Input } from './input';

export interface SoloConfig {
  map: MapDef;
  team: Team | 'auto';
  teammates: number;
  opponents: number;
  difficulty: Difficulty;
  roundsToWin: number;
}

export type SessionMode =
  | { kind: 'solo'; cfg: SoloConfig }
  | { kind: 'online'; net: NetClient; you: number; map: MapDef; roundsToWin: number };

export interface SessionUi {
  showPause(open: boolean): void;
  showMatchEnd(winner: Team | null, me: Team, score: Record<Team, number>): void;
  showClickToPlay(open: boolean, text?: string): void;
  showDisconnected(text: string): void;
}

/**
 * A running match: owns the renderer, the HUD, input and the main loop.
 *
 * Solo: the Simulation and the bots run right here on a fixed 60 Hz tick;
 * rendering interpolates between the last two ticks.
 *
 * Online: the server runs the Simulation. Here a mirror Simulation holds the
 * latest server state; our own movement is predicted locally (NetMirror) and
 * other players are interpolated between snapshots. Shots are only
 * *cosmetically* predicted — damage and deaths always come from the server.
 */
export class GameSession {
  readonly sim: Simulation;
  readonly bots: BotDirector | null;
  readonly net: NetClient | null;
  readonly mirror: NetMirror | null;
  roomInfo: RoomInfo | null = null;
  readonly renderer: GameRenderer;
  readonly hud: Hud;
  readonly input: Input;
  readonly me: SimPlayer;
  private readonly audio: GameAudio;
  private readonly ui: SessionUi;
  private settings: Settings;
  private raf = 0;
  private acc = 0;
  private lastFrame = 0;
  private paused = true;
  private started = false;
  private ended = false;
  private disposed = false;
  private prev = new Map<number, Vec3>();
  private eyeSmooth = 1.6;
  /** Camera-only smoothing of step-ups so climbing stairs doesn't jolt the view. */
  private stepOffset = 0;
  private lastViewY = 0;
  private deathTime = -1;
  private killerId = 0;
  private spectateId = 0;
  private spectateFireHeld = false;
  private lastWeaponKey = '';
  private drawTime = 0;
  private reloadStart = 0;
  private frames = 0;
  private fpsT = 0;
  private fps = 0;
  private readonly shotThisTick = new Set<number>();
  private readonly showFps = new URLSearchParams(location.search).has('debug');
  private readonly tmpV = new THREE.Vector3();
  private predNextFire = 0;
  private predFireHeld = false;
  private viewTeam: Team | null = null;

  constructor(canvas: HTMLCanvasElement, hudRoot: HTMLElement, mode: SessionMode, settings: Settings, audio: GameAudio, ui: SessionUi) {
    this.settings = settings;
    this.audio = audio;
    this.ui = ui;
    const map = buildMap(mode.kind === 'solo' ? mode.cfg.map : mode.map);
    this.renderer = new GameRenderer(canvas, map, settings.quality);
    this.hud = new Hud(hudRoot);
    this.input = new Input(canvas);

    if (mode.kind === 'solo') {
      const cfg = mode.cfg;
      this.sim = new Simulation(map, { roundsToWin: cfg.roundsToWin });
      this.bots = new BotDirector(this.sim, cfg.difficulty);
      this.net = null;
      this.mirror = null;
      const team: Team = cfg.team === 'auto' ? (Math.random() < 0.5 ? 'A' : 'D') : cfg.team;
      const enemy: Team = team === 'A' ? 'D' : 'A';
      this.me = this.sim.addPlayer(settings.playerName || 'Player', team, false);
      for (let i = 0; i < cfg.teammates; i++) this.sim.addPlayer(BotDirector.botName(team, i), team, true);
      for (let i = 0; i < cfg.opponents; i++) this.sim.addPlayer(BotDirector.botName(enemy, i), enemy, true);
    } else {
      this.sim = new Simulation(map, { roundsToWin: mode.roundsToWin });
      this.bots = null;
      this.net = mode.net;
      // Placeholder until the first snapshot fills in the real state.
      this.me = this.sim.addPlayer(settings.playerName || 'Player', 'A', false, mode.you);
      this.me.alive = false;
      this.mirror = new NetMirror(this.sim, mode.you);
      this.roomInfo = this.net.lastRoom;
      this.net.onMessage = (m) => this.onNetMessage(m);
      this.net.onStatus = (st, detail) => this.onNetStatus(st, detail);
    }
    this.renderer.viewmodel.setTeam(this.me.team);
    this.input.yaw = this.me.yaw;
    this.applySettings(settings);

    this.input.onLockChange = (locked) => this.onLockChange(locked);
    this.input.onLockError = () => this.ui.showClickToPlay(true, 'The browser refused mouse capture. Click again to play.');
    this.input.onAction = (a) => this.onAction(a);
    this.hud.onBuy = (item) => this.tryBuy(item);
    this.hud.onCloseBuy = () => this.toggleBuy(false);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('keydown', this.onBuyKey);

    this.hud.show(true);
    this.ui.showClickToPlay(true);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------- lifecycle

  applySettings(s: Settings): void {
    const qualityChanged = s.quality !== this.settings.quality;
    this.settings = s;
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.hud.setCrosshair(s.crosshair);
    this.audio.setVolumes(s.masterVolume, s.sfxVolume);
    if (qualityChanged) this.renderer.applyQuality(s.quality);
  }

  /** Begin (or resume) play. Must be called from a user gesture. */
  play(): void {
    this.audio.unlock();
    this.input.requestLock();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('keydown', this.onBuyKey);
    this.input.dispose();
    this.renderer.dispose();
    this.hud.show(false);
    this.net?.close();
  }

  get isOnline(): boolean {
    return !!this.net;
  }

  /** Online: ask the server for a team change (only honoured in warmup / after the match). */
  requestTeam(team: Team): void {
    this.net?.send({ t: 'team', team });
  }

  restartRound(): void {
    if (this.net) return; // the server owns rounds online
    this.sim.restartRound();
    this.afterReset();
  }

  restartMatch(): void {
    this.ended = false;
    if (this.net) {
      this.net.send({ t: 'rematch' });
      return;
    }
    this.sim.startMatch();
    this.afterReset();
  }

  private afterReset(): void {
    this.deathTime = -1;
    this.spectateId = 0;
    this.prev.clear();
    this.input.yaw = this.me.yaw;
    this.input.pitch = 0;
    this.renderer.effects.clearDecals();
    this.handleEvents(this.sim.events.splice(0));
  }

  private onResize = () => this.renderer.resize();

  private onVisibility = () => {
    if (document.hidden && !this.paused) this.setPaused(true);
  };

  private onLockChange(locked: boolean): void {
    if (this.disposed) return;
    if (locked) {
      this.ui.showClickToPlay(false);
      this.ui.showPause(false);
      if (this.hud.buyOpen) this.hud.openBuy(false);
      this.setPaused(false);
      this.started = true;
    } else if (this.hud.buyOpen || this.ended) {
      // Expected unlock (buy menu / match end): the game keeps running.
    } else if (this.started) {
      this.setPaused(true);
    }
  }

  private setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    if (p) {
      this.ui.showPause(true);
      this.hud.setScoreboard(false, this.sim, this.me);
    }
    this.lastFrame = performance.now();
  }

  private onAction(a: 'scoreboard-on' | 'scoreboard-off' | 'buy' | 'pause' | 'weapon-next' | 'weapon-prev'): void {
    switch (a) {
      case 'scoreboard-on':
        if (!this.paused) this.hud.setScoreboard(true, this.sim, this.me);
        break;
      case 'scoreboard-off':
        this.hud.setScoreboard(false, this.sim, this.me);
        break;
      case 'buy':
        if (this.paused && !this.hud.buyOpen) return;
        this.toggleBuy(!this.hud.buyOpen);
        break;
      case 'pause':
        if (this.hud.buyOpen) this.toggleBuy(false);
        break;
      case 'weapon-next':
      case 'weapon-prev': {
        const order: WeaponSlot[] = [1, 2, 3];
        const owned = order.filter((s) => this.me.weapons[s]);
        const i = owned.indexOf(this.me.current);
        const n = owned[(i + (a === 'weapon-next' ? 1 : owned.length - 1)) % owned.length];
        if (n) this.input.queueSlotExternal(n);
        break;
      }
    }
  }

  private toggleBuy(open: boolean): void {
    if (open) {
      if (!this.me.alive) return;
      this.hud.openBuy(true, this.sim, this.me);
      this.input.releaseLock();
    } else {
      this.hud.openBuy(false);
      this.input.requestLock();
    }
  }

  private onBuyKey = (e: KeyboardEvent) => {
    if (!this.hud.buyOpen) return;
    const m = /^Digit(\d)$/.exec(e.code);
    if (!m) return;
    const item = this.hud.buyItemForKey(m[1]);
    if (item) this.tryBuy(item);
  };

  private tryBuy(item: BuyItem): void {
    this.audio.unlock();
    if (this.net) {
      this.net.send({ t: 'buy', item });
      return; // result arrives as a 'buyResult' message
    }
    const err = this.sim.buy(this.me, item);
    if (err) this.audio.ui('deny');
    this.hud.refreshBuy(this.sim, this.me, err ?? `Bought ${item in WEAPONS ? WEAPONS[item as keyof typeof WEAPONS].name : item}.`);
  }

  // ------------------------------------------------------------------ loop

  private frame = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    // One clock for everything. rAF's own timestamp can lag performance.now()
    // (e.g. a tab coming back from the background), and a negative delta
    // would stall the simulation, so clamp to [0, 0.25] s.
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 1) {
      this.fps = Math.round(this.frames / this.fpsT);
      this.frames = 0;
      this.fpsT = 0;
    }

    // Online play never pauses: the match goes on while the menu is open.
    if (!this.paused || this.net) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= TICK_DT && steps < 8) {
        this.step();
        this.acc -= TICK_DT;
        steps++;
      }
      if (steps === 8) this.acc = 0; // way behind: drop time rather than spiral
    }
    this.draw(dt, this.paused ? 1 : this.acc / TICK_DT);
  };

  /** One fixed simulation tick. Public for automated tests. */
  step(): void {
    const sim = this.sim;
    const playing = this.input.locked && !this.hud.buyOpen;
    const cmd = playing ? this.input.sample() : { ...emptyCmd(this.input.yaw, this.input.pitch) };
    if (!playing) this.input.sample(); // drain queued actions
    if (cmd.slot && cmd.slot !== this.me.current && this.me.weapons[cmd.slot]) this.input.noteSlotChanged(this.me.current);
    if (this.net && this.mirror) {
      this.stepOnline(cmd);
      return;
    }

    if (this.me.alive) {
      sim.setCmd(this.me, cmd);
    } else {
      // Dead: click cycles spectated player.
      if (cmd.fire && !this.spectateFireHeld) this.cycleSpectate();
      this.spectateFireHeld = cmd.fire;
    }
    this.bots?.update();
    for (const p of sim.players) this.prev.set(p.id, { ...p.body.pos });
    sim.events.length = 0;
    sim.tick();
    this.bots?.observe(sim.events);
    this.handleEvents(sim.events);
  }

  private stepOnline(cmd: ReturnType<Input['sample']>): void {
    const me = this.me;
    const mirror = this.mirror!;
    this.prev.set(me.id, { ...me.body.pos });
    if (!me.alive) {
      if (cmd.fire && !this.spectateFireHeld) this.cycleSpectate();
      this.spectateFireHeld = cmd.fire;
    } else {
      this.predictFire(cmd);
    }
    const seq = mirror.predict(cmd);
    this.net!.send({ t: 'cmd', seq, cmd });
  }

  /** Cosmetic only: kick, flash and sound without waiting a round trip. */
  private predictFire(cmd: ReturnType<Input['sample']>): void {
    const me = this.me;
    const sim = this.sim;
    if (cmd.slot && me.weapons[cmd.slot] && cmd.slot !== me.current) {
      me.current = cmd.slot;
      me.switchEnd = sim.time + 0.45;
    }
    const def = sim.weaponOf(me);
    const w = me.weapons[me.current];
    const pressed = cmd.fire && !this.predFireHeld;
    this.predFireHeld = cmd.fire;
    const canShoot = sim.phase === 'live' || sim.phase === 'warmup';
    if (!canShoot || sim.time < me.switchEnd || me.reloadEnd > 0 || sim.time < this.predNextFire) return;
    if (def.cls === 'melee') {
      if (!cmd.fire) return;
      this.renderer.viewmodel.onFire();
      this.audio.knife(false);
      this.predNextFire = sim.time + def.cycle;
      return;
    }
    if (!w || w.mag <= 0 || !(def.automatic ? cmd.fire : pressed)) return;
    w.mag--; // until the next snapshot says otherwise
    this.predNextFire = sim.time + def.cycle;
    this.renderer.viewmodel.onFire();
    this.audio.gunshot(def.cls, def.id);
    const eye = sim.eyePos(me);
    this.renderer.muzzleLight.intensity = 6;
    this.renderer.muzzleLight.position.set(eye.x, eye.y - 0.1, eye.z);
  }

  private onNetMessage(m: ServerMsg): void {
    const now = performance.now() / 1000;
    switch (m.t) {
      case 'snap': {
        const { removed } = this.mirror!.applySnapshot(m.s, now);
        for (const id of removed) this.renderer.removeAvatar(id);
        this.handleEvents(m.s.events);
        break;
      }
      case 'buyResult':
        if (m.error) this.audio.ui('deny');
        this.hud.refreshBuy(this.sim, this.me, m.error ?? `Bought ${m.item in WEAPONS ? WEAPONS[m.item as keyof typeof WEAPONS].name : m.item}.`);
        break;
      case 'room':
        this.roomInfo = m.info;
        break;
      case 'notice':
        this.hud.notice(m.text, now);
        break;
      case 'welcome':
        this.hud.notice('Reconnected', now);
        break;
      case 'error':
        this.hud.notice(m.text, now);
        break;
      default:
        break;
    }
  }

  private onNetStatus(st: NetStatus, detail?: string): void {
    const now = performance.now() / 1000;
    if (st === 'reconnecting') this.hud.message('Connection lost', detail ?? 'Reconnecting…', null, now, 30);
    else if (st === 'open') this.hud.message('Reconnected', '', null, now, 1.5);
    else if (st === 'closed' && !this.disposed) {
      this.input.releaseLock();
      this.ui.showDisconnected(detail ?? 'Disconnected from the game server.');
    }
  }

  private cycleSpectate(): void {
    const mates = this.sim.players.filter((p) => p.alive && p.team === this.me.team);
    const pool = mates.length ? mates : this.sim.players.filter((p) => p.alive);
    if (!pool.length) return;
    const i = pool.findIndex((p) => p.id === this.spectateId);
    this.spectateId = pool[(i + 1) % pool.length].id;
  }

  // ---------------------------------------------------------------- events

  private handleEvents(events: SimEvent[]): void {
    const sim = this.sim;
    const me = this.me;
    const now = performance.now() / 1000;
    this.shotThisTick.clear();
    const eye = sim.eyePos(me);
    for (const ev of events) {
      switch (ev.type) {
        case 'shot': {
          const shooter = sim.getPlayer(ev.shooter);
          if (!shooter) break;
          const def = WEAPONS[ev.weapon];
          const first = !this.shotThisTick.has(ev.shooter);
          this.shotThisTick.add(ev.shooter);
          if (shooter === me) {
            if (first && !this.net) {
              this.renderer.viewmodel.onFire();
              this.audio.gunshot(def.cls, ev.weapon);
              this.renderer.muzzleLight.intensity = 6;
              this.renderer.muzzleLight.position.set(eye.x, eye.y - 0.1, eye.z);
            }
          } else {
            const avatar = this.renderer.avatar(shooter.id, shooter.team);
            const muzzle = avatar.muzzle.getWorldPosition(this.tmpV);
            if (first) {
              this.renderer.effects.flash(muzzle);
              const d = Math.hypot(ev.origin.x - eye.x, ev.origin.y - eye.y, ev.origin.z - eye.z);
              this.audio.gunshot(def.cls, ev.weapon, ev.origin, d);
            }
            if (def.pellets === 1 || Math.random() < 0.3) this.renderer.effects.tracer(muzzle.clone(), ev.end);
          }
          if (ev.hitWorld && ev.normal) this.renderer.effects.impact(ev.end, ev.normal);
          break;
        }
        case 'melee': {
          const shooter = sim.getPlayer(ev.shooter);
          if (shooter === me && this.net) break; // already predicted
          if (shooter === me) this.renderer.viewmodel.onFire();
          this.audio.knife(ev.hit, shooter === me ? undefined : ev.pos);
          break;
        }
        case 'hit': {
          this.renderer.effects.blood(ev.pos);
          if (ev.attacker === me.id) {
            this.audio.hitConfirm(ev.group === 'head');
            this.hud.hitMarker(ev.group === 'head' ? 'head' : 'hit', now);
          }
          if (ev.victim === me.id) {
            this.audio.hurt();
            const attacker = sim.getPlayer(ev.attacker);
            if (attacker && attacker !== me) {
              const toAttacker = Math.atan2(-(attacker.body.pos.x - me.body.pos.x), -(attacker.body.pos.z - me.body.pos.z));
              this.hud.damageFrom(angleDiff(toAttacker, this.input.yaw), now);
            }
          }
          break;
        }
        case 'kill': {
          const victim = sim.getPlayer(ev.victim);
          const killer = sim.getPlayer(ev.killer);
          if (!victim) break;
          this.hud.kill(killer, victim, ev.weapon, ev.headshot, ev.killer === me.id || ev.victim === me.id, now);
          if (ev.killer === me.id && victim !== me) this.hud.hitMarker('kill', now);
          this.audio.death(victim === me ? undefined : victim.body.pos);
          if (victim === me) {
            this.deathTime = sim.time;
            this.killerId = ev.killer;
            this.hud.openBuy(false);
          }
          if (ev.victim === this.spectateId) this.spectateId = 0;
          break;
        }
        case 'reload': {
          const p = sim.getPlayer(ev.player);
          if (p === me) this.reloadStart = sim.time;
          this.audio.reload(WEAPONS[ev.weapon].reloadTime, p === me ? undefined : p?.body.pos);
          break;
        }
        case 'dryfire':
          if (ev.player === me.id) this.audio.dryFire();
          break;
        case 'switch':
          if (ev.player === me.id) {
            this.audio.draw();
            this.drawTime = 0;
          }
          break;
        case 'step': {
          if (ev.walk && ev.player !== me.id) break; // walking is silent to others
          const ai = sim.map.areaIndex[sim.map.cellOf(ev.pos).z * sim.map.def.cols + sim.map.cellOf(ev.pos).x];
          const floor = ai >= 0 ? sim.map.def.areas[ai].floor : 'concrete';
          const surface = floor === 'sand' || floor === 'dirt' ? 'sand' : 'hard';
          this.audio.footstep(ev.player === me.id ? undefined : ev.pos, surface);
          break;
        }
        case 'land':
          this.audio.land(ev.player === me.id ? undefined : ev.pos);
          break;
        case 'buy':
          if (ev.player === me.id) this.audio.ui('buy');
          break;
        case 'roundStart':
          this.hud.message(`Round ${ev.round}`, `Buy time — press B. ${TEAM_NAME[me.team]}: ${me.team === 'A' ? 'eliminate the Defenders' : 'hold the sites, eliminate the Attackers'}.`, null, now, 3);
          this.audio.radio('start');
          this.renderer.effects.clearDecals();
          this.deathTime = -1;
          this.spectateId = 0;
          this.input.yaw = this.mirror ? this.mirror.serverYaw : me.yaw;
          this.input.pitch = 0;
          me.yaw = this.input.yaw;
          this.predNextFire = 0;
          this.prev.clear();
          if (this.ended) {
            // Online rematch started by either player.
            this.ended = false;
            this.ui.showClickToPlay(true, 'Rematch! Click to play.');
          }
          break;
        case 'freezeEnd':
          this.hud.message('Go!', 'Round is live', null, now, 1.5);
          this.audio.radio('go');
          break;
        case 'roundEnd': {
          const won = ev.winner === me.team;
          this.hud.message(ev.winner ? `${TEAM_NAME[ev.winner]} win` : 'Round draw', ev.reason, ev.winner, now, 4.5);
          this.audio.radio(ev.winner === null ? 'lose' : won ? 'win' : 'lose');
          break;
        }
        case 'matchEnd':
          this.ended = true;
          this.hud.setScoreboard(false, sim, me);
          this.hud.openBuy(false);
          window.setTimeout(() => {
            if (this.disposed) return;
            this.input.releaseLock();
            this.ui.showMatchEnd(ev.winner, me.team, { ...sim.score });
          }, 2500);
          break;
        default:
          break;
      }
    }
  }

  // ---------------------------------------------------------------- render

  private interp(p: SimPlayer, alpha: number): Vec3 {
    const a = this.prev.get(p.id);
    const b = p.body.pos;
    if (!a || Math.hypot(a.x - b.x, a.z - b.z) > 3) return { ...b };
    return { x: lerp(a.x, b.x, alpha), y: lerp(a.y, b.y, alpha), z: lerp(a.z, b.z, alpha) };
  }

  private draw(dt: number, alpha: number): void {
    const sim = this.sim;
    const me = this.me;
    const r = this.renderer;
    const cam = r.camera;
    if (this.mirror) {
      const nowS = performance.now() / 1000;
      sim.time = this.mirror.serverTime(nowS);
      this.mirror.interpolate(nowS);
      this.mirror.decayCorrection(dt);
      for (const p of sim.players) if (p !== me) this.prev.set(p.id, { ...p.body.pos });
    }
    if (this.viewTeam !== me.team) {
      this.viewTeam = me.team;
      r.viewmodel.setTeam(me.team);
    }

    // Who are we looking through?
    let view: SimPlayer | null = null;
    if (!me.alive && this.deathTime >= 0 && sim.time - this.deathTime > 2.5) {
      if (!this.spectateId || !sim.getPlayer(this.spectateId)?.alive) this.cycleSpectate();
      view = sim.getPlayer(this.spectateId) ?? null;
    }

    // Avatars for everyone except the player whose eyes we're using.
    const present = new Set<number>();
    for (const p of sim.players) {
      present.add(p.id);
      const av = r.avatar(p.id, p.team);
      const hidden = p === me ? me.alive || this.deathTime < 0 : p === view;
      av.root.visible = !hidden;
      if (hidden) continue;
      const pos = this.interp(p, alpha);
      const w = p.weapons[p.current];
      av.setWeapon(WEAPONS[w ? w.id : 'knife'].cls, w ? w.id : 'knife');
      av.update(dt, { ...pos, yaw: p.yaw, pitch: p.pitch, speed: Math.hypot(p.body.vel.x, p.body.vel.z), crouched: p.body.crouched, alive: p.alive });
    }
    for (const id of r.avatarIds()) if (!present.has(id)) r.removeAvatar(id);

    // Camera.
    let fov = this.settings.fov;
    let scoped = false;
    let showViewmodel = false;
    if (me.alive) {
      const pos = this.interp(me, alpha);
      if (this.mirror) {
        pos.x += this.mirror.correction.x;
        pos.y += this.mirror.correction.y;
        pos.z += this.mirror.correction.z;
      }
      this.eyeSmooth += (eyeHeight(me.body) - this.eyeSmooth) * Math.min(1, dt * 14);
      const dy = pos.y - this.lastViewY;
      if (me.body.onGround && dy > 0.02 && dy < PHYS.stepHeight + 0.05) this.stepOffset -= dy;
      this.lastViewY = pos.y;
      this.stepOffset *= Math.exp(-dt * 14);
      cam.position.set(pos.x, pos.y + this.eyeSmooth + this.stepOffset, pos.z);
      cam.rotation.set(this.input.pitch + me.punchPitch * 0.6, this.input.yaw + me.punchYaw * 0.6, 0);
      const def = sim.weaponOf(me);
      if (def.scope && me.scope > 0) {
        fov = def.scope.fovs[me.scope - 1];
        scoped = true;
      }
      showViewmodel = !scoped;
      const w = me.weapons[me.current];
      const key = w ? w.id : 'knife';
      if (key !== this.lastWeaponKey) {
        this.lastWeaponKey = key;
        r.viewmodel.setWeapon(key);
        this.drawTime = 0;
      }
      this.drawTime += dt;
      const reloading = sim.isReloading(me) ? (sim.time - this.reloadStart) / def.reloadTime : -1;
      r.viewmodel.update(dt, {
        speed: Math.hypot(me.body.vel.x, me.body.vel.z),
        onGround: me.body.onGround,
        reload: reloading,
        draw: this.drawTime,
        yaw: this.input.yaw,
        pitch: this.input.pitch,
        visible: true,
      });
    } else if (view) {
      const pos = this.interp(view, alpha);
      cam.position.set(pos.x, pos.y + eyeHeight(view.body), pos.z);
      cam.rotation.set(view.pitch + view.punchPitch * 0.6, view.yaw + view.punchYaw * 0.6, 0);
    } else {
      // Death cam: sink to the floor and look toward the killer.
      const t = Math.min(1, (sim.time - this.deathTime) / 0.6);
      const pos = me.body.pos;
      cam.position.set(pos.x, pos.y + lerp(eyeHeight(me.body), 0.5, t), pos.z);
      const killer = sim.getPlayer(this.killerId);
      if (killer && killer !== me) {
        const ke = sim.eyePos(killer);
        const yaw = Math.atan2(-(ke.x - pos.x), -(ke.z - pos.z));
        cam.rotation.set(cam.rotation.x * 0.9, lerp(cam.rotation.y, yaw, Math.min(1, dt * 4)), 0.25 * t);
      } else {
        cam.rotation.z = 0.25 * t;
      }
    }
    r.setFov(fov);
    this.input.zoomSensitivity = fov / this.settings.fov;
    r.muzzleLight.intensity = Math.max(0, r.muzzleLight.intensity - dt * 120);
    r.effects.update(dt);
    this.audio.setListener(cam.position, cam.rotation.y);

    // HUD.
    const showSpec = !me.alive && this.deathTime >= 0;
    if (showSpec) {
      this.hud.spectate(view ? `Spectating ${view.name}` : 'You are dead', view ? 'Click to switch player' : '');
    } else {
      this.hud.spectate(null);
    }
    const hp = view ?? me;
    const def = sim.weaponOf(hp);
    const spread = sim.spreadOf(hp);
    const vfov = (cam.fov * Math.PI) / 180;
    const spreadPx = spreadToPixels(spread, vfov, window.innerHeight);
    let hint = '';
    if (me.alive && sim.canBuy(me) && !this.hud.buyOpen) hint = 'Press B to open the buy menu';
    if (sim.phase === 'warmup') {
      hint = this.net
        ? `Waiting for your friend — room code ${this.net.room}. Press Esc for the invite link.`
        : 'Warmup — waiting for players';
    }
    this.hud.update(sim, me, view, performance.now() / 1000, {
      spreadPx,
      scoped,
      showCrosshair: (me.alive || !!view) && !scoped && def.cls !== 'sniper',
      location: sim.map.areaNameAt((view ?? me).body.pos),
      hint,
      fps: this.showFps ? this.fps : 0,
    });

    r.render(showViewmodel);
  }
}
