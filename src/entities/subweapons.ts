import Phaser from 'phaser';

const GRAVITY = 23 * 60;
const HOLY_WATER_FLAMING_TIME = 1400; // ms the broken vial burns

// Shared counter so whip cracks and projectiles never reuse a damage-dedup id
let attackIdCounter = 0;
export function nextAttackId(): number {
  return ++attackIdCounter;
}

export abstract class SubweaponProjectile extends Phaser.Physics.Arcade.Sprite {
  readonly attackPower: number;
  readonly pierces: boolean;
  readonly attackId = nextAttackId();

  constructor(
    scene: Phaser.Scene, x: number, y: number, texture: string, frame: string,
    opts: { attack: number; pierces: boolean },
  ) {
    super(scene, x, y, texture, frame);
    this.attackPower = opts.attack;
    this.pierces = opts.pierces;
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(11);
  }

  /** Holy water reacts to hitting the ground; others ignore terrain. */
  onHitGround(): void {}

  get isDamaging(): boolean {
    return true;
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    const view = this.scene.cameras.main.worldView;
    if (this.x < view.left - 64 || this.x > view.right + 64 || this.y > view.bottom + 64) {
      this.destroy();
    }
  }
}

/** Flies straight and fast; consumed by the first thing it hits. */
export class DaggerProjectile extends SubweaponProjectile {
  constructor(scene: Phaser.Scene, x: number, y: number, facing: -1 | 1) {
    super(scene, x, y, 'dagger', 'dagger', { attack: 2, pierces: false });
    (this.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
    this.setFlipX(facing === -1);
    this.setVelocityX(700 * facing);
    scene.sound.play('sfx/Throwing_Dagger');
  }
}

/** Heaved up in a heavy arc, spinning, passing through walls and enemies. */
export class AxeProjectile extends SubweaponProjectile {
  constructor(scene: Phaser.Scene, x: number, y: number, facing: -1 | 1) {
    super(scene, x, y, 'axe_weapon', 'axe_01', { attack: 2, pierces: true });
    this.setGravityY(GRAVITY);
    this.setMaxVelocity(Number.MAX_VALUE, 2000);
    this.setVelocity(150 * facing, -625);
    this.play('axe_weapon/axe');
    scene.sound.play('sfx/Using_Weapon');
  }
}

/** Lobbed forward; shatters on the ground into a burning flame. */
export class HolyWaterProjectile extends SubweaponProjectile {
  private flaming = false;
  private flamingElapsed = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, facing: -1 | 1) {
    super(scene, x, y, 'holy_water_weapon', 'holy_water_01', { attack: 1, pierces: true });
    this.setGravityY(GRAVITY);
    this.setFlipX(facing === -1);
    this.setVelocity(275 * facing, -150);
    scene.sound.play('sfx/Using_Weapon');
  }

  get isFlaming(): boolean {
    return this.flaming;
  }

  /** Only the burning pool damages enemies, not the flying vial. */
  get isDamaging(): boolean {
    return this.flaming;
  }

  onHitGround(): void {
    if (this.flaming) return;
    this.flaming = true;
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    body.setAllowGravity(false);
    this.setGravityY(0);
    this.play('holy_water_weapon/holy_water_flame');
    this.scene.sound.play('sfx/Holy_Water_Touching_Ground');
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.active) return;
    if (this.flaming) {
      this.flamingElapsed += delta;
      if (this.flamingElapsed >= HOLY_WATER_FLAMING_TIME) this.destroy();
    }
  }
}
