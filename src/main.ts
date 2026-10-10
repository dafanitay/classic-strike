import './ui/styles.css';
import { GameAudio } from './audio/audio';
import { GameSession, type SoloConfig } from './game/session';
import { loadSettings, saveSettings, type Settings } from './settings';
import { Menus } from './ui/menu';

/**
 * App shell: switches between the menus and a running game session, and
 * wires session UI requests (pause, match end, click-to-play) to menus.
 */
const canvas = document.getElementById('game') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLElement;
const screens = document.getElementById('screens') as HTMLElement;
const audio = new GameAudio();
let settings: Settings = loadSettings();
let session: GameSession | null = null;

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const menus = new Menus({
  root: screens,
  get settings() {
    return settings;
  },
  saveSettings(s) {
    settings = s;
    saveSettings(s);
    audio.setVolumes(s.masterVolume, s.sfxVolume);
  },
  startSolo,
  click() {
    audio.unlock();
    audio.ui('click');
  },
});

function showPause(): void {
  if (!session) return;
  const s = session;
  menus.pause({
    resume: () => s.play(),
    settings: () => menus.settings(showPause, true, (ns) => s.applySettings(ns)),
    controls: () => menus.controls(showPause, true),
    restartRound: () => {
      s.restartRound();
      s.play();
    },
    restartMatch: () => {
      s.restartMatch();
      s.play();
    },
    quit: quitToMenu,
  });
}

function startSolo(cfg: SoloConfig): void {
  if (!webglAvailable()) {
    alert('Classic Strike needs WebGL, which is not available in this browser.');
    return;
  }
  session?.dispose();
  menus.clear();
  session = new GameSession(canvas, hudRoot, cfg, settings, audio, {
    showPause: (open) => (open ? showPause() : menus.clear()),
    showClickToPlay: (open, text) => {
      if (!open) return menus.clear();
      menus.clickToPlay(text, () => session?.play());
    },
    showMatchEnd: (winner, me, score) =>
      menus.matchEnd(winner, me, score, {
        rematch: () => {
          session?.restartMatch();
          session?.play();
        },
        quit: quitToMenu,
      }),
  });
  // Exposed for automated browser tests (see tests/e2e). Harmless in play.
  if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __cs: GameSession }).__cs = session;
  session.play();
}

function quitToMenu(): void {
  session?.dispose();
  session = null;
  menus.main();
}

menus.main();
