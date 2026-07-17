import Phaser from 'phaser';
import { Enemy, Zombie, Panther, Fishman, VampireBat } from '../entities/enemies';
import type { Simon } from '../entities/Simon';

// Spawn-area configs from Content/GameStats/SpawnAreas/*.xml
interface SpawnConfig {
  groupChances: [count: number, chance: number][];
  rightChance: number; // % chance to spawn at the right viewport edge
  groupSpawnTime: number;
  spawnTime: number;
}

const CONFIGS: Record<string, SpawnConfig> = {
  Zombie: { groupChances: [[3, 100]], rightChance: 80, groupSpawnTime: 3500, spawnTime: 550 },
  VampireBat: { groupChances: [[1, 100]], rightChance: 75, groupSpawnTime: 5500, spawnTime: 0 },
  Fishman: { groupChances: [[2, 100]], rightChance: 0, groupSpawnTime: 4000, spawnTime: 1000 },
};

const MAX_FISHMAN_COUNT = 2;

/** parse "1:50-2:50" into [[1,50],[2,50]] */
function parseGroup(config: string): [number, number][] {
  return config.split('-').map((part) => {
    const [count, chance] = part.split(':').map(Number);
    return [count, chance];
  });
}

/**
 * One TMX SpawnArea: activates while Simon is inside its rect, then spawns
 * groups of enemies on the original's timers (SpawnArea.cpp).
 */
export class SpawnArea {
  private rect: Phaser.Geom.Rectangle;
  private kind: string;
  private config: SpawnConfig;
  private active = false;
  private groupTimer = 0;
  private spawnTimer = 0;
  private remainingInGroup = 0;

  constructor(
    rect: Phaser.Geom.Rectangle,
    kind: string,
    overrides: { spawnGroup?: string; spawnDirection?: string },
    private scene: Phaser.Scene,
    private enemies: Phaser.GameObjects.Group,
    private simon: Simon,
  ) {
    this.rect = rect;
    this.kind = kind;
    this.config = { ...CONFIGS[kind] };
    if (overrides.spawnGroup) this.config.groupChances = parseGroup(overrides.spawnGroup);
    if (overrides.spawnDirection) {
      // e.g. "Right:100" or "Left:20-Right:80" or "Bottom:100"
      const right = overrides.spawnDirection.split('-').find((d) => d.startsWith('Right'));
      this.config.rightChance = right ? Number(right.split(':')[1]) : 0;
    }
  }

  update(delta: number): void {
    const body = this.simon.body as Phaser.Physics.Arcade.Body;
    const inRange = this.rect.contains(body.center.x, body.center.y);

    if (!inRange) {
      if (this.active) {
        this.active = false;
        this.remainingInGroup = 0;
      }
      return;
    }
    if (!this.active) {
      this.active = true;
      this.groupTimer = this.config.groupSpawnTime; // first group spawns immediately
    }

    if (this.remainingInGroup > 0) {
      this.spawnTimer += delta;
      if (this.spawnTimer >= this.config.spawnTime) {
        this.spawnOne();
        this.spawnTimer = 0;
        this.remainingInGroup--;
      }
      return;
    }

    this.groupTimer += delta;
    if (this.groupTimer >= this.config.groupSpawnTime) {
      this.groupTimer = 0;
      this.spawnTimer = this.config.spawnTime; // first of the group spawns at once
      let roll = Phaser.Math.Between(1, 100);
      for (const [count, chance] of this.config.groupChances) {
        if (roll <= chance) { this.remainingInGroup = count; break; }
        roll -= chance;
      }
    }
  }

  private spawnOne(): void {
    const view = this.scene.cameras.main.worldView;
    const fromRight = Phaser.Math.Between(1, 100) <= this.config.rightChance;
    let enemy: Enemy;

    switch (this.kind) {
      case 'Zombie': {
        const x = fromRight ? view.right - 20 : view.left + 20;
        enemy = new Zombie(this.scene, x, this.rect.bottom - 1, fromRight ? -1 : 1);
        break;
      }
      case 'VampireBat': {
        const x = fromRight ? view.right - 20 : view.left + 20;
        const y = (this.simon.body as Phaser.Physics.Arcade.Body).center.y;
        enemy = new VampireBat(this.scene, x, y, fromRight ? -1 : 1);
        break;
      }
      case 'Fishman': {
        const alive = this.enemies.getChildren().filter((e) => e instanceof Fishman).length;
        if (alive >= MAX_FISHMAN_COUNT) return;
        const offset = Phaser.Math.Between(64, 224);
        const simonX = this.simon.x;
        let facing: -1 | 1;
        if (simonX + offset >= view.right - 32) facing = 1;
        else if (simonX - offset <= view.left + 32) facing = -1;
        else facing = Phaser.Math.Between(0, 1) ? 1 : -1;
        const x = facing === -1 ? simonX + offset : simonX - offset;
        enemy = new Fishman(this.scene, x, this.rect.bottom, facing);
        break;
      }
      default:
        return;
    }
    this.enemies.add(enemy, false);
  }
}

/**
 * SpawnPoint objects (e.g. Great Hall panthers): spawn when scrolled into
 * view; re-arm once the point is off-screen and its enemy is gone (NES-style
 * respawn on re-entry).
 */
export class PantherSpawnPoint {
  private enemy: Panther | null = null;

  constructor(
    private x: number,
    private y: number,
    private facing: -1 | 1,
    private scene: Phaser.Scene,
    private enemies: Phaser.GameObjects.Group,
  ) {}

  update(): void {
    const view = this.scene.cameras.main.worldView;
    const onScreen = this.x >= view.left - 32 && this.x <= view.right + 32;

    if (this.enemy && !this.enemy.active && !onScreen) this.enemy = null; // re-arm
    if (!this.enemy && onScreen) {
      this.enemy = new Panther(this.scene, this.x, this.y, this.facing);
      this.enemies.add(this.enemy, false);
    }
  }
}
