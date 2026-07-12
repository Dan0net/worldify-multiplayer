/**
 * Camera layer reserved for the first-person view model (arm + held item).
 *
 * The arm lives in the main scene (so it's lit by the world's day/night lights)
 * but on this dedicated layer, so the normal composed render (camera layer 0)
 * excludes it, and a separate pass renders only this layer on top of everything.
 * The scene lights must also enable this layer, or they won't illuminate it.
 */
export const FIRST_PERSON_LAYER = 10;
