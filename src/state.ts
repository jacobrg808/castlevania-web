// Player progress that persists across map transitions (and later, deaths).
export interface GameState {
  score: number;
  hearts: number;
  health: number;
  lives: number;
  /** Shown in the HUD as "STAGE nn"; Block 1 is all stage 1 */
  stage: number;
  whipLevel: number;
  subweapon: string | null;
  /** 'double_shot' allows two subweapon throws per cooldown */
  powerup: string | null;
}

export const MAX_HEALTH = 16;
export const WHIP_MAX_LEVEL = 3;

export const gameState: GameState = {
  score: 0,
  hearts: 5,
  health: MAX_HEALTH,
  lives: 3,
  stage: 1,
  whipLevel: 1,
  subweapon: null,
  powerup: null,
};

export function resetGameState(keepScore = false): void {
  Object.assign(gameState, {
    score: keepScore ? gameState.score : 0,
    hearts: 5,
    health: MAX_HEALTH,
    lives: 3,
    stage: 1,
    whipLevel: 1,
    subweapon: null,
    powerup: null,
  });
}
