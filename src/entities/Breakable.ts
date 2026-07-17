import Phaser from 'phaser';
import type { Item } from './Item';

export interface BreakableScene extends Phaser.Scene {
  dropItem(x: number, y: number, itemId: string): Item;
}

/**
 * A solid 32x32 block destroyed by the whip: debris flies, the hidden item
 * spawns immediately (Container with SpawningState DYING in the original).
 * Breakable walls are two stacked blocks; hits always break the bottom one
 * first (BreakableWall::TakeDamage).
 */
export class BreakableBlock extends Phaser.Physics.Arcade.Sprite {
  /** wall pairing: redirect hits here while this block still stands */
  breakFirst: BreakableBlock | null = null;
  private itemId: string | null;
  private broken = false;
  private lastAttackId = -1;

  constructor(scene: Phaser.Scene, x: number, y: number, texture: string, itemId: string | null) {
    super(scene, x, y, texture);
    this.itemId = itemId;
    scene.add.existing(this);
    scene.physics.add.existing(this, true); // static, solid
    this.setOrigin(0.5, 1);
    (this.body as Phaser.Physics.Arcade.StaticBody).updateFromGameObject();
    this.setDepth(4);
  }

  get alive(): boolean {
    return !this.broken && this.active;
  }

  hit(attackId?: number): void {
    if (!this.alive) return;
    // one whip crack overlaps for several frames; deal with it exactly once
    if (attackId !== undefined) {
      if (attackId === this.lastAttackId) return;
      this.lastAttackId = attackId;
    }
    // the wall's bottom block takes the hit while it stands
    if (this.breakFirst?.alive) {
      this.breakFirst.hit(attackId);
      return;
    }
    this.broken = true;

    const scene = this.scene as BreakableScene;
    scene.sound.play('sfx/Hitting_Breakable_Block');

    // four tumbling debris fragments launched outward under gravity
    const cx = this.x;
    const cy = this.y - this.displayHeight / 2;
    for (const [vx, vy] of [[-80, -280], [80, -320], [-140, -180], [140, -240]] as const) {
      const piece = scene.physics.add.image(cx, cy, 'debris').setDepth(12);
      piece.setGravityY(23 * 60);
      piece.setVelocity(vx, vy);
      piece.setAngularVelocity(vx * 4);
      scene.time.delayedCall(700, () => piece.destroy());
    }

    if (this.itemId) scene.dropItem(cx, cy, this.itemId);
    this.destroy();
  }
}
