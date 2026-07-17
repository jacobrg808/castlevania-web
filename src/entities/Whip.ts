import Phaser from 'phaser';
import { gameState } from '../state';
import { nextAttackId } from './subweapons';
import type { Simon } from './Simon';

/**
 * Simon's whip. Its animation frame is driven by Simon's attack animation so
 * the two always stay in sync, and its position per frame is ported from
 * WhipRenderingSystem::UpdatePositionRelativeToPlayer().
 */
export class Whip extends Phaser.GameObjects.Sprite {
  facing: -1 | 1 = 1;
  /** increments per unleash so one whip crack deals damage only once */
  attackId = 0;

  private owner: Simon;
  private flashColor = 2; // index into LEVEL3_COLORS
  private static readonly LEVEL3_COLORS = ['magenta', 'red', 'yellow', 'blue'] as const;

  constructor(scene: Phaser.Scene, owner: Simon) {
    super(scene, 0, 0, 'whip', 'whip_level_1_01');
    scene.add.existing(this);
    this.owner = owner;
    this.setOrigin(0, 0);
    this.setDepth(11);
    this.setVisible(false);
  }

  unleash(): void {
    this.attackId = nextAttackId(); // shared counter with projectiles
    this.setVisible(true);
    this.updatePosition();
  }

  withdraw(): void {
    this.setVisible(false);
  }

  /** Attack frame index 0..2, taken from Simon's current attack animation. */
  get frameIndex(): number {
    const anim = this.owner.anims;
    if (!anim.currentAnim?.key.includes('attack')) return 0;
    return anim.currentFrame?.index != null ? anim.currentFrame.index - 1 : 0;
  }

  /** Whip deals damage only on the fully-extended frame of an active attack. */
  get isHitFrame(): boolean {
    return this.visible && this.owner.isAttacking && this.frameIndex === 2;
  }

  getHitbox(): Phaser.Geom.Rectangle {
    return this.getBounds();
  }

  updatePosition(): void {
    if (!this.visible) return;

    const i = this.frameIndex;
    // level 1 = leather, 2 = chain, 3 = long chain flashing a random
    // different color every frame (WhipFlashingRenderingSystem)
    let prefix: string;
    if (gameState.whipLevel === 1) prefix = 'whip_level_1';
    else if (gameState.whipLevel === 2) prefix = 'whip_level_2';
    else {
      let next: number;
      do { next = Phaser.Math.Between(0, 3); } while (next === this.flashColor);
      this.flashColor = next;
      prefix = `whip_level_3_${Whip.LEVEL3_COLORS[next]}`;
    }
    this.setFrame(`${prefix}_0${i + 1}`);
    this.setFlipX(this.facing === -1);

    const body = this.owner.body as Phaser.Physics.Arcade.Body;
    const w = this.frame.realWidth;
    const h = this.frame.realHeight;

    if (this.facing === 1) {
      switch (i) {
        case 0: this.setPosition(body.left - w + 1, body.top + 14); break;
        case 1: this.setPosition(body.left - w, body.top + 9); break;
        case 2: this.setPosition(body.right + 8, body.top + 26 - h); break;
      }
    } else {
      switch (i) {
        case 0: this.setPosition(body.right - 1, body.top + 14); break;
        case 1: this.setPosition(body.right, body.top + 9); break;
        case 2: this.setPosition(body.left - 8 - w, body.top + 26 - h); break;
      }
    }
  }
}
