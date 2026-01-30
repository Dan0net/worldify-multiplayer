/**
 * Game mode states
 *
 * Defines the possible states the client can be in.
 * Used for controlling camera, input handling, and UI visibility.
 */
export enum GameMode {
  /** Initial state - shows main menu/start screen, camera orbits */
  MainMenu = 'main-menu',

  /** Spectating - observing the game, camera orbits around world */
  Spectating = 'spectating',

  /** Playing - active gameplay with FPS controls */
  Playing = 'playing',
}
