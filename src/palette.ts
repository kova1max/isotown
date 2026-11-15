// The isotown palette. Every colour on screen comes from here, shaded into a
// small fixed set of tones, which is what keeps the output reading as pixel art.

export type RGB = readonly [number, number, number];

export const WALLS = {
  brick: [158, 88, 62],
  darkBrick: [120, 70, 56],
  cream: [222, 202, 158],
  white: [230, 226, 214],
  ochre: [212, 164, 94],
  pink: [214, 168, 150],
  greyStone: [178, 172, 160],
  concrete: [168, 170, 166],
  blueGrey: [146, 160, 172],
  metal: [136, 152, 160],
  stone: [196, 184, 158],
} as const satisfies Record<string, RGB>;

export const ROOFS = {
  terracotta: [178, 82, 58],
  brownTile: [128, 76, 52],
  slate: [80, 86, 98],
  darkGrey: [96, 96, 100],
  gravel: [164, 160, 150],
  lightGravel: [186, 182, 172],
  tar: [112, 110, 108],
  copper: [92, 152, 132],
  green: [96, 116, 84],
  metalRoof: [150, 160, 166],
} as const satisfies Record<string, RGB>;

export const GROUND = {
  void: [24, 28, 38],
  grass: [122, 152, 78],
  grassDark: [112, 142, 72],
  park: [110, 158, 74],
  forest: [74, 112, 58],
  scrub: [104, 128, 70],
  farm: [176, 168, 104],
  pitch: [96, 164, 82],
  track: [176, 96, 74],
  sand: [222, 204, 150],
  rock: [160, 154, 144],
  paving: [196, 186, 164],
  pavingLine: [186, 176, 155],
  plaza: [206, 194, 168],
  parking: [132, 132, 132],
  concreteLot: [178, 176, 166],
  dirt: [168, 146, 108],
  water: [62, 112, 176],
  waterLight: [76, 128, 190],
  waterEdge: [156, 198, 232],
  asphalt: [88, 88, 96],
  asphaltMajor: [80, 80, 88],
  sidewalk: [178, 172, 160],
  footway: [204, 192, 166],
  marking: [236, 232, 214],
  markingYellow: [232, 196, 80],
  ballast: [138, 126, 112],
  rail: [64, 60, 58],
  slabTop: [132, 96, 62],
  slabDark: [96, 68, 44],
  slabStripe: [112, 80, 52],
} as const satisfies Record<string, RGB>;

export const TREE = {
  leafLight: [118, 172, 74],
  leafMid: [82, 138, 58],
  leafDark: [54, 100, 46],
  needleLight: [78, 132, 78],
  needleMid: [54, 104, 62],
  needleDark: [36, 76, 48],
  trunk: [102, 72, 48],
} as const satisfies Record<string, RGB>;

export const WINDOW = {
  day: [44, 58, 80],
  dayGlint: [104, 132, 166],
  shop: [56, 74, 98],
  lit: [255, 214, 112],
  litWarm: [255, 236, 168],
} as const satisfies Record<string, RGB>;

/** Scale a colour, clamped. */
export function shade(c: RGB, f: number): RGB {
  return [clamp(c[0] * f), clamp(c[1] * f), clamp(c[2] * f)];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [clamp(a[0] + (b[0] - a[0]) * t), clamp(a[1] + (b[1] - a[1]) * t), clamp(a[2] + (b[2] - a[2]) * t)];
}

function clamp(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
}
