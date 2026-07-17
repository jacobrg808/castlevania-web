import Phaser from 'phaser';

/**
 * A door between two stage sections (Great Hall). Solid until its cutscene
 * runs; afterwards it stays closed and permanently solid — there is no going
 * back (the original replaces it with a wall block).
 */
export class Door extends Phaser.Physics.Arcade.Sprite {
  used = false;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'door', 'open_01');
    scene.add.existing(this);
    scene.physics.add.existing(this, true); // static, solid
    this.setOrigin(0.5, 1);
    (this.body as Phaser.Physics.Arcade.StaticBody).updateFromGameObject();
    this.setDepth(8);
    this.play('door/normal');
  }

  open(onComplete: () => void): void {
    this.scene.sound.play('sfx/Using_Door');
    this.once(Phaser.Animations.Events.ANIMATION_COMPLETE, onComplete);
    this.play('door/open');
  }

  close(onComplete: () => void): void {
    this.scene.sound.play('sfx/Using_Door');
    this.once(Phaser.Animations.Events.ANIMATION_COMPLETE, onComplete);
    this.play('door/close');
  }
}
