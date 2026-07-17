// Converts the original Castlevania C++ project's XML assets into
// Phaser-friendly JSON, and copies images/audio into public/assets.
//
// Usage: node tools/convert-assets.mjs [path-to-Castlevania-master]

import { XMLParser } from 'fast-xml-parser';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(
  process.argv[2] ?? '.cache/Castlevania-master',
  'src/GameCuaTao/Castlevania/Content'
);
const OUT = join(ROOT, 'public/assets');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['Sprite', 'Animation', 'Frame', 'object', 'objectgroup', 'property', 'layer', 'tileset'].includes(name),
});

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------------------
// Atlas: .atlas.xml -> Phaser atlas JSON (hash) + relative boundary boxes
// ---------------------------------------------------------------------------
function convertAtlas(xmlPath, imageFile) {
  const doc = parser.parse(readFileSync(xmlPath, 'utf8'));
  const sheet = doc.GameContent.Spritesheet;
  const frames = {};
  const boundaries = {};

  for (const sprite of asList(sheet.Sprite)) {
    const f = sprite.SpriteFrame;
    const frame = {
      x: Number(f.Left),
      y: Number(f.Top),
      w: Number(f.Width),
      h: Number(f.Height),
    };

    // Some frames use negative Left/Top as a draw-offset hack (e.g. Simon's
    // duck_01 draws the jump sprite 9px lower). Express that as a trimmed
    // frame: clamp the source rect and offset the sprite within its box.
    const offX = Math.max(0, -frame.x);
    const offY = Math.max(0, -frame.y);
    frames[sprite.ID] = {
      frame: { x: frame.x + offX, y: frame.y + offY, w: frame.w - offX, h: frame.h - offY },
      rotated: false,
      trimmed: offX > 0 || offY > 0,
      sourceSize: { w: frame.w, h: frame.h },
      spriteSourceSize: { x: offX, y: offY, w: frame.w - offX, h: frame.h - offY },
    };

    // SpriteBoundary is in absolute sheet coordinates; store it relative to the frame
    const b = sprite.SpriteBoundary;
    if (b) {
      boundaries[sprite.ID] = {
        x: Number(b.Left) - frame.x,
        y: Number(b.Top) - frame.y,
        w: Number(b.Width),
        h: Number(b.Height),
      };
    }
  }

  return {
    atlas: { frames, meta: { image: imageFile, format: 'RGBA8888', scale: '1' } },
    boundaries,
  };
}

// ---------------------------------------------------------------------------
// Animations: .ani.xml -> [{ key, loop, frames: [{ frame, duration }] }]
// ---------------------------------------------------------------------------
function convertAnimations(xmlPath) {
  const doc = parser.parse(readFileSync(xmlPath, 'utf8'));
  const anims = [];

  for (const anim of asList(doc.GameContent.Animations.Animation)) {
    const defaultTime = Number(anim.DefaultTime ?? 100);
    anims.push({
      key: anim.Name,
      loop: String(anim.IsLooping).toLowerCase() === 'true',
      frames: asList(anim.Frame).map((fr) => ({
        frame: fr.SpriteID,
        duration: Number(fr.Time ?? defaultTime),
      })),
    });
  }
  return anims;
}

// ---------------------------------------------------------------------------
// Map: .tmx -> simple JSON (background image + object groups)
// Rect objects (no gid): x,y = top-left. Tile objects (gid): x,y = bottom-left.
// ---------------------------------------------------------------------------
function convertMap(tmxPath) {
  const doc = parser.parse(readFileSync(tmxPath, 'utf8'));
  const map = doc.map;
  const props = (obj) =>
    Object.fromEntries(
      asList(obj.properties?.property).map((p) => [
        p.name,
        p.type === 'bool' ? p.value === 'true' : p.type === 'int' || p.type === 'float' ? Number(p.value) : p.value,
      ])
    );

  const groups = {};
  for (const group of asList(map.objectgroup)) {
    groups[group.name] = asList(group.object).map((o) => ({
      name: o.name,
      type: o.type,
      x: Number(o.x),
      y: Number(o.y),
      width: Number(o.width ?? 0),
      height: Number(o.height ?? 0),
      hasGid: o.gid != null, // gid objects anchor at bottom-left
      properties: props(o),
    }));
  }

  return {
    widthPx: Number(map.width) * Number(map.tilewidth),
    heightPx: Number(map.height) * Number(map.tileheight),
    tileSize: Number(map.tilewidth),
    backgroundColor: map.backgroundcolor ?? '#000000',
    groups,
  };
}

// ---------------------------------------------------------------------------
// Run conversions
// ---------------------------------------------------------------------------
mkdirSync(join(OUT, 'sprites'), { recursive: true });
mkdirSync(join(OUT, 'maps'), { recursive: true });
mkdirSync(join(OUT, 'audio/music'), { recursive: true });
mkdirSync(join(OUT, 'audio/sfx'), { recursive: true });

const characters = [
  { name: 'simon', dir: 'Characters/Players', base: 'Simon' },
  { name: 'whip', dir: 'Items', base: 'Whip' },
  { name: 'zombie', dir: 'Characters/Enemies', base: 'Zombie' },
  { name: 'panther', dir: 'Characters/Enemies', base: 'Panther' },
  { name: 'fishman', dir: 'Characters/Enemies', base: 'Fishman' },
  { name: 'vampire_bat', dir: 'Characters/Enemies', base: 'VampireBat' },
  { name: 'fireball', dir: 'Weapons', base: 'Fireball', noAnims: true },
  { name: 'giant_bat', dir: 'Characters/Enemies', base: 'GiantBat' },
  { name: 'crystal_ball', dir: 'Items', base: 'Crystal_Ball' },
  { name: 'axe_weapon', dir: 'Weapons', base: 'Axe' },
  { name: 'holy_water_weapon', dir: 'Weapons', base: 'Holy_Water' },
  { name: 'door', dir: 'Items', base: 'Door' },
  { name: 'menu_bat', dir: 'Backgrounds', base: 'Menu_Bat' },
  { name: 'brazier', dir: 'Items', base: 'Brazier' },
  { name: 'candle', dir: 'Items', base: 'Candle' },
  { name: 'flame', dir: 'Effects', base: 'Flame' },
  // atlas-only (no .ani.xml): static item sprites
  { name: 'money_bag', dir: 'Items', base: 'Money_Bag', noAnims: true },
  { name: 'large_heart', dir: 'Items', base: 'Large_Heart', noAnims: true },
  { name: 'whip_powerup', dir: 'Items', base: 'Whip_Powerup', noAnims: true },
  { name: 'dagger', dir: 'Items', base: 'Dagger', noAnims: true },
  { name: 'cross', dir: 'Items', base: 'Cross', noAnims: true },
  { name: 'holy_water', dir: 'Items', base: 'Holy_Water', noAnims: true },
  { name: 'axe', dir: 'Items', base: 'Axe', noAnims: true },
  { name: 'invisible_jar', dir: 'Items', base: 'Invisible_Jar', noAnims: true },
  { name: 'stopwatch', dir: 'Items', base: 'Stopwatch', noAnims: true },
  { name: 'pork_chop', dir: 'Items', base: 'Pork_Chop', noAnims: true },
  { name: 'double_shot', dir: 'Items', base: 'Double_Shot', noAnims: true },
];

for (const { name, dir, base, noAnims } of characters) {
  const { atlas, boundaries } = convertAtlas(join(SRC, dir, `${base}.atlas.xml`), `${name}.png`);
  writeFileSync(join(OUT, 'sprites', `${name}.atlas.json`), JSON.stringify(atlas, null, 2));
  writeFileSync(join(OUT, 'sprites', `${name}.boundaries.json`), JSON.stringify(boundaries, null, 2));
  copyFileSync(join(SRC, dir, `${base}.png`), join(OUT, 'sprites', `${name}.png`));
  let animCount = 0;
  if (!noAnims) {
    const anims = convertAnimations(join(SRC, dir, `${base}.ani.xml`));
    writeFileSync(join(OUT, 'sprites', `${name}.anims.json`), JSON.stringify(anims, null, 2));
    animCount = anims.length;
  }
  console.log(`converted ${name}: ${Object.keys(atlas.frames).length} frames, ${animCount} animations`);
}

// plain single-image sprites (no atlas at all)
const plainImages = [
  { name: 'small_heart', path: 'Items/Small_Heart.png' },
  { name: 'spark', path: 'Effects/Spark.png' },
  { name: 'water_splash', path: 'Effects/Water.png' },
  { name: 'debris', path: 'Effects/Debris.png' },
  { name: 'main_menu', path: 'Backgrounds/Main_Menu.png' },
  { name: 'block', path: 'TiledMaps/Stage_01/Block.png' },
  { name: 'block_top', path: 'TiledMaps/Stage_01/Block_01.png' },
  { name: 'block_bottom', path: 'TiledMaps/Stage_01/Block_02.png' },
  { name: 'score_100', path: 'Effects/100.png' },
  { name: 'score_400', path: 'Effects/400.png' },
  { name: 'score_700', path: 'Effects/700.png' },
];
for (const { name, path } of plainImages) {
  copyFileSync(join(SRC, path), join(OUT, 'sprites', `${name}.png`));
}
console.log(`copied ${plainImages.length} plain images`);

const maps = [
  { name: 'courtyard', base: 'Courtyard' },
  { name: 'greathall', base: 'Great_Hall' },
  { name: 'underground', base: 'Underground' },
];
for (const { name, base } of maps) {
  const map = convertMap(join(SRC, `TiledMaps/Stage_01/${base}.tmx`));
  writeFileSync(join(OUT, 'maps', `${name}.json`), JSON.stringify(map, null, 2));
  copyFileSync(join(SRC, `TiledMaps/Stage_01/${base}.png`), join(OUT, 'maps', `${name}.png`));
  console.log(`converted ${name} map: ${map.widthPx}x${map.heightPx}px, groups: ${Object.keys(map.groups).join(', ')}`);
}

for (const f of readdirSync(join(SRC, 'Sounds/Musics'))) {
  copyFileSync(join(SRC, 'Sounds/Musics', f), join(OUT, 'audio/music', f));
}
for (const f of readdirSync(join(SRC, 'Sounds/SoundEffects'))) {
  copyFileSync(join(SRC, 'Sounds/SoundEffects', f), join(OUT, 'audio/sfx', f));
}
console.log('copied audio files');
