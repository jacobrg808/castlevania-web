import Phaser from 'phaser';
import { MenuScene } from './scenes/MenuScene';
import { GameplayScene } from './scenes/GameplayScene';

// Original game renders at 512x448 (2x NES resolution).
// Top 64px is reserved for the HUD, the 512x384 below is the playfield.
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 512,
  height: 448,
  pixelArt: true,
  backgroundColor: '#000000',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 }, // gravity is applied per-entity, like the original
      debug: false,
    },
  },
  scene: [MenuScene, GameplayScene],
});

// Debugging handles for the browser console
(window as unknown as Record<string, unknown>).game = game;
import('./state').then((m) => {
  (window as unknown as Record<string, unknown>).gs = m.gameState;
});
