import type { Team } from '../shared/map';
import { BUYABLE, WEAPONS, type WeaponId } from '../shared/weapons';
import { EQUIPMENT, TEAM_NAME, type BuyItem, type SimPlayer, type Simulation } from '../shared/sim';
import { button, el } from './dom';

/**
 * In-game HUD built from plain DOM elements. Values are only written when
 * they change, so a per-frame update costs next to nothing.
 */
export class Hud {
  readonly root: HTMLElement;
  private readonly cache = new Map<HTMLElement, string>();
  private readonly health: HTMLElement;
  private readonly armor: HTMLElement;
  private readonly money: HTMLElement;
  private readonly moneyWrap: HTMLElement;
  private readonly ammo: HTMLElement;
  private readonly reserve: HTMLElement;
  private readonly ammoWrap: HTMLElement;
  private readonly weapon: HTMLElement;
  private readonly scoreA: HTMLElement;
  private readonly scoreD: HTMLElement;
  private readonly aliveA: HTMLElement;
  private readonly aliveD: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly loc: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly center: HTMLElement;
  private readonly centerBig: HTMLElement;
  private readonly centerSmall: HTMLElement;
  private readonly killfeed: HTMLElement;
  private readonly cross: HTMLElement;
  private readonly crossParts: HTMLElement[];
  private readonly vignette: HTMLElement;
  private readonly scope: HTMLElement;
  private readonly spec: HTMLElement;
  private readonly scoreboard: HTMLElement;
  private readonly buy: HTMLElement;
  private readonly buyMsg: HTMLElement;
  private readonly buyItems: { item: BuyItem; el: HTMLButtonElement }[] = [];
  private readonly fps: HTMLElement;
  private centerUntil = 0;
  private moneyFlashUntil = 0;
  private lastMoney = -1;
  private scoreboardOpen = false;
  onBuy: (item: BuyItem) => void = () => {};
  onCloseBuy: () => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    root.replaceChildren();

    this.vignette = el('div', 'vignette', undefined, root);
    this.scope = el('div', 'scope hidden', undefined, root);
    el('div', 'ring', undefined, this.scope);
    el('div', 'h', undefined, this.scope);
    el('div', 'v', undefined, this.scope);

    this.cross = el('div', 'crosshair', undefined, root);
    this.crossParts = ['t', 'b', 'l', 'r'].map((c) => el('i', c, undefined, this.cross));

    const top = el('div', 'hud-top', undefined, root);
    this.aliveA = el('span', 'alive a', '', top);
    this.scoreA = el('span', 'score a', '0', top);
    this.timer = el('span', 'timer', '0:00', top);
    this.scoreD = el('span', 'score d', '0', top);
    this.aliveD = el('span', 'alive', '', top);
    this.loc = el('div', 'hud-loc', '', root);

    this.killfeed = el('div', 'killfeed', undefined, root);

    this.center = el('div', 'hud-center hidden', undefined, root);
    this.centerBig = el('div', 'big', '', this.center);
    this.centerSmall = el('div', 'small', '', this.center);
    this.hint = el('div', 'hud-hint', '', root);

    this.moneyWrap = el('div', 'hud-money', undefined, root);
    el('span', 'hud-icon', '$', this.moneyWrap);
    this.money = el('span', 'hud-num', '0', this.moneyWrap);

    const bl = el('div', 'hud-bl', undefined, root);
    const hw = el('div', '', undefined, bl);
    el('span', 'hud-icon', '+', hw);
    this.health = el('span', 'hud-num', '100', hw);
    const aw = el('div', '', undefined, bl);
    el('span', 'hud-icon', '◈', aw);
    this.armor = el('span', 'hud-num', '0', aw);

    const br = el('div', 'hud-br', undefined, root);
    this.weapon = el('div', 'hud-weapon', '', br);
    this.ammoWrap = el('div', 'hud-ammo', undefined, br);
    this.ammo = el('span', 'hud-num', '0', this.ammoWrap);
    el('span', 'sep', '|', this.ammoWrap);
    this.reserve = el('span', 'hud-num res', '0', this.ammoWrap);

    this.spec = el('div', 'spec hidden', '', root);
    this.scoreboard = el('div', 'scoreboard hidden', undefined, root);

    this.buy = el('div', 'buymenu panel hidden', undefined, root);
    el('h2', '', 'Buy Menu', this.buy);
    const grid = el('div', 'buy-grid', undefined, this.buy);
    const items: BuyItem[] = [...BUYABLE, 'kevlar', 'helmet', 'ammo1', 'ammo2'];
    items.forEach((item, i) => {
      const key = String((i + 1) % 10);
      const b = button('', 'buy-item', () => this.onBuy(item), grid);
      el('span', 'k', key, b);
      const name = el('span', '', undefined, b);
      const isW = item in WEAPONS;
      el('span', 'cat', isW ? WEAPONS[item as WeaponId].cls : 'equipment', name);
      name.append(isW ? WEAPONS[item as WeaponId].name : EQUIPMENT[item as keyof typeof EQUIPMENT].name);
      el('span', 'p', '$' + (isW ? WEAPONS[item as WeaponId].price : EQUIPMENT[item as keyof typeof EQUIPMENT].price), b);
      b.dataset.key = key;
      this.buyItems.push({ item, el: b });
    });
    this.buyMsg = el('div', 'buy-msg', '', this.buy);
    const act = el('div', 'actions', undefined, this.buy);
    button('Close (B)', 'btn', () => this.onCloseBuy(), act);

    this.fps = el('div', 'fps', '', root);
  }

  private set(e: HTMLElement, v: string): void {
    if (this.cache.get(e) === v) return;
    this.cache.set(e, v);
    e.textContent = v;
  }

  private toggle(e: HTMLElement, cls: string, on: boolean): void {
    if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
  }

  show(on: boolean): void {
    this.toggle(this.root, 'hidden', !on);
  }

  // --------------------------------------------------------------- per frame

  update(sim: Simulation, me: SimPlayer, view: SimPlayer | null, now: number, opts: { crosshairGap: number; scoped: boolean; showCrosshair: boolean; location: string; hint: string; fps: number }): void {
    const p = view ?? me;
    this.set(this.health, String(Math.max(0, Math.ceil(p.health))));
    this.toggle(this.health, 'low', p.health <= 25);
    this.set(this.armor, String(p.armor));
    this.set(this.money, String(me.money));
    if (this.lastMoney >= 0 && me.money > this.lastMoney) this.moneyFlashUntil = now + 0.8;
    this.lastMoney = me.money;
    this.toggle(this.moneyWrap, 'flash', now < this.moneyFlashUntil);

    const w = p.weapons[p.current];
    const def = WEAPONS[w ? w.id : 'knife'];
    this.set(this.weapon, def.name + (sim.isReloading(p) ? ' — reloading' : ''));
    const melee = def.magSize === 0;
    this.toggle(this.ammoWrap, 'hidden', melee);
    if (w && !melee) {
      this.set(this.ammo, String(w.mag));
      this.set(this.reserve, String(w.reserve));
      this.toggle(this.ammo, 'low', w.mag <= Math.ceil(def.magSize * 0.2));
    }

    this.set(this.scoreA, String(sim.score.A));
    this.set(this.scoreD, String(sim.score.D));
    this.set(this.aliveA, `${sim.aliveCount('A')} alive`);
    this.set(this.aliveD, `${sim.aliveCount('D')} alive`);
    let t = 0;
    if (sim.phase === 'freeze' || sim.phase === 'live') t = sim.timeLeft();
    if (sim.phase === 'freeze') t = sim.config.roundTime;
    const tt = Math.ceil(t);
    this.set(this.timer, sim.phase === 'warmup' ? 'WARMUP' : `${Math.floor(tt / 60)}:${String(tt % 60).padStart(2, '0')}`);
    this.toggle(this.timer, 'freeze', sim.phase === 'freeze');
    this.set(this.loc, opts.location);
    this.set(this.hint, opts.hint);

    // Crosshair.
    this.toggle(this.cross, 'hidden', !opts.showCrosshair);
    if (opts.showCrosshair) {
      const g = Math.round(opts.crosshairGap);
      const key = String(g);
      if (this.cache.get(this.cross) !== key) {
        this.cache.set(this.cross, key);
        const [tp, bt, lf, rt] = this.crossParts;
        tp.style.top = `${-g - 8}px`;
        bt.style.top = `${g}px`;
        lf.style.left = `${-g - 8}px`;
        rt.style.left = `${g}px`;
      }
    }
    this.toggle(this.scope, 'hidden', !opts.scoped);

    // Damage vignette fades out over ~0.6 s.
    const hurtAge = sim.time - p.lastHurt;
    const vig = p.alive && hurtAge < 0.6 ? String(Math.round((1 - hurtAge / 0.6) * 70) / 100) : '0';
    if (this.cache.get(this.vignette) !== vig) {
      this.cache.set(this.vignette, vig);
      this.vignette.style.opacity = vig;
    }

    if (this.centerUntil && now > this.centerUntil) {
      this.centerUntil = 0;
      this.toggle(this.center, 'hidden', true);
    }
    // Expire kill feed entries.
    for (const c of [...this.killfeed.children] as HTMLElement[]) {
      if (Number(c.dataset.until) < now) c.remove();
    }
    if (this.scoreboardOpen) this.renderScoreboard(sim, me);
    this.set(this.fps, opts.fps ? `${opts.fps} fps` : '');
  }

  message(big: string, small: string, team: Team | null, now: number, duration = 3): void {
    this.centerBig.textContent = big;
    this.centerBig.className = 'big' + (team ? ' ' + team.toLowerCase() : '');
    this.centerSmall.textContent = small;
    this.toggle(this.center, 'hidden', false);
    this.centerUntil = now + duration;
  }

  kill(killer: SimPlayer | undefined, victim: SimPlayer, weapon: WeaponId, headshot: boolean, involvesMe: boolean, now: number): void {
    const row = el('div', 'kf' + (involvesMe ? ' me' : ''));
    if (killer && killer !== victim) el('span', killer.team.toLowerCase(), killer.name, row);
    el('span', 'w', killer && killer !== victim ? WEAPONS[weapon].name : 'died', row);
    if (headshot) el('span', 'hs', '[HS]', row);
    el('span', victim.team.toLowerCase(), victim.name, row);
    row.dataset.until = String(now + 6);
    this.killfeed.appendChild(row);
    while (this.killfeed.children.length > 5) this.killfeed.firstElementChild!.remove();
  }

  /** A system line in the kill feed (joins, disconnects, ...). */
  notice(text: string, now: number): void {
    const row = el('div', 'kf note', text);
    row.dataset.until = String(now + 6);
    this.killfeed.appendChild(row);
    while (this.killfeed.children.length > 5) this.killfeed.firstElementChild!.remove();
  }

  spectate(text: string | null, sub = ''): void {
    this.toggle(this.spec, 'hidden', text === null);
    if (text !== null) {
      this.spec.textContent = text;
      if (sub) el('small', '', sub, this.spec);
    }
  }

  setScoreboard(open: boolean, sim: Simulation, me: SimPlayer): void {
    this.scoreboardOpen = open;
    this.toggle(this.scoreboard, 'hidden', !open);
    if (open) this.renderScoreboard(sim, me);
  }

  private lastBoard = 0;
  private renderScoreboard(sim: Simulation, me: SimPlayer): void {
    const now = performance.now();
    if (now - this.lastBoard < 250) return;
    this.lastBoard = now;
    const sb = this.scoreboard;
    sb.replaceChildren();
    const head = el('div', 'head', undefined, sb);
    el('span', '', `Depot — round ${sim.round}`, head);
    el('span', '', `First to ${sim.config.roundsToWin} rounds`, head);
    for (const team of ['A', 'D'] as Team[]) {
      const h = el('h3', team.toLowerCase(), undefined, sb);
      el('span', '', `${TEAM_NAME[team]}`, h);
      el('span', '', `${sim.score[team]}`, h);
      const table = el('table', '', undefined, sb);
      const hr = el('tr', '', undefined, table);
      for (const c of ['Name', '', 'Kills', 'Deaths', team === me.team ? 'Money' : '']) el('th', '', c, hr);
      const players = sim.players.filter((p) => p.team === team).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      for (const p of players) {
        const tr = el('tr', (p.alive ? '' : 'dead') + (p === me ? ' me' : ''), undefined, table);
        el('td', '', p.name + (p.isBot ? ' (bot)' : ''), tr);
        el('td', '', p.alive ? '' : 'dead', tr);
        el('td', 'n', String(p.kills), tr);
        el('td', 'n', String(p.deaths), tr);
        el('td', 'n', team === me.team ? `$${p.money}` : '', tr);
      }
    }
  }

  // -------------------------------------------------------------- buy menu

  get buyOpen(): boolean {
    return !this.buy.classList.contains('hidden');
  }

  openBuy(open: boolean, sim?: Simulation, me?: SimPlayer): void {
    this.toggle(this.buy, 'hidden', !open);
    this.buyMsg.textContent = '';
    if (open && sim && me) this.refreshBuy(sim, me);
  }

  refreshBuy(sim: Simulation, me: SimPlayer, msg?: string): void {
    for (const { item, el: b } of this.buyItems) {
      const isW = item in WEAPONS;
      const def = isW ? WEAPONS[item as WeaponId] : null;
      const na = !!def?.team && def.team !== me.team;
      b.classList.toggle('na', na);
      b.classList.toggle('poor', !na && sim.priceOf(item) > me.money);
      b.disabled = na;
      if (na) b.title = `${TEAM_NAME[def!.team!]} only`;
    }
    if (msg !== undefined) this.buyMsg.textContent = msg;
    else if (!sim.canBuy(me)) this.buyMsg.textContent = 'Buying is only possible in your spawn zone during buy time.';
  }

  /** Map a number key to a buy item while the buy menu is open. */
  buyItemForKey(key: string): BuyItem | null {
    return this.buyItems.find((b) => b.el.dataset.key === key && !b.el.disabled)?.item ?? null;
  }
}
