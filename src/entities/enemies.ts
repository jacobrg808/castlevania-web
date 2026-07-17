import Phaser from 'phaser';
import { gameState } from '../state';
import { Item, ITEM_DEFS } from './Item';
import type { Simon } from './Simon';

const GRAVITY = 23 * 60;
const DESPAWN_MARGIN = 96;

// 20% chance an enemy drops a random powerup (PowerupGenerator.cpp)
const DROP_CHANCE = 20;
const DROP_TABLE: [number, string[]][] = [
  [70, ['RedMoneyBag', 'BlueMoneyBag', 'SmallHeart']],
  [25, ['WhiteMoneyBag', 'AxeItem', 'DaggerItem', 'HolyWaterItem', 'LargeHeart']],
  [5, ['Cross', 'InvisibleJar', 'PorkChop', 'Stopwatch', 'DoubleShot']],
];

export interface EnemyScene extends Phaser.Scene {
  dropItem(x: number, y: number, itemId: string): Item;
  getSimon(): Simon | null;
  isStopwatchActive(): boolean;
}

export abstract class Enemy extends Phaser.Physics.Arcade.Sprite {
  health: number;
  readonly attackPower: number;
  readonly exp: number;
  readonly speed: number;
  collidesWithTerrain = true;
  protected dying = false;

  protected get gameScene(): EnemyScene {
    return this.scene as EnemyScene;
  }

  constructor(
    scene: Phaser.Scene, x: number, y: number, texture: string, frame: string,
    stats: { health: number; attack: number; exp: number; speed: number },
  ) {
    super(scene, x, y, texture, frame);
    this.health = stats.health;
    this.attackPower = stats.attack;
    this.exp = stats.exp;
    this.speed = stats.speed;
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(9);
    this.setGravityY(GRAVITY);
    this.setMaxVelocity(Number.MAX_VALUE, 1000);
  }

  get alive(): boolean {
    return !this.dying && this.active;
  }

  /** Frozen by the stopwatch subweapon: the body holds still, AI is paused. */
  get frozen(): boolean {
    return this.gameScene.isStopwatchActive?.() ?? false;
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    const body = this.body as Phaser.Physics.Arcade.Body;
    if (body) body.moves = !this.frozen;
  }

  private lastAttackId = -1;

  /**
   * attackId dedupes the whip's extended frame, which overlaps for several
   * physics steps — one whip crack must deal damage only once.
   */
  takeDamage(damage: number, attackId?: number): void {
    if (this.dying) return;
    if (attackId !== undefined) {
      if (attackId === this.lastAttackId) return;
      this.lastAttackId = attackId;
    }
    this.showSpark();
    this.health -= damage;
    if (this.health <= 0) this.die();
  }

  private showSpark(): void {
    const spark = this.scene.add.image(this.x - 4, this.y - this.displayHeight / 2 - 4, 'spark').setDepth(12);
    this.scene.time.delayedCall(140, () => spark.destroy());
  }

  protected die(): void {
    this.dying = true;
    gameState.score += this.exp;
    this.scene.sound.play('sfx/Hitting_Something');

    const flame = this.scene.add.sprite(this.x, this.y - this.displayHeight / 2, 'flame').setDepth(9);
    flame.play('flame/Flame');
    flame.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => flame.destroy());

    if (Phaser.Math.Between(1, 100) <= DROP_CHANCE) {
      let roll = Phaser.Math.Between(1, 100);
      for (const [chance, ids] of DROP_TABLE) {
        if (roll <= chance) {
          const id = Phaser.Utils.Array.GetRandom(ids.filter((i) => ITEM_DEFS[i]));
          this.gameScene.dropItem(this.x, this.y - this.displayHeight, id);
          break;
        }
        roll -= chance;
      }
    }

    this.destroy();
  }

  /** Despawn silently once fully outside the camera view (like the original). */
  protected despawnIfOffscreen(): boolean {
    const view = this.scene.cameras.main.worldView;
    const b = this.getBounds();
    if (
      b.right < view.left - DESPAWN_MARGIN || b.left > view.right + DESPAWN_MARGIN ||
      b.bottom < view.top - DESPAWN_MARGIN || b.top > view.bottom + DESPAWN_MARGIN
    ) {
      this.destroy();
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------

export class Zombie extends Enemy {
  constructor(scene: Phaser.Scene, x: number, y: number, facing: -1 | 1) {
    super(scene, x, y, 'zombie', 'walk_01', { health: 1, attack: 2, exp: 100, speed: 115 });
    this.setOrigin(0.5, 1);
    this.body!.setSize(24, 56);
    (this.body as Phaser.Physics.Arcade.Body).setOffset(5, 8);
    this.setFlipX(facing === -1);
    this.play('zombie/walk');
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.alive || this.frozen || this.despawnIfOffscreen()) return;
    const body = this.body as Phaser.Physics.Arcade.Body;
    // walks in its facing direction; stops horizontally while airborne
    body.setVelocityX(body.blocked.down ? (this.flipX ? -this.speed : this.speed) : 0);
  }
}

// ---------------------------------------------------------------------------

enum PantherState { IDLE, RUNNING, JUMPING }

export class Panther extends Enemy {
  private aiState = PantherState.IDLE;
  private static readonly ZONE_W = 250;
  private static readonly ZONE_H = 410;
  private static readonly JUMP_SPEED = 200;

  constructor(scene: Phaser.Scene, x: number, y: number, facing: -1 | 1) {
    super(scene, x, y, 'panther', 'idle_01', { health: 1, attack: 2, exp: 200, speed: 350 });
    this.setOrigin(0.5, 1);
    this.body!.setSize(56, 30);
    (this.body as Phaser.Physics.Arcade.Body).setOffset(4, 4);
    this.setFlipX(facing === -1);
    this.play('panther/idle');
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.alive || this.frozen || this.despawnIfOffscreen()) return;

    const simon = this.gameScene.getSimon();
    if (!simon) return;
    const body = this.body as Phaser.Physics.Arcade.Body;
    const dir: -1 | 1 = simon.x <= this.x ? -1 : 1;

    switch (this.aiState) {
      case PantherState.IDLE: {
        // pounce when Simon enters the active zone centered on the panther
        const zone = new Phaser.Geom.Rectangle(
          this.x - Panther.ZONE_W / 2, this.y - this.displayHeight / 2 - Panther.ZONE_H / 2,
          Panther.ZONE_W, Panther.ZONE_H,
        );
        if (zone.contains(simon.x, simon.y - 30)) this.run(dir);
        break;
      }
      case PantherState.RUNNING:
        if (!body.blocked.down) {
          // leapt off a ledge: arc with current horizontal speed
          this.setVelocityY(-Panther.JUMP_SPEED);
          this.aiState = PantherState.JUMPING;
          this.play('panther/jump');
        }
        break;
      case PantherState.JUMPING:
        if (body.blocked.down) this.run(dir);
        break;
    }
  }

  private run(dir: -1 | 1): void {
    this.aiState = PantherState.RUNNING;
    this.setFlipX(dir === -1);
    this.setVelocityX(this.speed * dir);
    this.play('panther/run', true);
  }
}

// ---------------------------------------------------------------------------

enum FishmanState { LAUNCHING, FALLING, WALKING, SHOOTING }

const SHOOTING_TIME = 600;
const RELEASE_FIREBALL_TIME = SHOOTING_TIME / 2;

export class Fishman extends Enemy {
  private aiState = FishmanState.LAUNCHING;
  private shootTimer = Phaser.Math.Between(1500, 3000);
  private shootingElapsed = 0;
  private fireballReleased = false;
  private static readonly LAUNCH_SPEED = 800;

  constructor(scene: Phaser.Scene, x: number, y: number, facing: -1 | 1) {
    super(scene, x, y, 'fishman', 'walk_01', { health: 1, attack: 2, exp: 300, speed: 75 });
    this.setOrigin(0.5, 1);
    this.body!.setSize(28, 56);
    (this.body as Phaser.Physics.Arcade.Body).setOffset(10, 8);
    this.setFlipX(facing === -1);
    this.collidesWithTerrain = true;
    this.play('fishman/walk');

    // burst out of the water
    this.setVelocityY(-Fishman.LAUNCH_SPEED);
    scene.sound.play('sfx/Fishman_Launching');
    const splash = scene.add.image(x, y, 'water_splash').setDepth(9);
    scene.time.delayedCall(250, () => splash.destroy());
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.alive || this.frozen || this.despawnIfOffscreen()) return;
    const body = this.body as Phaser.Physics.Arcade.Body;

    switch (this.aiState) {
      case FishmanState.LAUNCHING:
        if (body.velocity.y >= 0) this.aiState = FishmanState.FALLING;
        break;

      case FishmanState.FALLING:
        if (body.blocked.down) this.walk(this.flipX ? -1 : 1);
        break;

      case FishmanState.WALKING:
        body.setVelocityX(this.flipX ? -this.speed : this.speed);
        this.shootTimer -= delta;
        if (this.shootTimer <= 0 && body.blocked.down) this.startShooting();
        break;

      case FishmanState.SHOOTING:
        this.shootingElapsed += delta;
        if (!this.fireballReleased && this.shootingElapsed >= RELEASE_FIREBALL_TIME) {
          this.fireballReleased = true;
          const dir: -1 | 1 = this.flipX ? -1 : 1;
          this.scene.events.emit('fireball', this.x + dir * 14, this.y - this.displayHeight + 30, dir);
        }
        if (this.shootingElapsed >= SHOOTING_TIME) {
          this.walk(this.flipX ? 1 : -1); // turn around after shooting
        }
        break;
    }
  }

  private walk(dir: -1 | 1): void {
    this.aiState = FishmanState.WALKING;
    this.setFlipX(dir === -1);
    this.setVelocityX(this.speed * dir);
    this.play('fishman/walk', true);
    this.shootTimer = Phaser.Math.Between(1500, 3000);
  }

  private startShooting(): void {
    this.aiState = FishmanState.SHOOTING;
    this.shootingElapsed = 0;
    this.fireballReleased = false;
    this.setVelocityX(0);
    this.play('fishman/shoot', true);
  }
}

// ---------------------------------------------------------------------------

export class VampireBat extends Enemy {
  private angularRotation = 0;
  private static readonly ANGULAR_VELOCITY = 0.2; // deg per ms, from WaveMovementSystem
  private static readonly WAVE_AMPLITUDE = 60; // px/s peak vertical speed

  constructor(scene: Phaser.Scene, x: number, y: number, facing: -1 | 1) {
    super(scene, x, y, 'vampire_bat', 'fly_01', { health: 1, attack: 2, exp: 200, speed: 135 });
    this.setOrigin(0.5, 0.5);
    this.body!.setSize(30, 16);
    this.collidesWithTerrain = false;
    (this.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
    this.setGravityY(0);
    this.setFlipX(facing === -1);
    this.setVelocityX(this.speed * facing);
    this.play('vampire_bat/fly');
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.alive || this.frozen || this.despawnIfOffscreen()) return;
    // sine-wave flight ported from WaveMovementSystem
    this.angularRotation += VampireBat.ANGULAR_VELOCITY * delta;
    this.setVelocityY(VampireBat.WAVE_AMPLITUDE * Math.sin(Phaser.Math.DegToRad(this.angularRotation)));
  }
}

// ---------------------------------------------------------------------------

export class Fireball extends Phaser.Physics.Arcade.Sprite {
  readonly attackPower = 2;

  constructor(scene: Phaser.Scene, x: number, y: number, dir: -1 | 1, vy = 0) {
    super(scene, x, y, 'fireball', 'fire_ball');
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(9);
    (this.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
    this.setFlipX(dir === -1);
    this.setVelocityX(300 * dir);
    this.setVelocityY(vy);
  }

  /** Aim at a target: velocity = normalize(target - origin) * 300. */
  static aimed(scene: Phaser.Scene, x: number, y: number, tx: number, ty: number): Fireball {
    const dir = new Phaser.Math.Vector2(tx - x, ty - y).normalize().scale(300);
    const fireball = new Fireball(scene, x, y, dir.x < 0 ? -1 : 1, dir.y);
    fireball.setVelocityX(dir.x);
    return fireball;
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    // fireballs freeze in place under the stopwatch too
    const scene = this.scene as EnemyScene;
    (this.body as Phaser.Physics.Arcade.Body).moves = !(scene.isStopwatchActive?.() ?? false);
    const view = this.scene.cameras.main.worldView;
    if (this.x < view.left - 64 || this.x > view.right + 64 ||
        this.y < view.top - 64 || this.y > view.bottom + 64) this.destroy();
  }
}

// ---------------------------------------------------------------------------
// The Giant Bat boss, ported from GiantBat.cpp + GiantBatControlSystem.cpp +
// GiantBatMovementSystem.cpp.

enum BatState { IDLE, FLYING, HOVERING, RISING, DIVING, SHOOTING }

const BAT_MIN_DIVING_RANGE = 10;
const BAT_DIVING_ADJUSTED_DISTANCE = 40;
const BAT_RISING_SPEED = 250;
const BAT_SHOOTING_TIME = 1700; // wind-up before the aimed fireball flies
const BAT_MIN_HOVER = 500;
const BAT_MAX_HOVER = 2500;
const BAT_MIN_FLY = 70;
const BAT_MAX_FLY = 230;
const BAT_DIVE_SPEED = 275;
const THREAT_ZONE_W = 120;
const THREAT_ZONE_H = 80;
const ATTACK_ZONE_W = 650;
const ATTACK_ZONE_H = 900;

export class GiantBat extends Enemy {
  private aiState = BatState.IDLE;
  private moveArea = new Phaser.Geom.Rectangle(0, 0, 512, 384);
  private minSpeed: number;
  private maxSpeed: number;

  private flyingDistance = 0;
  private hoverTime = 0;
  private hoverElapsed = 0;
  private shootElapsed = 0;
  // parabolic dive: y = a(x - h)^2 + k, vertex (h, k) = Simon's position
  private diveVertex = new Phaser.Math.Vector2();
  private diveA = 0;
  private diveSpeedX = 0;
  private diveDir: -1 | 1 = 1;
  private heightToStopDiving = 0;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'giant_bat', 'idle_01', { health: 16, attack: 2, exp: 3000, speed: 150 });
    this.setOrigin(0.5, 0.5);
    this.body!.setSize(60, 40);
    this.collidesWithTerrain = false;
    (this.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
    this.setGravityY(0);
    this.play('giant_bat/idle');
    this.minSpeed = Math.max(this.speed - 75, 50);
    this.maxSpeed = Math.min(this.speed + 70, 500);
  }

  get isAwake(): boolean {
    return this.aiState !== BatState.IDLE;
  }

  /** Wake up and start fighting inside the given (camera-locked) area. */
  activate(moveArea: Phaser.Geom.Rectangle): void {
    this.moveArea = moveArea;
    this.play('giant_bat/fly');
    if (Phaser.Math.Between(0, 1)) this.hover();
    else this.moveRandomly();
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.alive || this.frozen) return;
    const simon = this.gameScene.getSimon();
    if (!simon || this.aiState === BatState.IDLE) return;
    const body = this.body as Phaser.Physics.Arcade.Body;
    const simonPos = new Phaser.Math.Vector2(simon.x, simon.y - 30);

    // an approaching player inside the threat zone triggers an instant dive
    if (this.aiState !== BatState.DIVING && this.aiState !== BatState.RISING) {
      const threat = new Phaser.Geom.Rectangle(
        this.x - THREAT_ZONE_W / 2, this.y - THREAT_ZONE_H / 2, THREAT_ZONE_W, THREAT_ZONE_H);
      if (threat.contains(simonPos.x, simonPos.y)) this.dive(simonPos);
    }

    switch (this.aiState) {
      case BatState.FLYING:
        this.flyingDistance -= body.velocity.length() * (delta / 1000);
        if (this.flyingDistance <= 0) this.hover();
        else this.clampToMoveArea();
        break;

      case BatState.HOVERING:
        this.hoverElapsed += delta;
        if (this.hoverElapsed >= this.hoverTime) {
          const attackZone = new Phaser.Geom.Rectangle(
            this.x - ATTACK_ZONE_W / 2, this.y - ATTACK_ZONE_H / 2, ATTACK_ZONE_W, ATTACK_ZONE_H);
          if (!attackZone.contains(simonPos.x, simonPos.y)) this.startShooting();
          else this.dive(simonPos);
        }
        break;

      case BatState.RISING:
        if (this.diveVertex.y - this.y >= BAT_DIVING_ADJUSTED_DISTANCE) {
          this.setVelocity(0, 0);
          this.startDive();
        }
        break;

      case BatState.DIVING: {
        // follow the parabola through the player's position
        const x = this.x + this.diveDir * this.diveSpeedX * (delta / 1000);
        const y = this.diveA * (x - this.diveVertex.x) ** 2 + this.diveVertex.y;
        body.setVelocity((x - this.x) / (delta / 1000), (y - this.y) / (delta / 1000));
        this.setFlipX(x < this.x);
        // swooped past the bottom and rising again: break off
        if (y < this.y && this.y <= this.heightToStopDiving) {
          this.setVelocity(0, 0);
          this.moveRandomly();
        }
        break;
      }

      case BatState.SHOOTING:
        this.shootElapsed += delta;
        if (this.shootElapsed >= BAT_SHOOTING_TIME) {
          this.scene.events.emit('boss-fireball', this.x, this.y, simonPos.x, simonPos.y);
          this.hover();
        }
        break;
    }
  }

  private hover(): void {
    this.aiState = BatState.HOVERING;
    this.setVelocity(0, 0);
    this.hoverTime = Phaser.Math.Between(BAT_MIN_HOVER, BAT_MAX_HOVER);
    this.hoverElapsed = 0;
  }

  private startShooting(): void {
    this.aiState = BatState.SHOOTING;
    this.setVelocity(0, 0);
    this.shootElapsed = 0;
  }

  private dive(simonPos: Phaser.Math.Vector2): void {
    this.diveVertex.copy(simonPos);
    if (simonPos.y - this.y <= BAT_MIN_DIVING_RANGE) {
      // too low to swoop: rise first
      this.aiState = BatState.RISING;
      this.setVelocity(0, -BAT_RISING_SPEED);
    } else {
      this.startDive();
    }
  }

  private startDive(): void {
    const dx = this.diveVertex.x - this.x;
    const dy = this.diveVertex.y - this.y;
    if (Math.abs(dx) < 2) { this.moveRandomly(); return; } // degenerate parabola
    this.diveA = (this.y - this.diveVertex.y) / dx ** 2; // a = (y - k) / (x - h)^2
    this.diveDir = dx < 0 ? -1 : 1;
    this.setFlipX(this.diveDir === -1);
    this.diveSpeedX = BAT_DIVE_SPEED * Math.abs(Math.cos(Math.atan(dy / dx)));
    this.heightToStopDiving = this.y + Phaser.Math.Between(20, 40);
    this.aiState = BatState.DIVING;
  }

  private moveRandomly(): void {
    const simon = this.gameScene.getSimon();
    // the closer the player, the faster the boss flies
    let flySpeed = this.maxSpeed;
    if (simon) {
      const dist = Phaser.Math.Distance.Between(this.x, this.y, simon.x, simon.y);
      const weight = Phaser.Math.Clamp((dist - 32) / (352 - 32), 0, 1);
      flySpeed = Phaser.Math.Linear(this.maxSpeed, this.minSpeed, weight);
    }

    const belowPlayer = simon ? this.y >= simon.y - 30 : false;
    for (let tries = 0; tries < 20; tries++) {
      // if below the player, bias upward (original: 225°-315°)
      const angle = belowPlayer
        ? Phaser.Math.FloatBetween(Math.PI * 1.25, Math.PI * 1.75)
        : Phaser.Math.FloatBetween(0, Math.PI * 2);
      const dir = new Phaser.Math.Vector2(Math.cos(angle), Math.sin(angle));
      const distance = Phaser.Math.Between(BAT_MIN_FLY, BAT_MAX_FLY);
      const destX = this.x + dir.x * distance;
      const destY = this.y + dir.y * distance;
      if (this.moveArea.contains(destX, destY)) {
        this.aiState = BatState.FLYING;
        this.flyingDistance = distance;
        this.setFlipX(dir.x < 0);
        this.setVelocity(dir.x * flySpeed, dir.y * flySpeed);
        return;
      }
    }
    this.hover();
  }

  private clampToMoveArea(): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    if (body.left <= this.moveArea.left + 4 && body.velocity.x < 0) {
      body.velocity.x = Math.abs(body.velocity.x);
      this.setFlipX(false);
    }
    if (body.right >= this.moveArea.right - 4 && body.velocity.x > 0) {
      body.velocity.x = -Math.abs(body.velocity.x);
      this.setFlipX(true);
    }
    if (body.top <= this.moveArea.top + 4 && body.velocity.y < 0) body.velocity.y = Math.abs(body.velocity.y);
    if (body.bottom >= this.moveArea.bottom - 4 && body.velocity.y > 0) body.velocity.y = -Math.abs(body.velocity.y);
  }

  /** Boss death: bigger pyre, no random drop — the scene drops the crystal ball. */
  protected die(): void {
    this.dying = true;
    gameState.score += this.exp;
    const scene = this.scene; // survives this.destroy() below
    scene.sound.play('sfx/Hitting_Something');
    for (let i = 0; i < 3; i++) {
      const flame = scene.add.sprite(
        this.x + (i - 1) * 20, this.y + (i % 2 === 0 ? -10 : 10), 'flame').setDepth(9);
      scene.time.delayedCall(i * 120, () => {
        flame.play('flame/FlameLoop');
        scene.time.delayedCall(500, () => flame.destroy());
      });
    }
    scene.events.emit('boss-died', this.x, this.y);
    this.destroy();
  }
}
