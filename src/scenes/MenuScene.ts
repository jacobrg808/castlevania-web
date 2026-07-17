import Phaser from 'phaser';
import { resetGameState } from '../state';
import { registerAnimations, type AnimDef } from '../util/anims';

/**
 * The classic title screen (MenuScene.cpp): Main_Menu background, the bat
 * flapping over the castle, PUSH START KEY. Enter/Space starts the game.
 */
export class MenuScene extends Phaser.Scene {
  private starting = false;

  constructor() {
    super('menu');
  }

  preload(): void {
    this.load.setPath('assets');
    this.load.image('main_menu', 'sprites/main_menu.png');
    this.load.atlas('menu_bat', 'sprites/menu_bat.png', 'sprites/menu_bat.atlas.json');
    this.load.json('menu_bat.anims', 'sprites/menu_bat.anims.json');
    this.load.audio('music/Prologue', 'audio/music/Game_Start_Prologue.wav');
  }

  create(): void {
    this.starting = false;
    registerAnimations(this, 'menu_bat', this.cache.json.get('menu_bat.anims') as AnimDef[]);

    this.add.image(0, 0, 'main_menu').setOrigin(0, 0);
    this.add.sprite(367, 191, 'menu_bat').setOrigin(0, 0).play('menu_bat/hover');

    const startText = this.add.text(256, 262, 'PUSH START KEY', {
      fontFamily: 'monospace', fontSize: '16px', color: '#ffffff',
    }).setOrigin(0.5);
    this.time.addEvent({
      delay: 500, loop: true,
      callback: () => { if (!this.starting) startText.setVisible(!startText.visible); },
    });

    this.add.text(256, 330,
      '     TM AND (C) 1987\nKONAMI INDUSTRY CO.,LTD.\n      LICENSED BY\nNINTENDO OF AMERICA INC.',
      { fontFamily: 'monospace', fontSize: '13px', color: '#ffffff', align: 'left', lineSpacing: 6 },
    ).setOrigin(0.5, 0);

    this.input.keyboard!.on('keydown-ENTER', () => this.startGame());
    this.input.keyboard!.on('keydown-SPACE', () => this.startGame());
  }

  private startGame(): void {
    if (this.starting) return;
    this.starting = true;
    resetGameState();

    const begin = () => this.sound.play('music/Prologue', { volume: 0.5 });
    if (this.sound.locked) this.sound.once(Phaser.Sound.Events.UNLOCKED, begin);
    else begin();

    // blink the prompt fast during the transition, like the original's 800ms
    const startText = this.children.list.find(
      (c) => c.type === 'Text' && (c as Phaser.GameObjects.Text).text === 'PUSH START KEY',
    ) as Phaser.GameObjects.Text | undefined;
    this.time.addEvent({
      delay: 80, repeat: 9,
      callback: () => startText?.setVisible(!startText.visible),
    });
    this.time.delayedCall(800, () => {
      this.cameras.main.fadeOut(300, 0, 0, 0);
      this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
        this.scene.start('gameplay', { map: 'courtyard', spawn: 'Entrypoint' });
      });
    });
  }
}
