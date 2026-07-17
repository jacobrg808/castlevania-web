import Phaser from 'phaser';
import { gameState } from '../state';
import { Whip } from './Whip';

// Constants ported from the original C++ source.
// GRAVITY was 23 px/s added per frame at 60fps -> 1380 px/s^2 continuous.
const SPEED = 125;
const STAIR_SPEED = SPEED / 2;
const JUMP_SPEED = 470;
const GRAVITY = 23 * 60;
const HOVERING_GRAVITY = GRAVITY / 6;
const HOVERING_VELOCITY = 20;
const MAX_FALL_SPEED = 1000;
const LARGE_HEIGHT = 32 * 2.5; // fall distance that triggers a hard landing
const LANDING_TIME = 400; // ms
const FLASHING_TIME = 900; // ms, whip-powerup flash
const UNTOUCHABLE_TIME = 2000; // ms of invulnerability after taking damage
const BOUNCE_BACK_HEIGHT = 360; // knockback launch velocity
const THROWING_COOLDOWN_TIME = 1000; // ms between subweapon throws
const STOPWATCH_HEART_COST = 5;
const BEND_KNEE_ON_JUMPING_Y = 330;
const STRETCH_LEG_ON_FALLING_Y = 200;

export enum MoveState {
  IDLE,
  WALKING,
  JUMPING,
  HOVERING,
  FALLING,
  FALLING_HARD,
  LANDING,
  LANDING_HARD,
  DUCKING,
  WALKING_TO_STAIRS,
  GOING_UPSTAIRS,
  GOING_DOWNSTAIRS,
  IDLE_UPSTAIRS,
  IDLE_DOWNSTAIRS,
  FLASHING,
  TAKING_DAMAGE,
  DYING,
}

export enum AttackState {
  INACTIVE,
  WHIPPING,
  THROWING,
}

export interface StairTrigger {
  rect: Phaser.Geom.Rectangle;
  kind: 'up' | 'down';
  facing: -1 | 1;
}

type Boundaries = Record<string, { x: number; y: number; w: number; h: number }>;

export class Simon extends Phaser.Physics.Arcade.Sprite {
  moveState = MoveState.IDLE;
  attackState = AttackState.INACTIVE;
  controlsEnabled = true;
  readonly whip: Whip;

  private boundaries: Boundaries;
  private landingTimer = 0;
  private flashingTimer = 0;
  private untouchableTimer = 0;
  private throwingCooldown = 0;
  private throwReleased = false;
  private throwingWeapon: string | null = null;
  private subweaponShots = 1; // DoubleShot powerup refills 2 per cooldown
  private lastPlatformHeight = 0;
  private stairs: StairTrigger[] = [];
  private targetStair: StairTrigger | null = null;

  private keys: {
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    jump: Phaser.Input.Keyboard.Key;
    jumpAlt: Phaser.Input.Keyboard.Key;
    attack: Phaser.Input.Keyboard.Key;
  };

  constructor(scene: Phaser.Scene, x: number, y: number, facing: -1 | 1 = 1) {
    super(scene, x, y, 'simon', 'walk_01');
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.boundaries = scene.cache.json.get('simon.boundaries') as Boundaries;

    // Body matches walk_01's SpriteBoundary (32x60); position is feet-center.
    this.body!.setSize(32, 60);
    this.setMaxVelocity(Number.MAX_VALUE, MAX_FALL_SPEED);
    this.setGravityY(GRAVITY);
    this.setDepth(10);

    this.whip = new Whip(scene, this);
    this.setFacing(facing);

    // Re-align origin and body whenever the displayed frame changes, so every
    // frame's SpriteBoundary sits exactly on the physics body (as the original
    // engine did with per-frame bounding boxes).
    this.on(Phaser.Animations.Events.ANIMATION_UPDATE, () => this.alignFrame());
    this.on(Phaser.Animations.Events.ANIMATION_COMPLETE, (anim: Phaser.Animations.Animation) => {
      if (anim.key.includes('attack')) this.onAttackComplete();
    });

    const kb = scene.input.keyboard!;
    this.keys = {
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      jump: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      jumpAlt: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      attack: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
    };

    this.lastPlatformHeight = y;
    this.playAnim('idle');
  }

  setStairs(stairs: StairTrigger[]): void {
    this.stairs = stairs;
  }

  // ----- animation helpers ---------------------------------------------------

  private playAnim(name: string): void {
    const key = `simon/${name}`;
    if (this.anims.currentAnim?.key === key && this.anims.isPlaying) return;
    this.play(key);
    this.alignFrame();
  }

  /** Anchor the current frame so its SpriteBoundary bottom-center sits at (x, y). */
  private alignFrame(): void {
    const b = this.boundaries[this.frame.name];
    if (!b) return;
    const sw = this.frame.realWidth;
    const sh = this.frame.realHeight;
    let ox = (b.x + b.w / 2) / sw;
    if (this.flipX) ox = 1 - ox;
    const oy = (b.y + b.h) / sh;
    this.setOrigin(ox, oy);
    // Keep the fixed 32x60 body glued to the boundary's bottom-center.
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setOffset(ox * sw - 16, oy * sh - 60);
  }

  private isAirborne(): boolean {
    return [
      MoveState.JUMPING,
      MoveState.HOVERING,
      MoveState.FALLING,
      MoveState.FALLING_HARD,
      MoveState.LANDING,
      MoveState.TAKING_DAMAGE,
    ].includes(this.moveState);
  }

  isOnStairs(): boolean {
    return [
      MoveState.GOING_UPSTAIRS,
      MoveState.GOING_DOWNSTAIRS,
      MoveState.IDLE_UPSTAIRS,
      MoveState.IDLE_DOWNSTAIRS,
    ].includes(this.moveState);
  }

  get isAttacking(): boolean {
    return this.attackState !== AttackState.INACTIVE;
  }

  canConsumeWhipPowerup(): boolean {
    return this.moveState === MoveState.IDLE || this.moveState === MoveState.WALKING;
  }

  private get bodyRect(): Phaser.Geom.Rectangle {
    const b = this.body as Phaser.Physics.Arcade.Body;
    return new Phaser.Geom.Rectangle(b.left, b.top, b.width, b.height);
  }

  private get feetY(): number {
    return (this.body as Phaser.Physics.Arcade.Body).bottom;
  }

  /** Stair trigger of the given kind currently overlapping Simon's body. */
  private overlappingStair(kind: 'up' | 'down'): StairTrigger | null {
    const rect = this.bodyRect;
    return this.stairs.find((s) => s.kind === kind && Phaser.Geom.Intersects.RectangleToRectangle(rect, s.rect)) ?? null;
  }

  // ----- commands (mirroring Player.cpp) -------------------------------------

  private setMoveState(state: MoveState): void {
    this.moveState = state;
    this.onMoveStateChanged();
  }

  private idle(): void {
    switch (this.moveState) {
      case MoveState.GOING_UPSTAIRS:
      case MoveState.IDLE_UPSTAIRS:
        this.setMoveState(MoveState.IDLE_UPSTAIRS);
        this.setVelocity(0, 0);
        break;
      case MoveState.GOING_DOWNSTAIRS:
      case MoveState.IDLE_DOWNSTAIRS:
        this.setMoveState(MoveState.IDLE_DOWNSTAIRS);
        this.setVelocity(0, 0);
        break;
      default:
        this.lastPlatformHeight = this.feetY;
        this.setMoveState(MoveState.IDLE);
        this.setVelocityX(0);
        break;
    }
  }

  private walk(dir: -1 | 1): void {
    this.setMoveState(MoveState.WALKING);
    this.setFacing(dir);
    this.setVelocityX(SPEED * dir);
  }

  private walkToStairs(stair: StairTrigger): void {
    this.targetStair = stair;
    const stairCenterX = stair.rect.centerX;
    if (this.x < stairCenterX) {
      this.setFacing(1);
      this.setVelocityX(SPEED);
    } else {
      this.setFacing(-1);
      this.setVelocityX(-SPEED);
    }
    this.setMoveState(MoveState.WALKING_TO_STAIRS);
  }

  private goUpstairs(): void {
    if (this.moveState === MoveState.IDLE_DOWNSTAIRS) this.setFacing(this.facing === 1 ? -1 : 1);
    this.setGravityY(0); // before the body integrates this frame, or vy drifts
    this.setMoveState(MoveState.GOING_UPSTAIRS);
    this.setVelocity(STAIR_SPEED * this.facing, -STAIR_SPEED);
  }

  private goDownstairs(): void {
    if (this.moveState === MoveState.IDLE_UPSTAIRS) this.setFacing(this.facing === 1 ? -1 : 1);
    this.setGravityY(0);
    this.setMoveState(MoveState.GOING_DOWNSTAIRS);
    this.setVelocity(STAIR_SPEED * this.facing, STAIR_SPEED);
  }

  /** Snap feet to the given y and return to solid ground. */
  private exitStairs(feetY: number): void {
    this.y = feetY - 0.4;
    this.setVelocity(0, 0);
    this.targetStair = null;
    this.lastPlatformHeight = this.feetY;
    this.setMoveState(MoveState.IDLE);
  }

  private jump(): void {
    this.setMoveState(MoveState.JUMPING);
    this.setVelocityY(-JUMP_SPEED);
  }

  private duck(): void {
    this.setMoveState(MoveState.DUCKING);
    this.setVelocity(0, 0);
  }

  private fall(): void {
    this.setVelocityX(0);
    this.setMoveState(MoveState.FALLING_HARD);
  }

  private attack(): void {
    if (this.moveState === MoveState.WALKING) this.idle();
    if (this.isOnStairs()) this.setVelocity(0, 0);
    this.attackState = AttackState.WHIPPING;
    this.onAttackStateChanged();
    this.whip.unleash();
    this.scene.sound.play('sfx/Using_Weapon');
  }

  /**
   * Up+attack uses the equipped subweapon (Controller::UseSubweapon).
   * Returns false when nothing could be used (falls back to the whip).
   */
  private tryUseSubweapon(): boolean {
    const weapon = gameState.subweapon;
    if (!weapon) return false;

    if (weapon === 'stopwatch') {
      if (gameState.hearts < STOPWATCH_HEART_COST) return false;
      gameState.hearts -= STOPWATCH_HEART_COST;
      if (gameState.hearts === 0) gameState.subweapon = null;
      this.scene.events.emit('stopwatch');
      return true;
    }

    if (gameState.hearts <= 0) return false;

    // shot budget (Player::Throw): 1 per cooldown, 2 with the DoubleShot powerup
    if (this.subweaponShots === 0) {
      if (this.throwingCooldown > 0) return false;
      this.subweaponShots = gameState.powerup === 'double_shot' ? 2 : 1;
    }
    if (this.subweaponShots === 1) this.throwingCooldown = THROWING_COOLDOWN_TIME;
    this.subweaponShots--;

    // throwing costs a heart; running dry loses the subweapon
    this.throwingWeapon = weapon;
    gameState.hearts--;
    if (gameState.hearts === 0) gameState.subweapon = null;
    this.throwReleased = false;

    if (this.moveState === MoveState.WALKING) this.idle();
    if (this.isOnStairs()) this.setVelocity(0, 0);
    this.attackState = AttackState.THROWING;
    this.onAttackStateChanged();
    return true;
  }

  /** THROWING releases the projectile on the third animation frame. */
  private updateThrowRelease(): void {
    if (this.attackState !== AttackState.THROWING || this.throwReleased || !this.throwingWeapon) return;
    if ((this.anims.currentFrame?.index ?? 0) >= 3) {
      this.throwReleased = true;
      const body = this.body as Phaser.Physics.Arcade.Body;
      this.scene.events.emit('throw-subweapon', this.throwingWeapon, body.left, body.top + 5, this.facing);
      this.throwingWeapon = null;
    }
  }

  /** Whip-powerup pickup: freeze and cycle palette colors for 900ms. */
  flash(): void {
    this.setMoveState(MoveState.FLASHING);
    this.setVelocity(0, 0);
    this.whip.withdraw();
    this.attackState = AttackState.INACTIVE;
    this.flashingTimer = FLASHING_TIME;
  }

  get isUntouchable(): boolean {
    return this.untouchableTimer > 0;
  }

  /** Ported from Player::TakeDamage / Player::BounceBack. */
  takeDamage(damage: number, awayDir: -1 | 1): void {
    if (this.isUntouchable || this.moveState === MoveState.DYING || this.moveState === MoveState.FLASHING) return;

    gameState.health = Math.max(0, gameState.health - damage);
    this.untouchableTimer = UNTOUCHABLE_TIME;
    this.scene.sound.play('sfx/Being_Hit');

    if (this.isOnStairs()) {
      // no knockback on stairs, but a killing blow makes Simon fall off
      if (gameState.health <= 0) {
        this.setGravityY(23 * 60);
        this.fall();
      }
      return;
    }

    // bounce away from the hit, facing back toward it
    this.whip.withdraw();
    this.attackState = AttackState.INACTIVE;
    this.setFacing(-awayDir as -1 | 1);
    this.setVelocity(SPEED * awayDir, -BOUNCE_BACK_HEIGHT);
    this.setMoveState(MoveState.TAKING_DAMAGE);
  }

  /** Cutscene steering (door walk-through) while controls are disabled. */
  forceWalk(dir: -1 | 1): void {
    this.walk(dir);
  }

  stopAndIdle(): void {
    this.idle();
  }

  /**
   * Arrival cutscene: spawn already climbing the stairs (facing was set from
   * the spawn point) until the stair-exit trigger lands us on the floor.
   */
  arriveByStairs(mode: 'up' | 'down'): void {
    this.controlsEnabled = false;
    this.setGravityY(0);
    if (mode === 'up') this.goUpstairs();
    else this.goDownstairs();
  }

  /** Death: play the collapse animation, then let the scene respawn us. */
  die(): void {
    if (this.moveState === MoveState.DYING) return;
    this.setMoveState(MoveState.DYING);
    this.controlsEnabled = false;
    this.setVelocityX(0);
    this.whip.withdraw();
    this.attackState = AttackState.INACTIVE;
    this.untouchableTimer = 0; // don't let leftover i-frames flicker the corpse
    this.setVisible(true);
    this.scene.sound.stopByKey('music/VampireKiller');
    this.scene.sound.stopByKey('music/BossBattle'); // dying mid-boss-fight
    this.scene.sound.play('sfx/Live_Lost_');
    this.scene.time.delayedCall(2500, () => this.scene.events.emit('simon-died'));
  }

  private setFacing(dir: -1 | 1): void {
    this.setFlipX(dir === -1);
    this.whip.facing = dir;
  }

  get facing(): -1 | 1 {
    return this.flipX ? -1 : 1;
  }

  private onAttackComplete(): void {
    this.whip.withdraw();
    this.attackState = AttackState.INACTIVE;

    switch (this.moveState) {
      case MoveState.JUMPING:
      case MoveState.HOVERING:
      case MoveState.FALLING:
        this.setMoveState(MoveState.LANDING);
        break;
      case MoveState.DUCKING:
        this.duck();
        break;
      default:
        this.idle(); // handles ground and stairs alike
        break;
    }
  }

  private land(): void {
    if (this.isAttacking) {
      // Keep attacking on the ground but stop moving
      this.setVelocityX(0);
      this.moveState = MoveState.IDLE;
      return;
    }

    if (this.feetY - this.lastPlatformHeight >= LARGE_HEIGHT) {
      this.setMoveState(MoveState.LANDING_HARD);
      this.setVelocity(0, 0);
      this.scene.sound.play('sfx/Landing');
      this.landingTimer = LANDING_TIME;
    } else {
      this.idle();
    }
  }

  // ----- state -> animation (mirroring PlayerRenderingSystem.cpp) ------------

  private onMoveStateChanged(): void {
    switch (this.moveState) {
      case MoveState.IDLE:
        this.playAnim('idle');
        break;
      case MoveState.WALKING:
      case MoveState.WALKING_TO_STAIRS:
        this.playAnim('walk');
        break;
      case MoveState.DUCKING:
      case MoveState.LANDING_HARD:
        this.playAnim('duck');
        break;
      case MoveState.LANDING:
        this.playAnim('jump');
        break;
      case MoveState.FALLING_HARD:
        this.playAnim('idle');
        break;
      case MoveState.GOING_UPSTAIRS:
        this.playAnim('go_upstairs');
        break;
      case MoveState.GOING_DOWNSTAIRS:
        this.playAnim('go_downstairs');
        break;
      case MoveState.IDLE_UPSTAIRS:
        this.playAnim('idle_upstairs');
        break;
      case MoveState.IDLE_DOWNSTAIRS:
        this.playAnim('idle_downstairs');
        break;
      case MoveState.FLASHING:
        this.playAnim('flash_walk_01');
        break;
      case MoveState.TAKING_DAMAGE:
        this.playAnim('take_damage');
        break;
      case MoveState.DYING:
        this.playAnim('die');
        break;
      // JUMPING/HOVERING/FALLING animations are velocity-driven in preUpdate
    }
  }

  private onAttackStateChanged(): void {
    switch (this.moveState) {
      case MoveState.IDLE:
      case MoveState.WALKING:
        this.playAnim('attack');
        break;
      case MoveState.JUMPING:
      case MoveState.HOVERING:
      case MoveState.LANDING:
      case MoveState.FALLING:
        this.playAnim('jump_attack');
        break;
      case MoveState.DUCKING:
        this.playAnim('duck_attack');
        break;
      case MoveState.IDLE_UPSTAIRS:
        this.playAnim('go_upstairs_attack');
        break;
      case MoveState.IDLE_DOWNSTAIRS:
        this.playAnim('go_downstairs_attack');
        break;
    }
  }

  // ----- main loop ------------------------------------------------------------

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);

    const body = this.body as Phaser.Physics.Arcade.Body;
    const onFloor = body.blocked.down;
    const onStairs = this.isOnStairs();

    if (this.throwingCooldown > 0) this.throwingCooldown -= delta;
    this.updateThrowRelease();

    // i-frames: count down and flicker (clamped so no stray write — debug
    // tooling included — can exceed the legitimate window)
    if (this.untouchableTimer > 0) {
      this.untouchableTimer = Math.min(this.untouchableTimer, UNTOUCHABLE_TIME) - delta;
      if (this.moveState !== MoveState.TAKING_DAMAGE) {
        this.setVisible(Math.floor(this.untouchableTimer / 60) % 2 === 0);
      }
      if (this.untouchableTimer <= 0) this.setVisible(true);
    }

    if (this.moveState === MoveState.DYING) return;

    // No gravity on stairs; 1/6 gravity while hovering at the jump apex
    if (onStairs) this.setGravityY(0);
    else this.setGravityY(this.moveState === MoveState.HOVERING ? HOVERING_GRAVITY : GRAVITY);

    // --- timed states ---
    switch (this.moveState) {
      case MoveState.LANDING_HARD:
        this.landingTimer -= delta;
        if (this.landingTimer <= 0) this.idle();
        return;
      case MoveState.FLASHING:
        this.flashingTimer -= delta;
        if (this.flashingTimer <= 0) this.idle();
        return;
      case MoveState.JUMPING:
        if (body.velocity.y >= -HOVERING_VELOCITY) this.setMoveState(MoveState.HOVERING);
        break;
      case MoveState.HOVERING:
        if (body.velocity.y >= HOVERING_VELOCITY) this.setMoveState(MoveState.FALLING);
        break;
    }

    if (onStairs) {
      this.updateOnStairs();
      this.whip.updatePosition();
      return;
    }

    if (this.moveState === MoveState.WALKING_TO_STAIRS) {
      this.updateWalkingToStairs();
      return;
    }

    if (this.isAirborne()) {
      if (onFloor && body.velocity.y >= 0) {
        if ((this.moveState === MoveState.TAKING_DAMAGE || this.moveState === MoveState.FALLING_HARD) && gameState.health <= 0) {
          this.setVelocityX(0);
          this.die();
          return;
        }
        this.land();
      } else if (
        !this.isAttacking &&
        this.moveState !== MoveState.TAKING_DAMAGE &&
        this.moveState !== MoveState.FALLING_HARD // original blocks attacks during a hard ledge-fall
      ) {
        // mid-air whip/subweapon (Controller handles JUMPING/HOVERING/FALLING/LANDING)
        if (this.controlsEnabled && Phaser.Input.Keyboard.JustDown(this.keys.attack)) {
          if (!(this.keys.up.isDown && this.tryUseSubweapon())) this.attack();
        } else {
          // velocity-driven jump/fall poses
          if (body.velocity.y > STRETCH_LEG_ON_FALLING_Y) this.playAnim('idle');
          else if (body.velocity.y > -BEND_KNEE_ON_JUMPING_Y) this.playAnim('jump');
        }
      }
      this.whip.updatePosition();
      return; // no air control, jumps are committed
    }

    // Walked off a ledge without jumping -> fast fall
    if (!onFloor) {
      this.fall();
      return;
    }

    // --- grounded input ---
    if (this.isAttacking || !this.controlsEnabled) {
      this.whip.updatePosition();
      return;
    }

    const { left, right, up, down, jump, jumpAlt, attack } = this.keys;

    if (Phaser.Input.Keyboard.JustDown(attack)) {
      if (!(up.isDown && this.tryUseSubweapon())) this.attack();
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(jump) || Phaser.Input.Keyboard.JustDown(jumpAlt)) {
      this.jump();
      return;
    }

    // Enter stairs from idle (original only mounts stairs from IDLE)
    if (this.moveState === MoveState.IDLE) {
      if (up.isDown && !down.isDown) {
        const stair = this.overlappingStair('up');
        if (stair) { this.walkToStairs(stair); return; }
      }
      if (down.isDown && !up.isDown) {
        const stair = this.overlappingStair('down');
        if (stair) { this.walkToStairs(stair); return; }
      }
    }

    if (down.isDown) {
      if (this.moveState !== MoveState.DUCKING) this.duck();
      return;
    }

    if (left.isDown) {
      this.walk(-1);
    } else if (right.isDown) {
      this.walk(1);
    } else if (this.moveState !== MoveState.IDLE) {
      this.idle();
    } else {
      this.lastPlatformHeight = this.feetY;
    }
  }

  /** Auto-walk to the stair entry, then mount it (WALKING_TO_STAIRS state). */
  private updateWalkingToStairs(): void {
    const stair = this.targetStair;
    if (!stair) { this.idle(); return; }

    const body = this.body as Phaser.Physics.Arcade.Body;
    const crossed = this.facing === -1
      ? body.left <= stair.rect.left
      : body.right >= stair.rect.right;

    if (crossed) {
      this.setFacing(stair.facing);
      if (stair.kind === 'up') this.goUpstairs();
      else this.goDownstairs();
    }
  }

  private updateOnStairs(): void {
    const { up, down, attack } = this.keys;
    const body = this.body as Phaser.Physics.Arcade.Body;

    // --- reaching an exit ---
    if (this.moveState === MoveState.GOING_DOWNSTAIRS) {
      const exit = this.overlappingStair('up');
      if (exit && body.bottom >= exit.rect.bottom - 2) {
        this.exitStairs(exit.rect.bottom);
        return;
      }
    } else if (this.moveState === MoveState.GOING_UPSTAIRS) {
      const exit = this.overlappingStair('down');
      if (exit && body.bottom <= exit.rect.bottom) {
        this.exitStairs(exit.rect.bottom);
        return;
      }
    }

    if (this.isAttacking || !this.controlsEnabled) return;

    if (Phaser.Input.Keyboard.JustDown(attack)) {
      // only from an idle footing on the stairs, like the original
      if (this.moveState === MoveState.IDLE_UPSTAIRS || this.moveState === MoveState.IDLE_DOWNSTAIRS) {
        if (!(up.isDown && this.tryUseSubweapon())) this.attack();
      }
      return;
    }

    if (up.isDown && !down.isDown) {
      if (this.moveState !== MoveState.GOING_UPSTAIRS) this.goUpstairs();
      else this.setVelocity(STAIR_SPEED * this.facing, -STAIR_SPEED);
    } else if (down.isDown && !up.isDown) {
      if (this.moveState !== MoveState.GOING_DOWNSTAIRS) this.goDownstairs();
      else this.setVelocity(STAIR_SPEED * this.facing, STAIR_SPEED);
    } else if (
      this.moveState === MoveState.GOING_UPSTAIRS ||
      this.moveState === MoveState.GOING_DOWNSTAIRS
    ) {
      this.idle();
    }
  }
}
