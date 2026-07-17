import Phaser from 'phaser';
import { gameState, MAX_HEALTH, WHIP_MAX_LEVEL } from '../state';
import type { Simon } from './Simon';

// Items fall at a constant speed, like the original (no acceleration)
const ITEM_FALL_SPEED = 150;
const LIFESPAN = 4000; // ms, then the item despawns
const BLINK_TIME = 1000; // blink during the last second

interface ItemDef {
  texture: string;
  frame?: string;
  /** animation key to play (namespaced), e.g. 'crystal_ball/Flash' */
  anim?: string;
  /** never despawns (boss crystal ball) */
  permanent?: boolean;
  /** returns false if the pickup should be ignored right now */
  pickup: (simon: Simon, scene: Phaser.Scene, x: number, y: number) => boolean | void;
}

const getHeart = (n: number) => (simon: Simon, scene: Phaser.Scene) => {
  gameState.hearts += n;
  scene.sound.play('sfx/Getting_Heart');
};

const getMoney = (value: number, textKey: string) =>
  (simon: Simon, scene: Phaser.Scene, x: number, y: number) => {
    gameState.score += value;
    scene.sound.play('sfx/Getting_Money_Bag');
    showScoreText(scene, x, y, textKey);
  };

const getSubweapon = (weapon: string) => (simon: Simon, scene: Phaser.Scene) => {
  gameState.subweapon = weapon;
  scene.sound.play('sfx/Getting_Powerup');
};

function showScoreText(scene: Phaser.Scene, x: number, y: number, textKey: string): void {
  const text = scene.add.image(x, y - 8, textKey).setDepth(20);
  scene.tweens.add({
    targets: text,
    y: y - 24,
    alpha: { from: 1, to: 0.2 },
    duration: 700,
    onComplete: () => text.destroy(),
  });
}

// Item behavior table, ported from PlayerResponseSystem.cpp
export const ITEM_DEFS: Record<string, ItemDef> = {
  SmallHeart: { texture: 'small_heart', pickup: getHeart(1) },
  LargeHeart: { texture: 'large_heart', frame: 'large_heart', pickup: getHeart(5) },
  RedMoneyBag: { texture: 'money_bag', frame: 'money_bag_red', pickup: getMoney(100, 'score_100') },
  BlueMoneyBag: { texture: 'money_bag', frame: 'money_bag_blue', pickup: getMoney(400, 'score_400') },
  WhiteMoneyBag: { texture: 'money_bag', frame: 'money_bag_white', pickup: getMoney(700, 'score_700') },
  DaggerItem: { texture: 'dagger', frame: 'dagger', pickup: getSubweapon('dagger') },
  AxeItem: { texture: 'axe', frame: 'axe', pickup: getSubweapon('axe') },
  HolyWaterItem: { texture: 'holy_water', frame: 'holy_water', pickup: getSubweapon('holy_water') },
  Stopwatch: { texture: 'stopwatch', frame: 'stopwatch', pickup: getSubweapon('stopwatch') },
  WhipPowerup: {
    texture: 'whip_powerup',
    frame: 'whip_powerup',
    // only consumable on the ground (original has flashing sprites only for ground poses)
    pickup: (simon, scene) => {
      if (!simon.canConsumeWhipPowerup()) return false;
      gameState.whipLevel = Math.min(gameState.whipLevel + 1, WHIP_MAX_LEVEL);
      simon.flash();
      scene.sound.play('sfx/Getting_Powerup');
    },
  },
  PorkChop: {
    texture: 'pork_chop',
    frame: 'porkchop',
    pickup: (simon, scene) => {
      gameState.health = Math.min(gameState.health + 6, MAX_HEALTH);
      scene.sound.play('sfx/Getting_Powerup');
    },
  },
  Cross: {
    texture: 'cross',
    frame: 'cross',
    // TODO: kill all on-screen enemies once enemies exist
    pickup: (simon, scene) => void scene.sound.play('sfx/Getting_Holy_Cross'),
  },
  InvisibleJar: {
    texture: 'invisible_jar',
    frame: 'invisible_jar',
    // TODO: invisibility once damage exists
    pickup: (simon, scene) => void scene.sound.play('sfx/Getting_Powerup'),
  },
  DoubleShot: {
    texture: 'double_shot',
    frame: 'double_shot',
    pickup: (simon, scene) => {
      gameState.powerup = 'double_shot';
      scene.sound.play('sfx/Getting_Powerup');
    },
  },
  // dropped by the boss; picking it up completes the stage
  CrystalBall: {
    texture: 'crystal_ball',
    frame: 'flash_01',
    anim: 'crystal_ball/Flash',
    permanent: true,
    pickup: (simon, scene) => {
      gameState.health = MAX_HEALTH;
      scene.events.emit('level-completed');
    },
  },
};

export class Item extends Phaser.Physics.Arcade.Sprite {
  readonly itemId: string;
  private age = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, itemId: string) {
    const def = ITEM_DEFS[itemId];
    super(scene, x, y, def.texture, def.frame);
    this.itemId = itemId;
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(6);
    if (def.anim) this.play(def.anim);
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setVelocityY(ITEM_FALL_SPEED);
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    const body = this.body as Phaser.Physics.Arcade.Body;
    if (body.blocked.down) body.setVelocityY(0);

    if (ITEM_DEFS[this.itemId].permanent) return;
    this.age += delta;
    if (this.age >= LIFESPAN) {
      this.destroy();
    } else if (this.age >= LIFESPAN - BLINK_TIME) {
      this.setVisible(Math.floor(this.age / 100) % 2 === 0);
    }
  }

  /** Called on overlap with Simon. Returns true if consumed. */
  tryPickup(simon: Simon): boolean {
    const consumed = ITEM_DEFS[this.itemId].pickup(simon, this.scene, this.x, this.y);
    if (consumed === false) return false;
    this.destroy();
    return true;
  }
}
