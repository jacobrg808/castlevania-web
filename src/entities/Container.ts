import Phaser from 'phaser';
import { Item, ITEM_DEFS } from './Item';

/**
 * A whippable container (brazier or candle). When hit it burns away in a
 * flame effect and drops its configured item, which falls to the ground.
 */
export class Container extends Phaser.Physics.Arcade.Sprite {
  private itemId: string | null;
  private dead = false;

  constructor(scene: Phaser.Scene, x: number, y: number, kind: 'brazier' | 'candle', itemId: string | null) {
    super(scene, x, y, kind);
    this.itemId = itemId && ITEM_DEFS[itemId] ? itemId : null;
    scene.add.existing(this);
    scene.physics.add.existing(this, true); // static body
    this.setOrigin(0.5, 1);
    (this.body as Phaser.Physics.Arcade.StaticBody).updateFromGameObject();
    this.setDepth(5);
    this.play(`${kind}/Fire`);
  }

  /** Whip hit: burn away and drop the item. */
  hit(): void {
    if (this.dead) return;
    this.dead = true;

    this.scene.sound.play('sfx/Hitting_Something');

    const cx = this.x;
    const cy = this.y - this.displayHeight / 2;

    const flame = this.scene.add.sprite(cx, cy, 'flame').setDepth(7);
    flame.play('flame/Flame');
    flame.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => flame.destroy());

    if (this.itemId) {
      const item = new Item(this.scene, cx, cy, this.itemId);
      this.emit('dropitem', item);
    }

    this.destroy();
  }
}
