import Phaser from 'phaser';
import { Simon, StairTrigger, MoveState } from '../entities/Simon';
import { Container } from '../entities/Container';
import { Item } from '../entities/Item';
import { Enemy, Fireball, GiantBat } from '../entities/enemies';
import { Door } from '../entities/Door';
import { BreakableBlock } from '../entities/Breakable';
import {
  SubweaponProjectile, DaggerProjectile, AxeProjectile, HolyWaterProjectile,
} from '../entities/subweapons';
import { SpawnArea, PantherSpawnPoint } from '../systems/Spawner';
import { gameState, resetGameState, MAX_HEALTH } from '../state';
import { registerAnimations, type AnimDef } from '../util/anims';

const HUD_HEIGHT = 64;

// ---------------------------------------------------------------------------
// HUD layout, ported from the original's Hud.cpp. It renders at the same
// 512x448, so its x positions carry over directly; the exceptions below are
// deliberate. The HUD font (prstartk, 16px) is fixed-width: 16px per glyph
// advance, with 14px of ink (ascent 14, no descent).
// ---------------------------------------------------------------------------

// Rows. Hud.cpp uses 15/32/49 in an 83px strip; ours is 64 (448-64 = the 384px
// map height), so the column shifts up but keeps the same 17px pitch. Three
// rows of 14px ink at that pitch span 48px — which the subweapon box matches.
const ROW_1 = 8;
const ROW_2 = 25;
const ROW_3 = 42;

// Left column. Hud.cpp butts it against x=0 and puts ENEMY at 2 while PLAYER is
// at 0; this nudges the column off the edge and drops that 2px inconsistency so
// the two share an edge. The bars shift with it, preserving Hud.cpp's 9px gap
// between "PLAYER" and the first HP block — which is also why 8 is the ceiling,
// since Border.png starts at x=260.
const HUD_LEFT = 8;
const BAR_X = HUD_LEFT + 105;

// Subweapon box, drawn at its native size (scaling smeared its 4px border). Its
// bottom aligns with the ENEMY row's ink, putting its top level with SCORE.
const BOX_W = 61;
const BOX_H = 49;
const BOX_TOP = ROW_3 + 14 - BOX_H;

// Right column. Hud.cpp starts hearts/lives at 339/340 — left of STAGE at 370,
// which reads as a ragged edge — so they line up under STAGE instead, and the
// powerup moves out to finish flush with STAGE's right edge.
const STAGE_X = 370;
const HUD_RIGHT = STAGE_X + 8 * 16; // "STAGE nn" is 8 glyphs

// Frame order in HP_Block.atlas.xml: player_full, empty, boss_full
const HP_PLAYER = 0;
const HP_EMPTY = 1;
const HP_BOSS = 2;
const MAPS = ['courtyard', 'greathall', 'underground'] as const;
type MapKey = (typeof MAPS)[number];

const ANIMATED_SPRITES = [
  'simon', 'whip', 'brazier', 'candle', 'flame',
  'zombie', 'panther', 'fishman', 'vampire_bat', 'giant_bat', 'crystal_ball',
  'axe_weapon', 'holy_water_weapon', 'door',
];
const ATLAS_SPRITES = [
  ...ANIMATED_SPRITES,
  'money_bag', 'large_heart', 'whip_powerup', 'dagger', 'cross', 'holy_water',
  'axe', 'invisible_jar', 'stopwatch', 'pork_chop', 'double_shot', 'fireball',
];
const IMAGE_SPRITES = [
  'small_heart', 'score_100', 'score_400', 'score_700', 'spark', 'water_splash',
  'debris', 'block', 'block_top', 'block_bottom',
  'hud_border', 'hud_heart', 'hud_double_shot',
];
const SFX = [
  'Using_Weapon', 'Landing', 'Hitting_Something',
  'Getting_Heart', 'Getting_Money_Bag', 'Getting_Powerup', 'Getting_Holy_Cross',
  'Being_Hit', 'Live_Lost_', 'Fishman_Launching', 'Stage_Clear_',
  'Throwing_Dagger', 'Holy_Water_Touching_Ground', 'Stopwatch_Start',
  'Using_Door', 'Hitting_Breakable_Block', 'Hitting_Water_Surface',
];

interface MapObject {
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasGid: boolean; // gid objects anchor at bottom-left (Tiled convention)
  properties: Record<string, string | number | boolean>;
}

interface MapData {
  widthPx: number;
  heightPx: number;
  backgroundColor: string;
  groups: Record<string, MapObject[]>;
}

interface SceneData {
  map?: MapKey;
  spawn?: string;
  /** set when the transition happened on a stairway: keep climbing on arrival */
  arrival?: 'up' | 'down';
}

export class GameplayScene extends Phaser.Scene {
  private mapKey: MapKey = 'courtyard';
  private spawnName = 'Entrypoint';

  private simon!: Simon;
  // plain groups: PhysicsGroup.add() would overwrite the members' body
  // settings (gravity etc.) with group defaults
  private containers!: Phaser.GameObjects.Group;
  private items!: Phaser.GameObjects.Group;
  private enemies!: Phaser.GameObjects.Group;
  private fireballs!: Phaser.GameObjects.Group;
  private spawners: { update(delta: number): void }[] = [];
  private transitioning = false;
  private gameOver = false;
  private boss: GiantBat | null = null;
  private bossArea: Phaser.Geom.Rectangle | null = null;
  private bossFightStarted = false;
  private levelCompleted = false;
  private projectiles!: Phaser.GameObjects.Group;
  private stopwatchTimer = 0;
  private hudScore!: Phaser.GameObjects.Text;
  private hudStage!: Phaser.GameObjects.Text;
  private hudHearts!: Phaser.GameObjects.Text;
  private hudLives!: Phaser.GameObjects.Text;
  private hudSubweapon!: Phaser.GameObjects.Image;
  private hudDoubleShot!: Phaser.GameObjects.Image;
  private hudPlayerBlocks: Phaser.GameObjects.Image[] = [];
  private hudBossBlocks: Phaser.GameObjects.Image[] = [];
  private doubleShotFlashUntil = 0;
  private doubleShotWasActive = false;
  private breakables!: Phaser.GameObjects.Group;
  private stageAreas: Phaser.Geom.Rectangle[] = [];
  private waterAreas: Phaser.Geom.Rectangle[] = [];
  private mapHeightPx = 384;
  private doorCutscene: { door: Door; dir: -1 | 1; walkTargetX: number; walking: boolean } | null = null;

  constructor() {
    super('gameplay');
  }

  private arrivalMode: 'up' | 'down' | null = null;
  private arrivalTimer = 0;

  init(data: SceneData): void {
    this.mapKey = data.map ?? 'courtyard';
    this.spawnName = data.spawn ?? 'Entrypoint';
    this.arrivalMode = data.arrival ?? null;
    this.arrivalTimer = 0;
    this.transitioning = false;
    this.gameOver = false;
    this.spawners = [];
    this.boss = null;
    this.bossArea = null;
    this.bossFightStarted = false;
    this.levelCompleted = false;
    this.doorCutscene = null;
    this.stageAreas = [];
    this.doubleShotFlashUntil = 0;
    this.doubleShotWasActive = false;
  }

  dropItem(x: number, y: number, itemId: string): Item {
    const item = new Item(this, x, y, itemId);
    this.items.add(item, false);
    return item;
  }

  getSimon(): Simon | null {
    return this.simon ?? null;
  }

  isStopwatchActive(): boolean {
    return this.stopwatchTimer > 0;
  }

  preload(): void {
    this.load.setPath('assets');
    for (const key of ATLAS_SPRITES) {
      this.load.atlas(key, `sprites/${key}.png`, `sprites/${key}.atlas.json`);
    }
    for (const key of ANIMATED_SPRITES) {
      this.load.json(`${key}.anims`, `sprites/${key}.anims.json`);
    }
    for (const key of IMAGE_SPRITES) {
      this.load.image(key, `sprites/${key}.png`);
    }
    this.load.json('simon.boundaries', 'sprites/simon.boundaries.json');
    // HP_Block.atlas.xml: three 9x14 frames — player_full, empty, boss_full
    this.load.spritesheet('hud_hp_block', 'sprites/hud_hp_block.png', {
      frameWidth: 9, frameHeight: 14,
    });
    for (const map of MAPS) {
      this.load.json(`map.${map}`, `maps/${map}.json`);
      this.load.image(`bg.${map}`, `maps/${map}.png`);
    }
    this.load.audio('music/VampireKiller', 'audio/music/Stage_01_Vampire_Killer.wav');
    this.load.audio('music/GameOver', 'audio/music/Game_Over.wav');
    this.load.audio('music/BossBattle', 'audio/music/Boss_Battle_Poison_Mind.wav');
    for (const sfx of SFX) {
      this.load.audio(`sfx/${sfx}`, `audio/sfx/${sfx}.wav`);
    }
  }

  create(): void {
    for (const key of ANIMATED_SPRITES) {
      registerAnimations(this, key, this.cache.json.get(`${key}.anims`) as AnimDef[]);
    }

    const map = this.cache.json.get(`map.${this.mapKey}`) as MapData;

    // Pre-rendered map image as the background (collision comes from Bounds rects)
    this.add.image(0, 0, `bg.${this.mapKey}`).setOrigin(0, 0).setDepth(0);
    this.cameras.main.setBackgroundColor(map.backgroundColor ?? '#000000');

    // Invisible static colliders from the "Bounds" object layer.
    // "Platform" bounds are one-way: land from above, pass through from below
    // (fishmen launch up through them; walls/blocks/borders stay fully solid).
    const bounds = this.physics.add.staticGroup();
    for (const rect of map.groups.Bounds ?? []) {
      const solid = this.add.rectangle(rect.x, rect.y, rect.width, rect.height).setOrigin(0, 0);
      solid.setVisible(false);
      // walls/borders only block Simon; enemies walk through them and despawn
      solid.setData('wall', /Wall|Border/.test(rect.name));
      bounds.add(solid);
      if (rect.name === 'Platform') {
        const body = solid.body as Phaser.Physics.Arcade.StaticBody;
        body.checkCollision.down = false;
        body.checkCollision.left = false;
        body.checkCollision.right = false;
      }
    }

    // Whippable containers (braziers, candles) from the "Entities" layer
    this.containers = this.add.group();
    for (const obj of map.groups.Entities ?? []) {
      if (obj.type !== 'Brazier' && obj.type !== 'Candle') continue;
      const kind = obj.type.toLowerCase() as 'brazier' | 'candle';
      // gid objects: (x, y) is the bottom-left corner
      const item = (obj.properties.Item as string) ?? null;
      this.containers.add(new Container(this, obj.x + obj.width / 2, obj.y, kind, item));
    }

    // Dropped items (populated when containers are whipped)
    this.items = this.add.group();
    for (const container of this.containers.getChildren()) {
      container.on('dropitem', (item: Item) => this.items.add(item, false));
    }

    // Simon spawns at the requested location
    const spawn = (map.groups.Locations ?? []).find((o) => o.name === this.spawnName)
      ?? (map.groups.Locations ?? []).find((o) => o.name === 'Entrypoint');
    const spawnX = spawn ? spawn.x + spawn.width / 2 : 100;
    let spawnY = spawn ? spawn.y : 288; // gid object: y is the bottom edge
    const facing = spawn?.properties.Facing === 'Left' ? -1 : 1;

    // Some spawn points sit a few px inside a floor slab (e.g. Great Hall's
    // Underground_01); snap the feet up to the slab surface or Arcade physics
    // can't separate the overlap and Simon tunnels through the world.
    // Stair arrivals skip this: they legitimately start below/above the floor
    // and climb the rest of the way.
    if (!this.arrivalMode) {
      for (const rect of map.groups.Bounds ?? []) {
        const withinX = spawnX >= rect.x - 16 && spawnX <= rect.x + rect.width + 16;
        const embedded = spawnY > rect.y && spawnY <= rect.y + rect.height + 1;
        if (withinX && embedded) spawnY = rect.y;
      }
    }
    this.simon = new Simon(this, spawnX, spawnY, facing);

    // Stairs are triggers, not solids; Simon ignores terrain while climbing
    this.simon.setStairs(this.buildStairs(map));
    if (this.arrivalMode) this.simon.arriveByStairs(this.arrivalMode);
    this.physics.add.collider(this.simon, bounds, undefined, () => !this.simon.isOnStairs());
    this.physics.add.collider(this.items, bounds);
    this.physics.add.overlap(this.simon, this.items, (_s, item) => {
      (item as Item).tryPickup(this.simon);
    });

    // Enemies and their projectiles; Simon's thrown subweapons
    this.enemies = this.add.group();
    this.fireballs = this.add.group();
    this.projectiles = this.add.group();
    this.stopwatchTimer = 0;

    // holy water shatters on solid ground
    this.physics.add.collider(this.projectiles, bounds, (proj) => {
      (proj as SubweaponProjectile).onHitGround();
    }, (proj) => proj instanceof HolyWaterProjectile);
    this.physics.add.overlap(this.projectiles, this.enemies, (obj1, obj2) => {
      const proj = (obj1 instanceof SubweaponProjectile ? obj1 : obj2) as SubweaponProjectile;
      const enemy = (obj1 instanceof SubweaponProjectile ? obj2 : obj1) as Enemy;
      if (!proj.isDamaging || !enemy.alive) return;
      enemy.takeDamage(proj.attackPower, proj.attackId);
      if (!proj.pierces) proj.destroy();
    });
    this.physics.add.collider(this.enemies, bounds, undefined, (a, b) => {
      const enemy = (a instanceof Enemy ? a : b) as Enemy;
      const bound = (a instanceof Enemy ? b : a) as Phaser.GameObjects.Rectangle;
      return enemy.collidesWithTerrain && !bound.getData('wall');
    });
    this.physics.add.overlap(this.simon, this.enemies, (_s, obj) => {
      const enemy = obj as Enemy;
      if (enemy.alive && !this.doorCutscene) {
        this.simon.takeDamage(enemy.attackPower, enemy.x <= this.simon.x ? 1 : -1);
      }
    });
    this.physics.add.overlap(this.simon, this.fireballs, (_s, obj) => {
      const fireball = obj as Fireball;
      if (!this.simon.isUntouchable && !this.doorCutscene) {
        this.simon.takeDamage(fireball.attackPower, fireball.x <= this.simon.x ? 1 : -1);
        fireball.destroy();
      }
    });

    this.events.off('fireball');
    this.events.on('fireball', (x: number, y: number, dir: -1 | 1) => {
      this.fireballs.add(new Fireball(this, x, y, dir), false);
    });
    this.events.off('boss-fireball');
    this.events.on('boss-fireball', (x: number, y: number, tx: number, ty: number) => {
      this.fireballs.add(Fireball.aimed(this, x, y, tx, ty), false);
    });
    this.events.off('throw-subweapon');
    this.events.on('throw-subweapon', (weapon: string, x: number, y: number, facing: -1 | 1) => {
      const proj =
        weapon === 'dagger' ? new DaggerProjectile(this, x, y, facing)
        : weapon === 'axe' ? new AxeProjectile(this, x, y, facing)
        : new HolyWaterProjectile(this, x, y, facing);
      this.projectiles.add(proj, false);
    });
    this.events.off('stopwatch');
    this.events.on('stopwatch', () => {
      this.stopwatchTimer = 3000;
      this.sound.play('sfx/Stopwatch_Start');
    });
    this.events.off('simon-died');
    this.events.once('simon-died', () => this.onSimonDied());
    this.events.off('boss-died');
    this.events.once('boss-died', () => this.onBossDied());
    this.events.off('level-completed');
    this.events.once('level-completed', () => this.onLevelCompleted());

    this.buildSpawners(map);
    this.buildBoss(map, bounds);

    // Doors and breakable blocks/walls (solid to Simon)
    this.breakables = this.add.group();
    const doors: Door[] = [];
    for (const obj of map.groups.Entities ?? []) {
      if (obj.type === 'Door') {
        doors.push(new Door(this, obj.x + obj.width / 2, obj.y));
      } else if (obj.type === 'BreakableBlock') {
        const block = new BreakableBlock(this, obj.x + obj.width / 2, obj.y, 'block',
          (obj.properties.Item as string) ?? null);
        this.breakables.add(block, false);
      } else if (obj.type === 'BreakableWall') {
        // two stacked blocks; the bottom one hides the item and breaks first
        const bottom = new BreakableBlock(this, obj.x + obj.width / 2, obj.y, 'block_bottom',
          (obj.properties.Item as string) ?? null);
        const top = new BreakableBlock(this, obj.x + obj.width / 2, obj.y - 32, 'block_top', null);
        top.breakFirst = bottom;
        this.breakables.add(bottom, false);
        this.breakables.add(top, false);
      }
    }
    this.physics.add.collider(this.simon, this.breakables, undefined, () => !this.simon.isOnStairs());
    this.physics.add.collider(this.simon, doors, (_s, obj) => {
      this.tryStartDoorCutscene(obj as Door);
    }, () => !this.simon.isOnStairs());

    // Camera: playfield scrolls horizontally, HUD strip stays on top; in maps
    // with StageAreas (Great Hall) the camera is penned into the current one.
    // World bounds start at -HUD_HEIGHT so the map's y=0 lands below the HUD.
    this.mapHeightPx = map.heightPx;
    this.stageAreas = (map.groups.Areas ?? [])
      .filter((o) => o.type === 'StageArea')
      .map((o) => new Phaser.Geom.Rectangle(o.x, o.y, o.width, o.height));

    // Water pits (Underground): falling in is instant death.
    // These are gid objects, so (x, y) is the bottom-left corner.
    this.waterAreas = (map.groups.Entities ?? [])
      .filter((o) => o.type === 'WaterArea')
      .map((o) => new Phaser.Geom.Rectangle(o.x, o.y - o.height, o.width, o.height));
    const cam = this.cameras.main;
    this.applyCameraBounds(this.stageAreaAt(spawnX));
    cam.startFollow(this.simon, true, 1, 0);
    cam.setRoundPixels(true);
    cam.fadeIn(300, 0, 0, 0);

    this.createHud();
    this.playMusic();
  }

  private buildSpawners(map: MapData): void {
    // SpawnArea zones (zombies, bats, fishmen)
    for (const obj of map.groups.Areas ?? []) {
      if (obj.type !== 'SpawnArea') continue;
      const kind = obj.properties.SpawnObject as string;
      if (!['Zombie', 'VampireBat', 'Fishman'].includes(kind)) continue;
      this.spawners.push(new SpawnArea(
        new Phaser.Geom.Rectangle(obj.x, obj.y, obj.width, obj.height),
        kind,
        {
          spawnGroup: obj.properties.SpawnGroup as string | undefined,
          spawnDirection: obj.properties.SpawnDirection as string | undefined,
        },
        this, this.enemies, this.simon,
      ));
    }
    // Fixed spawn points (Great Hall panthers; the GiantBat boss comes later)
    for (const obj of map.groups.Entities ?? []) {
      if (obj.type !== 'SpawnPoint' || obj.properties.SpawnObject !== 'Panther') continue;
      const facing = obj.properties.Facing === 'Left' ? -1 : 1;
      this.spawners.push(new PantherSpawnPoint(
        obj.x + obj.width / 2, obj.y, facing, this, this.enemies,
      ));
    }
  }

  private stageAreaAt(x: number): Phaser.Geom.Rectangle | null {
    return this.stageAreas.find((a) => x >= a.left && x < a.right) ?? null;
  }

  private applyCameraBounds(area: Phaser.Geom.Rectangle | null): void {
    const map = this.cache.json.get(`map.${this.mapKey}`) as MapData;
    if (area) {
      this.cameras.main.setBounds(area.x, -HUD_HEIGHT, area.width, this.mapHeightPx + HUD_HEIGHT);
    } else {
      this.cameras.main.setBounds(0, -HUD_HEIGHT, map.widthPx, this.mapHeightPx + HUD_HEIGHT);
    }
  }

  /**
   * NextRoomCutscene.cpp: pan halfway, open the door, walk Simon through,
   * close it, pan into the next section, then re-pen the camera there.
   */
  private tryStartDoorCutscene(door: Door): void {
    if (door.used || this.doorCutscene || this.transitioning || this.levelCompleted) return;
    const body = this.simon.body as Phaser.Physics.Arcade.Body;
    if (!body.blocked.down || this.simon.isAttacking) return;

    door.used = true;
    const dir: -1 | 1 = this.simon.x < door.x ? 1 : -1;
    this.doorCutscene = { door, dir, walkTargetX: 0, walking: false };
    this.simon.controlsEnabled = false;
    this.simon.stopAndIdle();

    // the old room's monsters don't follow (ClearObjectsWithin)
    for (const obj of [...this.enemies.getChildren()]) {
      if (!(obj instanceof GiantBat)) obj.destroy();
    }

    const cam = this.cameras.main;
    cam.stopFollow();
    const targetArea = this.stageAreaAt(door.x + dir * 32);
    const targetScrollX = targetArea
      ? (dir === 1 ? targetArea.left : targetArea.right - 512)
      : cam.scrollX + dir * 512;

    cam.removeBounds();
    this.tweens.add({
      targets: cam,
      scrollX: (cam.scrollX + targetScrollX) / 2,
      duration: Math.abs(targetScrollX - cam.scrollX) / 2 / 140 * 1000, // 140 px/s
      onComplete: () => {
        door.open(() => {
          (door.body as Phaser.Physics.Arcade.StaticBody).enable = false;
          this.simon.forceWalk(dir);
          this.doorCutscene!.walkTargetX = this.simon.x + dir * 135;
          this.doorCutscene!.walking = true;
        });
      },
    });
  }

  /** walk phase polling + wrap-up for the door cutscene */
  private updateDoorCutscene(): void {
    const cs = this.doorCutscene;
    if (!cs?.walking) return;
    const arrived = cs.dir === 1 ? this.simon.x >= cs.walkTargetX : this.simon.x <= cs.walkTargetX;
    if (!arrived) return;

    cs.walking = false;
    this.simon.stopAndIdle();
    cs.door.close(() => {
      (cs.door.body as Phaser.Physics.Arcade.StaticBody).enable = true; // sealed behind us
      const cam = this.cameras.main;
      const targetArea = this.stageAreaAt(this.simon.x);
      const targetScrollX = targetArea
        ? Phaser.Math.Clamp(this.simon.x - 256, targetArea.left, targetArea.right - 512)
        : cam.scrollX;
      this.tweens.add({
        targets: cam,
        scrollX: targetScrollX,
        duration: Math.abs(targetScrollX - cam.scrollX) / 140 * 1000,
        onComplete: () => {
          this.applyCameraBounds(targetArea);
          cam.startFollow(this.simon, true, 1, 0);
          this.simon.controlsEnabled = true;
          this.doorCutscene = null;
        },
      });
    });
  }

  private buildBoss(map: MapData, bounds: Phaser.Physics.Arcade.StaticGroup): void {
    const spawn = (map.groups.Entities ?? []).find(
      (o) => o.type === 'SpawnPoint' && o.properties.SpawnObject === 'GiantBat');
    if (!spawn) return;

    // gid object: (x, y) is the bottom-left corner; the bat hangs asleep
    this.boss = new GiantBat(this, spawn.x + spawn.width / 2, spawn.y - spawn.height / 2);
    this.enemies.add(this.boss, false);

    const area = (map.groups.Areas ?? []).find((o) => o.type === 'BossFightArea');
    if (area) this.bossArea = new Phaser.Geom.Rectangle(area.x, area.y, area.width, area.height);
    this.bossWallGroup = bounds;
  }

  private bossWallGroup: Phaser.Physics.Arcade.StaticGroup | null = null;

  /** BossFightCutscene.cpp: lock the camera, wall off the exit, wake the bat. */
  private startBossFight(): void {
    this.bossFightStarted = true;
    const cam = this.cameras.main;
    cam.stopFollow();

    const view = new Phaser.Geom.Rectangle(
      cam.worldView.x, cam.worldView.y + HUD_HEIGHT, cam.worldView.width, cam.worldView.height - HUD_HEIGHT);

    // invisible wall so Simon can't leave the arena
    const wall = this.add.rectangle(view.left - 16, 0, 16, 384).setOrigin(0, 0).setVisible(false);
    this.bossWallGroup?.add(wall);

    this.time.delayedCall(2000, () => {
      if (!this.boss?.alive) return;
      this.sound.stopByKey('music/VampireKiller');
      this.sound.play('music/BossBattle', { loop: true, volume: 0.5 });
      this.boss.activate(view);
    });
  }

  private onBossDied(): void {
    this.sound.stopByKey('music/BossBattle');
    // the crystal ball floats down at the center of the arena
    const cam = this.cameras.main;
    this.dropItem(cam.worldView.centerX, cam.worldView.top + HUD_HEIGHT + 60, 'CrystalBall');
  }

  private onLevelCompleted(): void {
    this.levelCompleted = true;
    this.sound.stopByKey('music/VampireKiller');
    this.sound.play('sfx/Stage_Clear_');
    // hearts convert to score, like the original's tally
    gameState.score += gameState.hearts * 100;
    gameState.hearts = 0;

    this.add.rectangle(0, 0, 512, 448, 0x000000, 0.6)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(200);
    this.add.text(256, 190, 'STAGE CLEAR', {
      fontFamily: 'monospace', fontSize: '32px', color: '#ffffff',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(201);
    this.add.text(256, 240, 'SIMON PREVAILS... FOR NOW', {
      fontFamily: 'monospace', fontSize: '14px', color: '#ff8888',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(201);
    this.add.text(256, 280, 'PRESS ANY KEY', {
      fontFamily: 'monospace', fontSize: '16px', color: '#aaaaaa',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(201);

    this.time.delayedCall(1500, () => {
      this.input.keyboard!.once('keydown', () => {
        resetGameState(true); // final score stays on the board
        this.scene.start('menu');
      });
    });
  }

  /** Falling into water (or out of the world): splash, instant death. */
  private checkPitDeath(): void {
    if (this.simon.moveState === MoveState.DYING || this.arrivalMode) return;
    const body = this.simon.body as Phaser.Physics.Arcade.Body;

    const inWater = this.waterAreas.find((w) =>
      body.bottom >= w.top && body.center.x >= w.left && body.center.x <= w.right);
    const belowWorld = body.top > this.mapHeightPx + 64;
    if (!inWater && !belowWorld) return;

    if (inWater) {
      this.sound.play('sfx/Hitting_Water_Surface');
      const splash = this.add.image(this.simon.x, inWater.top + 6, 'water_splash').setDepth(12);
      this.time.delayedCall(300, () => splash.destroy());
    }
    gameState.health = 0;
    this.simon.die(); // keeps falling/sinking while the death jingle plays
  }

  private onSimonDied(): void {
    gameState.lives--;
    if (gameState.lives > 0) {
      gameState.health = MAX_HEALTH;
      this.cameras.main.fadeOut(400, 0, 0, 0);
      this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
        this.scene.restart({ map: this.mapKey, spawn: 'Entrypoint' } satisfies SceneData);
      });
    } else {
      this.gameOver = true;
      this.sound.play('music/GameOver');
      this.add.rectangle(0, 0, 512, 448, 0x000000, 0.75)
        .setOrigin(0, 0).setScrollFactor(0).setDepth(200);
      this.add.text(256, 200, 'GAME OVER', {
        fontFamily: 'monospace', fontSize: '32px', color: '#ffffff',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(201);
      this.add.text(256, 250, 'PRESS ANY KEY', {
        fontFamily: 'monospace', fontSize: '16px', color: '#aaaaaa',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(201);
      this.input.keyboard!.once('keydown', () => {
        this.sound.stopByKey('music/GameOver');
        this.scene.start('menu');
      });
    }
  }

  private buildStairs(map: MapData): StairTrigger[] {
    const stairs: StairTrigger[] = [];
    for (const obj of map.groups.Triggers ?? []) {
      if (obj.name !== 'StairUp' && obj.name !== 'StairDown') continue;
      if (obj.properties.Enabled === false) continue;
      stairs.push({
        rect: new Phaser.Geom.Rectangle(obj.x, obj.y, obj.width, obj.height),
        kind: obj.name === 'StairUp' ? 'up' : 'down',
        facing: obj.properties.Facing === 'Left' ? -1 : 1,
      });
    }
    return stairs;
  }

  private createHud(): void {
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: 'prstartk, monospace',
      fontSize: '16px',
      color: '#ffffff',
    };
    // scrollFactor 0 => screen space; y=0 is the top of the HUD strip
    this.add.rectangle(0, 0, 512, HUD_HEIGHT, 0x000000)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(100);
    this.hudScore = this.add.text(HUD_LEFT, ROW_1, '', style).setScrollFactor(0).setDepth(101);
    this.hudStage = this.add.text(STAGE_X, ROW_1, '', style).setScrollFactor(0).setDepth(101);
    this.add.text(HUD_LEFT, ROW_2, 'PLAYER', style).setScrollFactor(0).setDepth(101);
    this.add.text(HUD_LEFT, ROW_3, 'ENEMY', style).setScrollFactor(0).setDepth(101);

    // Equipped-subweapon box (Hud/Border.png), drawn 1:1 at its native 61x49.
    this.add.image(260, BOX_TOP, 'hud_border')
      .setOrigin(0, 0).setScrollFactor(0).setDepth(101);
    this.hudSubweapon = this.add.image(260 + BOX_W / 2, BOX_TOP + BOX_H / 2, 'dagger')
      .setScrollFactor(0).setDepth(102).setVisible(false);

    // Hearts sit on the PLAYER row, lives on the ENEMY row — the count is drawn
    // as "-nn" next to a heart sprite, not as a text glyph. Both start at
    // STAGE_X, and the heart sprite is 16px wide, so "-nn" clears it exactly.
    this.add.image(STAGE_X, ROW_2, 'hud_heart')
      .setOrigin(0, 0).setScrollFactor(0).setDepth(101);
    this.hudHearts = this.add.text(STAGE_X + 16, ROW_2, '', style).setScrollFactor(0).setDepth(101);
    this.hudLives = this.add.text(STAGE_X, ROW_3, '', style).setScrollFactor(0).setDepth(101);

    // Right edge flush with STAGE's; vertically 1px above the ENEMY row's top,
    // the same relationship Hud.cpp uses (powerup y=48 vs ENEMY row 49).
    this.hudDoubleShot = this.add.image(HUD_RIGHT - 14, ROW_3 - 1, 'hud_double_shot')
      .setScrollFactor(0).setDepth(102).setVisible(false);

    // Health bars: 16 HP_Block frames per row at a 9px stride, as in
    // Hud::DrawHealthBars. Created once, then re-framed on every refresh.
    // Phaser reuses the scene instance across restarts (map transitions, deaths),
    // so these must start empty — otherwise createHud appends a second set and
    // refreshHud keeps re-framing the first, destroyed one, leaving the bars blank.
    this.hudPlayerBlocks = [];
    this.hudBossBlocks = [];
    for (let i = 0; i < MAX_HEALTH; i++) {
      const x = BAR_X + i * 9;
      this.hudPlayerBlocks.push(this.add.image(x, ROW_2 + 1, 'hud_hp_block', HP_EMPTY)
        .setOrigin(0, 0).setScrollFactor(0).setDepth(101));
      this.hudBossBlocks.push(this.add.image(x, ROW_3, 'hud_hp_block', HP_EMPTY)
        .setOrigin(0, 0).setScrollFactor(0).setDepth(101));
    }

    this.refreshHud();
  }

  private refreshHud(): void {
    // All four counters are zero-padded exactly as Hud.cpp's PadZero does.
    this.hudScore.setText(`SCORE-${String(gameState.score).padStart(6, '0')}`);
    this.hudStage.setText(`STAGE ${String(gameState.stage).padStart(2, '0')}`);
    this.hudHearts.setText(`-${String(gameState.hearts).padStart(2, '0')}`);
    this.hudLives.setText(`P-${String(gameState.lives).padStart(2, '0')}`);

    const weapon = gameState.subweapon;
    this.hudSubweapon.setVisible(!!weapon);
    if (weapon) this.hudSubweapon.setTexture(weapon); // texture keys match subweapon names

    this.updateDoubleShotIndicator();

    // 16-unit health bars; the ENEMY row tracks the boss when one is present
    const bossHealth = this.boss ? (this.boss.alive ? this.boss.health : 0) : MAX_HEALTH;
    for (let i = 0; i < MAX_HEALTH; i++) {
      this.hudPlayerBlocks[i].setFrame(i < gameState.health ? HP_PLAYER : HP_EMPTY);
      this.hudBossBlocks[i].setFrame(i < bossHealth ? HP_BOSS : HP_EMPTY);
    }
  }

  /**
   * Double_Shot.png flashes for 2.5s when first picked up (Hud::DrawPowerup),
   * toggling every 60ms, then stays solid.
   */
  private updateDoubleShotIndicator(): void {
    // Shown whenever the DoubleShot powerup is held, with or without a subweapon
    // equipped — matching Hud::GetPowerupTexture, which keys off the powerup
    // alone. Cleared on death by resetGameState.
    const active = gameState.powerup === 'double_shot';
    if (!active) {
      this.hudDoubleShot.setVisible(false);
      this.doubleShotFlashUntil = 0;
      this.doubleShotWasActive = false;
      return;
    }
    if (!this.doubleShotWasActive) {
      this.doubleShotFlashUntil = this.time.now + 2500;
      this.doubleShotWasActive = true;
    }
    // refreshHud runs every frame, so the flash has to be decided here — doing
    // it in update() got overwritten by this method later in the same frame.
    const flashing = this.time.now < this.doubleShotFlashUntil;
    this.hudDoubleShot.setVisible(!flashing || Math.floor(this.time.now / 60) % 2 === 0);
  }

  private playMusic(): void {
    const start = () => {
      this.sound.stopByKey('music/BossBattle'); // never let a stale boss loop stack
      this.sound.stopByKey('music/Prologue');
      if (!this.sound.get('music/VampireKiller')?.isPlaying) {
        this.sound.play('music/VampireKiller', { loop: true, volume: 0.5 });
      }
    };
    if (this.sound.locked) {
      this.sound.once(Phaser.Sound.Events.UNLOCKED, start);
    } else {
      start();
    }
  }

  private goToMap(mapName: string, spawnPoint: string, arrival?: 'up' | 'down'): void {
    if (this.transitioning) return;
    this.transitioning = true;
    this.simon.controlsEnabled = false;

    // TMX uses "GreatHall"/"Underground" names; scene keys are lowercase
    const target = mapName.toLowerCase().replace('_', '') as MapKey;
    this.cameras.main.fadeOut(400, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.restart({ map: target, spawn: spawnPoint, arrival } satisfies SceneData);
    });
  }

  private checkTransitionTriggers(): void {
    if (this.transitioning) return;

    const body = this.simon.body as Phaser.Physics.Arcade.Body;
    // Fires when walking or climbing stairs only, never mid-jump (like the original)
    const grounded = body.blocked.down || this.simon.isOnStairs();
    if (!grounded) return;

    const simonRect = new Phaser.Geom.Rectangle(body.left, body.top, body.width, body.height);
    const map = this.cache.json.get(`map.${this.mapKey}`) as MapData;

    for (const obj of map.groups.Triggers ?? []) {
      const rect = new Phaser.Geom.Rectangle(obj.x, obj.y, obj.width, obj.height);
      if (!Phaser.Geom.Intersects.RectangleToRectangle(simonRect, rect)) continue;

      if (obj.name === 'NextMap' && obj.properties.Enabled !== false) {
        // leaving on a stairway? keep climbing the same way on arrival
        const arrival =
          this.simon.moveState === MoveState.GOING_UPSTAIRS ? 'up'
          : this.simon.moveState === MoveState.GOING_DOWNSTAIRS ? 'down'
          : undefined;
        this.goToMap(obj.properties.Map as string, obj.properties.SpawnPoint as string, arrival);
        return;
      }
      // Courtyard castle door: the original plays a walk-in cutscene here;
      // we transition straight into the Great Hall.
      if (obj.name === 'CastleEntrance') {
        this.goToMap('greathall', 'Entrypoint');
        return;
      }
    }
  }

  update(time: number, delta: number): void {
    // Whip vs containers and enemies on the extended attack frame
    if (this.simon.whip.isHitFrame) {
      const hitbox = this.simon.whip.getHitbox();
      for (const obj of [...this.containers.getChildren()]) {
        const container = obj as Container;
        if (Phaser.Geom.Intersects.RectangleToRectangle(hitbox, container.getBounds())) {
          container.hit();
        }
      }
      const whipDamage = gameState.whipLevel === 1 ? 1 : 2;
      for (const obj of [...this.enemies.getChildren()]) {
        const enemy = obj as Enemy;
        if (enemy.alive && Phaser.Geom.Intersects.RectangleToRectangle(hitbox, enemy.getBounds())) {
          enemy.takeDamage(whipDamage, this.simon.whip.attackId);
        }
      }
      // breakable blocks/walls crumble to the whip
      for (const obj of [...this.breakables.getChildren()]) {
        const block = obj as BreakableBlock;
        if (block.alive && Phaser.Geom.Intersects.RectangleToRectangle(hitbox, block.getBounds())) {
          block.hit(this.simon.whip.attackId);
        }
      }
      // the whip snuffs out fireballs too
      for (const obj of [...this.fireballs.getChildren()]) {
        const fireball = obj as Fireball;
        if (Phaser.Geom.Intersects.RectangleToRectangle(hitbox, fireball.getBounds())) {
          const spark = this.add.image(fireball.x, fireball.y, 'spark').setDepth(12);
          this.time.delayedCall(140, () => spark.destroy());
          fireball.destroy();
        }
      }
    }

    if (this.stopwatchTimer > 0) this.stopwatchTimer -= delta;
    this.updateDoorCutscene();

    // stair arrival ends when the exit trigger lands Simon on the floor
    // (watchdog in case bad geometry never fires the exit)
    if (this.arrivalMode) {
      this.arrivalTimer += delta;
      if (!this.simon.isOnStairs() || this.arrivalTimer > 3000) {
        if (this.simon.isOnStairs()) this.simon.stopAndIdle();
        this.arrivalMode = null;
        this.simon.controlsEnabled = true;
      }
    }

    if (!this.gameOver && !this.levelCompleted && !this.doorCutscene && !this.arrivalMode &&
        this.simon.moveState !== MoveState.DYING) {
      this.checkPitDeath();
      if (!this.isStopwatchActive()) {
        for (const spawner of this.spawners) spawner.update(delta);
      }
      this.checkTransitionTriggers();

      // entering the boss arena (grounded) seals it and starts the fight
      if (!this.bossFightStarted && this.boss?.alive && this.bossArea) {
        const body = this.simon.body as Phaser.Physics.Arcade.Body;
        if (body.blocked.down && this.bossArea.contains(body.center.x, body.center.y)) {
          this.startBossFight();
        }
      }
    }
    this.refreshHud();
  }
}
