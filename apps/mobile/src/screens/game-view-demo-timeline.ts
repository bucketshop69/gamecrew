export type DemoSide = 'home' | 'away';

export type DemoPose =
  | 'idle'
  | 'jog'
  | 'sprint'
  | 'receive'
  | 'pass'
  | 'shoot'
  | 'dive'
  | 'celebrate';

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface DemoTeamShape {
  shiftY?: number;
  width?: number;
  depth?: number;
}

export interface DemoTeamShapeKeyframe {
  atMs: number;
  home: DemoTeamShape;
  away: DemoTeamShape;
}

export interface DemoActorKeyframe {
  atMs: number;
  point: NormalizedPoint;
  pose: DemoPose;
  facingDegrees: number;
}

export interface DemoActorTrack {
  id: string;
  side: DemoSide;
  keyframes: readonly DemoActorKeyframe[];
}

interface TimedBallEvent {
  fromMs: number;
  toMs: number;
  from: NormalizedPoint;
  to: NormalizedPoint;
}

export type DemoBallEvent =
  | (TimedBallEvent & { kind: 'carry'; ownerActorId: string })
  | (TimedBallEvent & {
      kind: 'pass';
      fromActorId: string;
      toActorId: string;
      curve: number;
    })
  | (TimedBallEvent & {
      kind: 'shot';
      shooterActorId: string;
      goalkeeperActorId: string;
      curve: number;
    })
  | (TimedBallEvent & { kind: 'settled' });

export interface DemoCameraKeyframe {
  atMs: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export type DemoBeatId =
  | 'establish'
  | 'build'
  | 'advance'
  | 'pressure'
  | 'switch'
  | 'opening'
  | 'through_ball'
  | 'shot'
  | 'goal'
  | 'celebration';

export interface DemoBeat {
  id: DemoBeatId;
  atMs: number;
  subjectSide: DemoSide;
  pressure: number;
}

export const GAME_VIEW_DEMO_DURATION_MS = 40_000;
export const GAME_VIEW_DEMO_SHOT_ARRIVAL_MS = 33_000;
export const GAME_VIEW_DEMO_SCORE_COMMIT_AT_MS = 33_050;
export const GAME_VIEW_DEMO_FINAL_HOLD_START_MS = 39_000;

export const gameViewDemoBeats: readonly DemoBeat[] = [
  { id: 'establish', atMs: 0, subjectSide: 'home', pressure: 0.08 },
  { id: 'build', atMs: 4_000, subjectSide: 'home', pressure: 0.16 },
  { id: 'advance', atMs: 9_000, subjectSide: 'home', pressure: 0.34 },
  { id: 'pressure', atMs: 15_000, subjectSide: 'away', pressure: 0.72 },
  { id: 'switch', atMs: 21_000, subjectSide: 'home', pressure: 0.78 },
  { id: 'opening', atMs: 26_000, subjectSide: 'home', pressure: 0.9 },
  { id: 'through_ball', atMs: 29_000, subjectSide: 'home', pressure: 0.96 },
  { id: 'shot', atMs: 32_000, subjectSide: 'home', pressure: 1 },
  { id: 'goal', atMs: GAME_VIEW_DEMO_SCORE_COMMIT_AT_MS, subjectSide: 'home', pressure: 0.34 },
  { id: 'celebration', atMs: 35_000, subjectSide: 'home', pressure: 0.1 },
];

export const gameViewDemoTeamShapes: readonly DemoTeamShapeKeyframe[] = [
  { atMs: 0, home: {}, away: {} },
  { atMs: 4_000, home: { shiftY: -0.02 }, away: {} },
  {
    atMs: 9_000,
    home: { shiftY: -0.07, width: 1.02 },
    away: { shiftY: -0.02, width: 0.96 },
  },
  {
    atMs: 15_300,
    home: { shiftY: -0.13, width: 1.02, depth: 0.92 },
    away: { shiftY: -0.055, width: 0.84, depth: 0.86 },
  },
  {
    atMs: 21_300,
    home: { shiftY: -0.17, width: 0.98, depth: 0.88 },
    away: { shiftY: -0.085, width: 0.76, depth: 0.78 },
  },
  {
    atMs: 27_300,
    home: { shiftY: -0.2, width: 0.92, depth: 0.84 },
    away: { shiftY: -0.1, width: 0.72, depth: 0.72 },
  },
  {
    atMs: 33_000,
    home: { shiftY: -0.21, width: 0.9, depth: 0.82 },
    away: { shiftY: -0.1, width: 0.7, depth: 0.7 },
  },
  {
    atMs: GAME_VIEW_DEMO_DURATION_MS,
    home: { shiftY: -0.21, width: 0.9, depth: 0.82 },
    away: { shiftY: -0.1, width: 0.7, depth: 0.7 },
  },
];

export const gameViewDemoCamera: readonly DemoCameraKeyframe[] = [
  { atMs: 0, scale: 1, offsetX: 0, offsetY: 0 },
  { atMs: 8_000, scale: 1.02, offsetX: 0, offsetY: 0.01 },
  { atMs: 15_000, scale: 1.05, offsetX: -0.01, offsetY: 0.03 },
  { atMs: 22_000, scale: 1.08, offsetX: 0.01, offsetY: 0.055 },
  { atMs: 29_000, scale: 1.12, offsetX: -0.02, offsetY: 0.085 },
  { atMs: 33_000, scale: 1.14, offsetX: 0, offsetY: 0.105 },
  { atMs: 36_500, scale: 1.12, offsetX: 0.11, offsetY: 0.105 },
  { atMs: GAME_VIEW_DEMO_DURATION_MS, scale: 1.12, offsetX: 0.11, offsetY: 0.105 },
];

export const gameViewDemoActors: readonly DemoActorTrack[] = [
  {
    id: 'h3',
    side: 'home',
    keyframes: [
      { atMs: 0, point: { x: 0.38, y: 0.82 }, pose: 'idle', facingDegrees: 0 },
      { atMs: 3_700, point: { x: 0.4, y: 0.77 }, pose: 'pass', facingDegrees: 6 },
      { atMs: 7_000, point: { x: 0.43, y: 0.72 }, pose: 'jog', facingDegrees: 4 },
      { atMs: 40_000, point: { x: 0.39, y: 0.56 }, pose: 'idle', facingDegrees: 0 },
    ],
  },
  {
    id: 'h7',
    side: 'home',
    keyframes: [
      { atMs: 0, point: { x: 0.5, y: 0.67 }, pose: 'idle', facingDegrees: 0 },
      { atMs: 4_000, point: { x: 0.49, y: 0.65 }, pose: 'receive', facingDegrees: -4 },
      { atMs: 9_000, point: { x: 0.54, y: 0.54 }, pose: 'pass', facingDegrees: 12 },
      { atMs: 20_000, point: { x: 0.56, y: 0.39 }, pose: 'jog', facingDegrees: 3 },
      { atMs: 21_000, point: { x: 0.54, y: 0.36 }, pose: 'receive', facingDegrees: -8 },
      { atMs: 22_500, point: { x: 0.52, y: 0.34 }, pose: 'pass', facingDegrees: -18 },
      { atMs: 40_000, point: { x: 0.46, y: 0.28 }, pose: 'idle', facingDegrees: 0 },
    ],
  },
  {
    id: 'h8',
    side: 'home',
    keyframes: [
      { atMs: 0, point: { x: 0.74, y: 0.65 }, pose: 'idle', facingDegrees: 0 },
      { atMs: 11_500, point: { x: 0.67, y: 0.5 }, pose: 'jog', facingDegrees: -8 },
      { atMs: 17_400, point: { x: 0.64, y: 0.39 }, pose: 'receive', facingDegrees: -12 },
      { atMs: 18_300, point: { x: 0.63, y: 0.36 }, pose: 'jog', facingDegrees: -16 },
      { atMs: 20_000, point: { x: 0.62, y: 0.34 }, pose: 'pass', facingDegrees: -22 },
      { atMs: 33_000, point: { x: 0.55, y: 0.26 }, pose: 'jog', facingDegrees: 0 },
      { atMs: GAME_VIEW_DEMO_FINAL_HOLD_START_MS, point: { x: 0.26, y: 0.13 }, pose: 'celebrate', facingDegrees: -18 },
      { atMs: GAME_VIEW_DEMO_DURATION_MS, point: { x: 0.26, y: 0.13 }, pose: 'celebrate', facingDegrees: -18 },
    ],
  },
  {
    id: 'h9',
    side: 'home',
    keyframes: [
      { atMs: 0, point: { x: 0.2, y: 0.51 }, pose: 'idle', facingDegrees: 0 },
      { atMs: 18_000, point: { x: 0.25, y: 0.32 }, pose: 'jog', facingDegrees: 6 },
      { atMs: 24_000, point: { x: 0.28, y: 0.27 }, pose: 'receive', facingDegrees: 10 },
      { atMs: 26_400, point: { x: 0.32, y: 0.22 }, pose: 'pass', facingDegrees: 18 },
      { atMs: 33_000, point: { x: 0.26, y: 0.18 }, pose: 'jog', facingDegrees: 0 },
      { atMs: 36_000, point: { x: 0.12, y: 0.08 }, pose: 'celebrate', facingDegrees: -22 },
      { atMs: 40_000, point: { x: 0.12, y: 0.08 }, pose: 'celebrate', facingDegrees: -22 },
    ],
  },
  {
    id: 'h10',
    side: 'home',
    keyframes: [
      { atMs: 0, point: { x: 0.5, y: 0.48 }, pose: 'idle', facingDegrees: 0 },
      { atMs: 21_000, point: { x: 0.49, y: 0.25 }, pose: 'jog', facingDegrees: 0 },
      { atMs: 26_400, point: { x: 0.48, y: 0.19 }, pose: 'receive', facingDegrees: -12 },
      { atMs: 28_200, point: { x: 0.49, y: 0.17 }, pose: 'pass', facingDegrees: 16 },
      { atMs: 30_000, point: { x: 0.51, y: 0.14 }, pose: 'sprint', facingDegrees: -4 },
      { atMs: 31_200, point: { x: 0.54, y: 0.11 }, pose: 'receive', facingDegrees: 2 },
      { atMs: 32_000, point: { x: 0.55, y: 0.095 }, pose: 'shoot', facingDegrees: 0 },
      { atMs: 35_700, point: { x: 0.17, y: 0.105 }, pose: 'celebrate', facingDegrees: -28 },
      { atMs: 40_000, point: { x: 0.17, y: 0.105 }, pose: 'celebrate', facingDegrees: -28 },
    ],
  },
  {
    id: 'h11',
    side: 'home',
    keyframes: [
      { atMs: 0, point: { x: 0.8, y: 0.51 }, pose: 'idle', facingDegrees: 0 },
      { atMs: 12_000, point: { x: 0.79, y: 0.45 }, pose: 'receive', facingDegrees: -6 },
      { atMs: 13_200, point: { x: 0.78, y: 0.42 }, pose: 'jog', facingDegrees: -9 },
      { atMs: 17_400, point: { x: 0.76, y: 0.34 }, pose: 'pass', facingDegrees: -15 },
      { atMs: 24_000, point: { x: 0.71, y: 0.25 }, pose: 'jog', facingDegrees: -9 },
      { atMs: 28_200, point: { x: 0.67, y: 0.16 }, pose: 'receive', facingDegrees: -14 },
      { atMs: 29_400, point: { x: 0.65, y: 0.13 }, pose: 'pass', facingDegrees: -18 },
      { atMs: 30_200, point: { x: 0.63, y: 0.12 }, pose: 'sprint', facingDegrees: -20 },
      { atMs: 33_000, point: { x: 0.48, y: 0.115 }, pose: 'jog', facingDegrees: -26 },
      { atMs: 35_300, point: { x: 0.22, y: 0.09 }, pose: 'celebrate', facingDegrees: -32 },
      { atMs: 40_000, point: { x: 0.22, y: 0.09 }, pose: 'celebrate', facingDegrees: -32 },
    ],
  },
  {
    id: 'a4',
    side: 'away',
    keyframes: [
      { atMs: 0, point: { x: 0.62, y: 0.18 }, pose: 'idle', facingDegrees: 180 },
      { atMs: 13_500, point: { x: 0.66, y: 0.2 }, pose: 'jog', facingDegrees: 174 },
      { atMs: 22_000, point: { x: 0.58, y: 0.16 }, pose: 'jog', facingDegrees: 190 },
      { atMs: 29_800, point: { x: 0.57, y: 0.12 }, pose: 'sprint', facingDegrees: 186 },
      { atMs: 40_000, point: { x: 0.6, y: 0.17 }, pose: 'idle', facingDegrees: 180 },
    ],
  },
  {
    id: 'a1',
    side: 'away',
    keyframes: [
      { atMs: 0, point: { x: 0.5, y: 0.06 }, pose: 'idle', facingDegrees: 180 },
      { atMs: 30_500, point: { x: 0.52, y: 0.06 }, pose: 'idle', facingDegrees: 180 },
      { atMs: 32_000, point: { x: 0.54, y: 0.055 }, pose: 'dive', facingDegrees: 165 },
      { atMs: 33_000, point: { x: 0.45, y: 0.055 }, pose: 'dive', facingDegrees: 165 },
      { atMs: 40_000, point: { x: 0.45, y: 0.055 }, pose: 'dive', facingDegrees: 165 },
    ],
  },
  {
    id: 'a11',
    side: 'away',
    keyframes: [
      { atMs: 0, point: { x: 0.88, y: 0.49 }, pose: 'idle', facingDegrees: 180 },
      { atMs: 6_500, point: { x: 0.86, y: 0.48 }, pose: 'jog', facingDegrees: 194 },
      { atMs: 12_000, point: { x: 0.88, y: 0.43 }, pose: 'sprint', facingDegrees: 200 },
      { atMs: 17_400, point: { x: 0.86, y: 0.35 }, pose: 'jog', facingDegrees: 192 },
      { atMs: 24_000, point: { x: 0.82, y: 0.26 }, pose: 'jog', facingDegrees: 188 },
      { atMs: 30_000, point: { x: 0.78, y: 0.2 }, pose: 'sprint', facingDegrees: 184 },
      { atMs: 33_000, point: { x: 0.74, y: 0.22 }, pose: 'idle', facingDegrees: 180 },
      { atMs: GAME_VIEW_DEMO_FINAL_HOLD_START_MS, point: { x: 0.74, y: 0.26 }, pose: 'idle', facingDegrees: 180 },
      { atMs: GAME_VIEW_DEMO_DURATION_MS, point: { x: 0.74, y: 0.26 }, pose: 'idle', facingDegrees: 180 },
    ],
  },
];

export const gameViewDemoBallEvents: readonly DemoBallEvent[] = [
  { kind: 'carry', fromMs: 0, toMs: 4_000, ownerActorId: 'h3', from: { x: 0.38, y: 0.805 }, to: { x: 0.4, y: 0.755 } },
  { kind: 'pass', fromMs: 4_000, toMs: 5_200, fromActorId: 'h3', toActorId: 'h7', curve: -0.035, from: { x: 0.4, y: 0.755 }, to: { x: 0.49, y: 0.635 } },
  { kind: 'carry', fromMs: 5_200, toMs: 12_000, ownerActorId: 'h7', from: { x: 0.49, y: 0.635 }, to: { x: 0.54, y: 0.52 } },
  { kind: 'pass', fromMs: 12_000, toMs: 13_200, fromActorId: 'h7', toActorId: 'h11', curve: -0.055, from: { x: 0.54, y: 0.52 }, to: { x: 0.79, y: 0.435 } },
  { kind: 'carry', fromMs: 13_200, toMs: 17_400, ownerActorId: 'h11', from: { x: 0.79, y: 0.435 }, to: { x: 0.76, y: 0.325 } },
  { kind: 'pass', fromMs: 17_400, toMs: 18_200, fromActorId: 'h11', toActorId: 'h8', curve: 0.035, from: { x: 0.76, y: 0.325 }, to: { x: 0.64, y: 0.375 } },
  { kind: 'carry', fromMs: 18_200, toMs: 20_000, ownerActorId: 'h8', from: { x: 0.64, y: 0.375 }, to: { x: 0.6, y: 0.325 } },
  { kind: 'pass', fromMs: 20_000, toMs: 21_000, fromActorId: 'h8', toActorId: 'h7', curve: 0.025, from: { x: 0.6, y: 0.325 }, to: { x: 0.54, y: 0.345 } },
  { kind: 'carry', fromMs: 21_000, toMs: 22_500, ownerActorId: 'h7', from: { x: 0.54, y: 0.345 }, to: { x: 0.52, y: 0.325 } },
  { kind: 'pass', fromMs: 22_500, toMs: 24_000, fromActorId: 'h7', toActorId: 'h9', curve: -0.06, from: { x: 0.52, y: 0.325 }, to: { x: 0.28, y: 0.255 } },
  { kind: 'carry', fromMs: 24_000, toMs: 26_400, ownerActorId: 'h9', from: { x: 0.28, y: 0.255 }, to: { x: 0.32, y: 0.205 } },
  { kind: 'pass', fromMs: 26_400, toMs: 27_200, fromActorId: 'h9', toActorId: 'h10', curve: 0.035, from: { x: 0.32, y: 0.205 }, to: { x: 0.48, y: 0.175 } },
  { kind: 'carry', fromMs: 27_200, toMs: 28_200, ownerActorId: 'h10', from: { x: 0.48, y: 0.175 }, to: { x: 0.49, y: 0.155 } },
  { kind: 'pass', fromMs: 28_200, toMs: 29_400, fromActorId: 'h10', toActorId: 'h11', curve: 0.045, from: { x: 0.49, y: 0.155 }, to: { x: 0.67, y: 0.145 } },
  { kind: 'carry', fromMs: 29_400, toMs: 30_000, ownerActorId: 'h11', from: { x: 0.67, y: 0.145 }, to: { x: 0.65, y: 0.12 } },
  { kind: 'pass', fromMs: 30_000, toMs: 31_200, fromActorId: 'h11', toActorId: 'h10', curve: -0.05, from: { x: 0.65, y: 0.12 }, to: { x: 0.54, y: 0.095 } },
  { kind: 'carry', fromMs: 31_200, toMs: 32_000, ownerActorId: 'h10', from: { x: 0.54, y: 0.095 }, to: { x: 0.55, y: 0.08 } },
  { kind: 'shot', fromMs: 32_000, toMs: GAME_VIEW_DEMO_SHOT_ARRIVAL_MS, shooterActorId: 'h10', goalkeeperActorId: 'a1', curve: 0.035, from: { x: 0.55, y: 0.08 }, to: { x: 0.54, y: 0.018 } },
  { kind: 'settled', fromMs: GAME_VIEW_DEMO_SHOT_ARRIVAL_MS, toMs: GAME_VIEW_DEMO_DURATION_MS, from: { x: 0.54, y: 0.018 }, to: { x: 0.54, y: 0.018 } },
];

export const gameViewDemoReducedMotionSnapshot = {
  atMs: 28_000,
  ball: { x: 0.49, y: 0.155 },
  beatId: 'opening' as const,
};

export function getGameViewDemoActorPoint(
  actorId: string,
  atMs: number,
): NormalizedPoint | undefined {
  const actor = gameViewDemoActors.find((candidate) => candidate.id === actorId);
  if (!actor) return undefined;

  const clampedMs = Math.min(GAME_VIEW_DEMO_DURATION_MS, Math.max(0, atMs));
  let from = actor.keyframes[0];
  let to = actor.keyframes[actor.keyframes.length - 1];
  for (let index = 1; index < actor.keyframes.length; index += 1) {
    if (clampedMs <= actor.keyframes[index].atMs) {
      to = actor.keyframes[index];
      from = actor.keyframes[index - 1];
      break;
    }
  }

  const duration = to.atMs - from.atMs;
  const progress = duration === 0 ? 1 : (clampedMs - from.atMs) / duration;
  return {
    x: from.point.x + (to.point.x - from.point.x) * progress,
    y: from.point.y + (to.point.y - from.point.y) * progress,
  };
}

export function validateGameViewDemoTimeline(): readonly string[] {
  const errors: string[] = [];
  const actorIds = new Set(gameViewDemoActors.map((actor) => actor.id));
  const timedCollections: ReadonlyArray<ReadonlyArray<{ atMs: number }>> = [
    gameViewDemoBeats,
    gameViewDemoTeamShapes,
    gameViewDemoCamera,
    ...gameViewDemoActors.map((actor) => actor.keyframes),
  ];

  if (GAME_VIEW_DEMO_DURATION_MS < 38_000 || GAME_VIEW_DEMO_DURATION_MS > 42_000) {
    errors.push('Demo duration must stay between 38 and 42 seconds.');
  }

  for (const collection of timedCollections) {
    for (let index = 1; index < collection.length; index += 1) {
      if (collection[index].atMs <= collection[index - 1].atMs) {
        errors.push('Timeline keyframes must be strictly ordered.');
      }
    }
  }

  const allPoints = [
    ...gameViewDemoActors.flatMap((actor) => actor.keyframes.map((keyframe) => keyframe.point)),
    ...gameViewDemoBallEvents.flatMap((event) => [event.from, event.to]),
  ];
  if (allPoints.some((point) => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
    errors.push('All demo coordinates must stay inside the pitch.');
  }

  for (let index = 0; index < gameViewDemoBallEvents.length; index += 1) {
    const event = gameViewDemoBallEvents[index];
    const previous = gameViewDemoBallEvents[index - 1];
    if (event.toMs <= event.fromMs || (previous && event.fromMs !== previous.toMs)) {
      errors.push('Ball events must be positive-duration and contiguous.');
    }
    const references = event.kind === 'carry'
      ? [event.ownerActorId]
      : event.kind === 'pass'
        ? [event.fromActorId, event.toActorId]
        : event.kind === 'shot'
          ? [event.shooterActorId, event.goalkeeperActorId]
          : [];
    if (references.some((reference) => !actorIds.has(reference))) {
      errors.push('Ball events may reference only authored demo actors.');
    }
  }

  if (GAME_VIEW_DEMO_SCORE_COMMIT_AT_MS < GAME_VIEW_DEMO_SHOT_ARRIVAL_MS) {
    errors.push('The score cannot commit before the shot reaches the goal.');
  }
  if (GAME_VIEW_DEMO_FINAL_HOLD_START_MS >= GAME_VIEW_DEMO_DURATION_MS) {
    errors.push('The final hold must begin before the demo ends.');
  }

  return errors;
}
