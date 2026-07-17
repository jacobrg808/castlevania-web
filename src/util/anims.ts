import Phaser from 'phaser';

export interface AnimDef {
  key: string;
  loop: boolean;
  frames: { frame: string; duration: number }[];
}

/**
 * Register animations converted from the original .ani.xml files.
 * Keys are namespaced as `<textureKey>/<animName>`.
 */
export function registerAnimations(scene: Phaser.Scene, textureKey: string, defs: AnimDef[]): void {
  for (const def of defs) {
    const key = `${textureKey}/${def.key}`;
    if (scene.anims.exists(key)) continue;
    scene.anims.create({
      key,
      frames: def.frames.map((f) => ({
        key: textureKey,
        frame: f.frame,
        duration: f.duration,
      })),
      // Per-frame durations drive the timing; msPerFrame stays 0.
      repeat: def.loop ? -1 : 0,
    });
  }
}
