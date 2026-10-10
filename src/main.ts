import './ui/styles.css';
import { GameAudio } from './audio/audio';
import { GameSession, type SessionMode } from './game/session';
import type { NetClient } from './net/client';
import { MAPS } from './shared/maps/depot';
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
  startSolo: (cfg) => startSession({ kind: 'solo', cfg }),
  startOnline: (net, roundsToWin) => startOnlineSession(net, roundsToWin),
  click() {
    audio.unlock();
    audio.ui('click');
  },
});

function showPause(): void {
  if (!session) return;
  const s = session;
  const online = s.net ? { room: s.net.room, switchTeam: () => s.requestTeam(s.me.team === 'A' ? 'D' : 'A') } : undefined;
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
  }, online);
}

function startOnlineSession(net: NetClient, roundsToWin: number): void {
  startSession({ kind: 'online', net, you: net.you, map: MAPS[0], roundsToWin });
}

function startSession(mode: SessionMode): void {
  if (!webglAvailable()) {
    alert('Classic Strike needs WebGL, which is not available in this browser.');
    return;
  }
  session?.dispose();
  menus.clear();
  session = new GameSession(canvas, hudRoot, mode, settings, audio, {
    showDisconnected: (text) => {
      session?.dispose();
      session = null;
      menus.message('Disconnected', text, () => menus.main());
    },
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
  // Invitation links look like ?room=CODE.
const invited = new URLSearchParams(location.search).get('room');
if (invited && /^[A-Za-z2-9]{5}$/.test(invited)) menus.friend(invited.toUpperCase());
else menus.main();
}

// Invitation links look like ?room=CODE.
const invited = new URLSearchParams(location.search).get('room');
if (invited && /^[A-Za-z2-9]{5}$/.test(invited)) menus.friend(invited.toUpperCase());
else menus.main();
