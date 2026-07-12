/**
 * Camera layers reserved for the first-person view model.
 *
 * The arm + held item live in the main scene (so they're lit by the world's
 * day/night lights) but on dedicated layers, so the normal composed render
 * (camera layer 0) excludes them, and separate passes render only these layers on
 * top of everything. The scene lights must also enable these layers, or they
 * won't illuminate them.
 *
 * The arm and the held item are on separate layers so the item can be drawn in a
 * second depth-cleared sub-pass — always on top of the arm, never z-fighting it.
 */
export const FIRST_PERSON_LAYER = 10;      // the arm
export const FIRST_PERSON_ITEM_LAYER = 11; // the held build item (drawn over the arm)
