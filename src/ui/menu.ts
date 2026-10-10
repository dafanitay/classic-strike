import type { Settings } from '../settings';
import type { Difficulty } from '../shared/bot';
import { MAPS } from '../shared/maps/depot';
import type { Team } from '../shared/map';
import { TEAM_NAME } from '../shared/sim';
import type { SoloConfig } from '../game/session';
import { NetClient, serverHttpUrl } from '../net/client';
import type { RoomInfo } from '../shared/protocol';
import { button, el, row, segmented, slider } from './dom';

/**
 * Menu screens. Each screen is rebuilt from scratch when shown — simple,
 * and there is no persistent menu state to go stale.
 */
export interface MenuHost {
  root: HTMLElement;
  settings: Settings;
  saveSettings(s: Settings): void;
  startSolo(cfg: SoloConfig): void;
  startOnline(net: NetClient, roundsToWin: number): void;
  click(): void;
}

export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}?room=${code}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const SOLO_KEY = 'classic-strike.solo.v1';

function loadSolo(): Omit<SoloConfig, 'map'> & { mapId: string } {
  const def = { mapId: 'depot', team: 'auto' as Team | 'auto', teammates: 2, opponents: 3, difficulty: 'normal' as Difficulty, roundsToWin: 5 };
  try {
    const raw = localStorage.getItem(SOLO_KEY);
    return raw ? { ...def, ...JSON.parse(raw) } : def;
  } catch {
    return def;
  }
}

export class Menus {
  private readonly host: MenuHost;

  constructor(host: MenuHost) {
    this.host = host;
  }

  private screen(overGame = false): HTMLElement {
    this.host.root.replaceChildren();
    return el('div', 'screen' + (overGame ? ' over-game' : ''), undefined, this.host.root);
  }

  clear(): void {
    this.host.root.replaceChildren();
  }

  main(): void {
    const s = this.screen();
    const m = el('div', 'menu', undefined, s);
    el('h1', 'title', 'CLASSIC STRIKE', m);
    el('p', 'subtitle', 'Tactical rounds · bots · old-school', m);
    const nav = (label: string, fn: () => void) => button(label, 'menu-btn', () => {
      this.host.click();
      fn();
    }, m);
    nav('Play Solo', () => this.solo()).focus();
    nav('Play With a Friend', () => this.friend());
    nav('Settings', () => this.settings(() => this.main()));
    nav('Controls', () => this.controls(() => this.main()));
    nav('About', () => this.about());
  }

  solo(): void {
    const s = this.screen();
    const p = el('div', 'panel', undefined, s);
    el('h2', '', 'Play Solo — Match Setup', p);
    const cfg = loadSolo();
    const save = () => {
      try {
        localStorage.setItem(SOLO_KEY, JSON.stringify(cfg));
      } catch {
        /* not persisted */
      }
    };
    segmented(row(p, 'Map'), MAPS.map((m) => ({ value: m.id, label: m.name })), cfg.mapId, (v) => ((cfg.mapId = v), save()));
    segmented(row(p, 'Mode'), [
      { value: 'elim', label: 'Elimination' },
      { value: 'bomb', label: 'Bomb Defusal (coming soon)', disabled: true, title: 'Planned for a later milestone' },
    ], 'elim', () => {});
    segmented(row(p, 'Your team'), [
      { value: 'auto', label: 'Auto' },
      { value: 'A', label: TEAM_NAME.A },
      { value: 'D', label: TEAM_NAME.D },
    ] as { value: Team | 'auto'; label: string }[], cfg.team, (v) => ((cfg.team = v), save()));
    segmented(row(p, 'Teammate bots'), [0, 1, 2, 3, 4].map((n) => ({ value: n, label: String(n) })), cfg.teammates, (v) => ((cfg.teammates = v), save()));
    segmented(row(p, 'Opponent bots'), [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) })), cfg.opponents, (v) => ((cfg.opponents = v), save()));
    segmented(row(p, 'Bot difficulty'), [
      { value: 'easy', label: 'Easy' },
      { value: 'normal', label: 'Normal' },
      { value: 'hard', label: 'Hard' },
    ] as { value: Difficulty; label: string }[], cfg.difficulty, (v) => ((cfg.difficulty = v), save()));
    segmented(row(p, 'Rounds to win'), [3, 5, 8, 16].map((n) => ({ value: n, label: String(n) })), cfg.roundsToWin, (v) => ((cfg.roundsToWin = v), save()));
    el('p', 'note', 'Attackers start in the west yard; Defenders start between the two bombsites. A round ends when one team is eliminated, or Defenders win when the timer runs out.', p);
    const act = el('div', 'actions', undefined, p);
    button('Back', 'btn', () => (this.host.click(), this.main()), act);
    button('Start Match', 'btn primary', () => {
      this.host.click();
      const map = MAPS.find((m) => m.id === cfg.mapId) ?? MAPS[0];
      this.host.startSolo({ map, team: cfg.team, teammates: cfg.teammates, opponents: cfg.opponents, difficulty: cfg.difficulty, roundsToWin: cfg.roundsToWin });
    }, act).focus();
  }

  /**
   * Play With a Friend: create a private room (code + invite link) or join
   * one. Opening an invite link (?room=CODE) lands here and joins directly.
   */
  friend(joinCode?: string): void {
    const s = this.screen();
    const p = el('div', 'panel', undefined, s);
    el('h2', '', 'Play With a Friend', p);

    const status = el('span', '', 'Checking server…');
    const statusRow = row(p, 'Connection status');
    statusRow.append(status);
    let serverUp = false;
    fetch(serverHttpUrl('/healthz'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(() => {
        serverUp = true;
        status.textContent = 'Game server online';
      })
      .catch(() => {
        status.textContent = 'Game server unreachable — online play is unavailable right now. Solo play still works.';
      });

    const nameRow = row(p, 'Your name');
    const name = el('input', '', undefined, nameRow);
    name.type = 'text';
    name.maxLength = 16;
    name.value = this.host.settings.playerName;
    const saveName = () => {
      const v = name.value.trim().slice(0, 16) || 'Player';
      if (v !== this.host.settings.playerName) this.host.saveSettings({ ...this.host.settings, playerName: v });
      return v;
    };

    let team: Team | 'auto' = 'auto';
    segmented(row(p, 'Your team (new room)'), [
      { value: 'auto', label: 'Auto' },
      { value: 'A', label: TEAM_NAME.A },
      { value: 'D', label: TEAM_NAME.D },
    ] as { value: Team | 'auto'; label: string }[], 'auto', (v) => (team = v));

    const codeRow = row(p, 'Room code');
    const code = el('input', '', undefined, codeRow);
    code.type = 'text';
    code.maxLength = 5;
    code.placeholder = 'e.g. K7Q2M';
    code.style.textTransform = 'uppercase';
    code.value = joinCode ?? '';

    const msg = el('p', 'note', '', p);
    const act = el('div', 'actions', undefined, p);
    button('Back', 'btn', () => (this.host.click(), this.main()), act);
    const joinBtn = button('Join Room', 'btn', () => void go('join'), act);
    const createBtn = button('Create Room', 'btn primary', () => void go('create'), act);

    const go = async (kind: 'create' | 'join') => {
      this.host.click();
      const room = code.value.trim().toUpperCase();
      if (kind === 'join' && !/^[A-Z2-9]{5}$/.test(room)) {
        msg.textContent = 'Enter the 5-character room code your friend sent you.';
        return;
      }
      createBtn.disabled = joinBtn.disabled = true;
      msg.textContent = kind === 'create' ? 'Creating room…' : `Joining ${room}…`;
      const net = new NetClient();
      try {
        if (kind === 'create') await net.create(saveName(), team);
        else await net.join(room, saveName());
        this.lobby(net);
      } catch (e) {
        net.close();
        msg.textContent = (e as Error).message + (serverUp ? '' : ' (the game server looks unreachable)');
        createBtn.disabled = joinBtn.disabled = false;
      }
    };
    if (joinCode) void go('join');
    else createBtn.focus();
  }

  /** Room lobby: code, invite link, who's here, and the button into the match. */
  lobby(net: NetClient): void {
    const s = this.screen();
    const p = el('div', 'panel', undefined, s);
    el('h2', '', `Room ${net.room}`, p);
    const link = inviteLink(net.room);
    const linkRow = row(p, 'Invitation link');
    const linkInput = el('input', '', undefined, linkRow);
    linkInput.type = 'text';
    linkInput.readOnly = true;
    linkInput.value = link;
    linkInput.addEventListener('focus', () => linkInput.select());
    const codeRow = row(p, 'Room code');
    el('b', '', net.room, codeRow).style.cssText = 'font-size:20px;letter-spacing:3px;color:#fff';
    const stRow = row(p, 'Connection status');
    const st = el('span', '', 'Connected', stRow);
    const playersRow = row(p, 'Players');
    const list = el('div', '', undefined, playersRow);
    const note = el('p', 'note', 'Send the link (or the code) to your friend. The match starts as soon as both of you are in — one player on each team.', p);
    let roundsToWin = 8;
    const render = (info: RoomInfo) => {
      list.replaceChildren();
      for (const pl of info.players) {
        const line = el('div', '', `${pl.name}${pl.id === net.you ? ' (you)' : ''} — ${TEAM_NAME[pl.team]}${pl.connected ? '' : ' (disconnected)'}`, list);
        line.style.color = pl.team === 'A' ? 'var(--a)' : 'var(--d)';
      }
      if (info.players.length < 2) note.textContent = 'Waiting for your friend… Send them the link or the code. You can enter the map now and warm up.';
      else note.textContent = 'Both players are here. Enter the match!';
    };
    net.onMessage = (m) => {
      if (m.t === 'room') render(m.info);
      if (m.t === 'welcome') roundsToWin = m.roundsToWin;
    };
    net.onStatus = (status, detail) => (st.textContent = detail ?? status);
    if (net.lastRoom) render(net.lastRoom);
    const act = el('div', 'actions', undefined, p);
    button('Leave', 'btn', () => {
      this.host.click();
      net.close();
      this.main();
    }, act);
    const copyBtn = button('Copy Invitation Link', 'btn', async () => {
      this.host.click();
      copyBtn.textContent = (await copyText(link)) ? 'Copied!' : 'Copy failed — select the link';
    }, act);
    button('Enter Match', 'btn primary', () => (this.host.click(), this.host.startOnline(net, roundsToWin)), act).focus();
  }

  settings(back: () => void, overGame = false, onChange?: (s: Settings) => void): void {
    const sc = this.screen(overGame);
    const p = el('div', 'panel', undefined, sc);
    el('h2', '', 'Settings', p);
    const s = { ...this.host.settings };
    const apply = () => {
      this.host.saveSettings({ ...s });
      onChange?.({ ...s });
    };
    const nameRow = row(p, 'Player name');
    const name = el('input', '', undefined, nameRow);
    name.type = 'text';
    name.maxLength = 16;
    name.value = s.playerName;
    name.addEventListener('change', () => {
      s.playerName = name.value.trim().slice(0, 16) || 'Player';
      apply();
    });
    slider(p, 'Mouse sensitivity', 0.2, 10, 0.1, s.sensitivity, (v) => v.toFixed(1), (v) => ((s.sensitivity = v), apply()));
    segmented(row(p, 'Invert mouse'), [{ value: 'no', label: 'Off' }, { value: 'yes', label: 'On' }], s.invertY ? 'yes' : 'no', (v) => ((s.invertY = v === 'yes'), apply()));
    slider(p, 'Field of view', 75, 115, 1, s.fov, (v) => `${v}°`, (v) => ((s.fov = v), apply()));
    slider(p, 'Master volume', 0, 1, 0.05, s.masterVolume, (v) => `${Math.round(v * 100)}%`, (v) => ((s.masterVolume = v), apply()));
    slider(p, 'Effects volume', 0, 1, 0.05, s.sfxVolume, (v) => `${Math.round(v * 100)}%`, (v) => ((s.sfxVolume = v), apply()));
    segmented(row(p, 'Graphics quality'), [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ] as { value: Settings['quality']; label: string }[], s.quality, (v) => ((s.quality = v), apply()));
    el('p', 'note', 'Low disables shadows and anti-aliasing and renders at reduced resolution. Settings are saved in this browser.', p);
    const act = el('div', 'actions', undefined, p);
    button('Back', 'btn primary', () => (this.host.click(), back()), act).focus();
  }

  controls(back: () => void, overGame = false): void {
    const s = this.screen(overGame);
    const p = el('div', 'panel', undefined, s);
    el('h2', '', 'Controls', p);
    const t = el('table', 'keys', undefined, p);
    const rows: [string, string][] = [
      ['W A S D', 'Move'],
      ['Mouse', 'Aim'],
      ['Left mouse', 'Fire'],
      ['Right mouse', 'Scope (sniper) / heavy stab (knife)'],
      ['Space', 'Jump'],
      ['Shift (hold)', 'Walk — silent footsteps'],
      ['C (hold)', 'Crouch — better accuracy'],
      ['R', 'Reload'],
      ['1 / 2 / 3, wheel, Q', 'Primary / pistol / knife, cycle, last weapon'],
      ['B', 'Buy menu (spawn zone, buy time)'],
      ['Tab (hold)', 'Scoreboard'],
      ['Esc', 'Pause and release the mouse'],
    ];
    for (const [k, v] of rows) {
      const tr = el('tr', '', undefined, t);
      el('td', '', k, tr);
      el('td', '', v, tr);
    }
    el('p', 'note', 'Click the game to capture the mouse. Moving, jumping and firing while moving all reduce accuracy — stop, crouch or burst-fire for precise shots, as in the classics.', p);
    const act = el('div', 'actions', undefined, p);
    button('Back', 'btn primary', () => (this.host.click(), back()), act).focus();
  }

  about(): void {
    const s = this.screen();
    const p = el('div', 'panel', undefined, s);
    el('h2', '', 'About', p);
    el('p', 'note', 'CLASSIC STRIKE is a browser tactical shooter inspired by the gameplay of early-2000s round-based shooters: buy phase, economy, recoil you learn to control, and one life per round.', p);
    el('p', 'note', 'All code, the "Depot" map, models, textures and sounds are original — textures and audio are generated procedurally at runtime. It is not affiliated with or endorsed by Valve or any other publisher, and contains none of their assets.', p);
    el('p', 'note', 'Built with TypeScript, Vite, Three.js and the Web Audio API.', p);
    const act = el('div', 'actions', undefined, p);
    button('Back', 'btn primary', () => (this.host.click(), this.main()), act).focus();
  }

  pause(handlers: { resume(): void; settings(): void; controls(): void; restartRound(): void; restartMatch(): void; quit(): void }, online?: { room: string; switchTeam(): void }): void {
    const s = this.screen(true);
    const m = el('div', 'panel', undefined, s);
    m.style.width = '360px';
    el('h2', '', online ? `Menu — room ${online.room} (match continues)` : 'Paused', m);
    const b = (label: string, fn: () => void) => button(label, 'menu-btn', () => (this.host.click(), fn()), m);
    b('Resume', handlers.resume).focus();
    b('Settings', handlers.settings);
    b('Controls', handlers.controls);
    if (online) {
      const copy = b('Copy Invitation Link', async () => {
        copy.textContent = (await copyText(inviteLink(online.room))) ? 'Link copied' : inviteLink(online.room);
      });
      b('Switch Team (warmup only)', online.switchTeam);
      b('Leave Match', handlers.quit);
    } else {
      b('Restart Round', handlers.restartRound);
      b('Restart Match', handlers.restartMatch);
      b('Main Menu', handlers.quit);
    }
  }

  message(title: string, text: string, onOk: () => void): void {
    const s = this.screen(true);
    const p = el('div', 'panel', undefined, s);
    p.style.width = '420px';
    el('h2', '', title, p);
    el('p', 'note', text, p);
    const act = el('div', 'actions', undefined, p);
    button('OK', 'btn primary', () => (this.host.click(), onOk()), act).focus();
  }

  matchEnd(winner: Team | null, me: Team, score: Record<Team, number>, handlers: { rematch(): void; quit(): void }): void {
    const s = this.screen(true);
    const p = el('div', 'panel', undefined, s);
    p.style.width = '420px';
    el('h2', '', winner === me ? 'Victory' : winner ? 'Defeat' : 'Match over', p);
    el('p', 'note', `${winner ? TEAM_NAME[winner] + ' win the match' : 'Draw'} — ${TEAM_NAME.A} ${score.A} : ${score.D} ${TEAM_NAME.D}`, p);
    const act = el('div', 'actions', undefined, p);
    button('Main Menu', 'btn', () => (this.host.click(), handlers.quit()), act);
    button('Rematch', 'btn primary', () => (this.host.click(), handlers.rematch()), act).focus();
  }

  clickToPlay(text: string | undefined, onClick: () => void): void {
    const s = this.screen(true);
    s.classList.add('clickplay');
    s.classList.remove('screen', 'over-game');
    const box = el('div', 'box', undefined, s);
    el('b', '', 'CLICK TO PLAY', box);
    el('p', '', text ?? 'Your mouse will be captured for aiming. Press Esc at any time to pause and release it.', box);
    el('p', '', 'WASD move · Mouse aim · B buy · Tab scores', box);
    s.addEventListener('click', onClick);
  }
}
