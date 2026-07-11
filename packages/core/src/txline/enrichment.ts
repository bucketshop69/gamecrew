import type {
  MatchPulseBoardHint,
  MatchPulseMoment,
  MatchPulseMomentConfidence,
  MatchPulseMomentType,
  MatchPulseSourceEventRef,
} from '../match';
import type { TxlineMatchPulseSourceContext } from './types';

export interface TxlineMatchPulseEnrichmentPrompt {
  modelInput: TxlineMatchPulseEnrichmentInput;
  messages: readonly TxlineMatchPulseChatMessage[];
}

export interface TxlineMatchPulseChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface TxlineMatchPulseEnrichmentInput {
  fixture: {
    fixtureId: string;
    matchup: string;
    competition: string;
  };
  moment: {
    id: string;
    type: MatchPulseMomentType;
    clock: string;
    score?: string;
    team?: string;
    confidence: MatchPulseMomentConfidence;
    fallbackTitle: string;
    fallbackBody?: string;
  };
  sourceFacts: readonly TxlineMatchPulseSourceFact[];
  constraints: readonly string[];
}

export interface TxlineMatchPulseSourceFact {
  id?: string;
  seq?: number;
  action?: string;
  clock?: string;
  team?: string;
  confirmed?: boolean;
}

export interface TxlineMatchPulseLlmJson {
  title: string;
  body: string;
  voiceLine?: string;
  confidence?: MatchPulseMomentConfidence;
  type?: MatchPulseMomentType;
  boardHint?: MatchPulseBoardHint;
}

export function buildTxlineMatchPulseEnrichmentPrompt(
  context: TxlineMatchPulseSourceContext,
  moment: MatchPulseMoment,
): TxlineMatchPulseEnrichmentPrompt {
  const modelInput = buildTxlineMatchPulseEnrichmentInput(context, moment);
  return {
    modelInput,
    messages: [
      {
        role: 'system',
        content: [
          'You are GameCrew Match Pulse, a live football commentator and tactical assistant.',
          'Write concise, speakable commentary from only the provided source facts.',
          'Do not invent player names, formations, ball locations, betting language, injuries, cards, goals, or tactical claims not present in the source facts.',
          'Return only valid JSON with keys: title, body, optional voiceLine, optional confidence, optional type, optional boardHint.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify(modelInput),
      },
    ],
  };
}

export function buildTxlineMatchPulseEnrichmentInput(
  context: TxlineMatchPulseSourceContext,
  moment: MatchPulseMoment,
): TxlineMatchPulseEnrichmentInput {
  return {
    fixture: {
      fixtureId: context.fixture.fixtureId,
      matchup: `${context.homeTeam.name} vs ${context.awayTeam.name}`,
      competition: context.fixture.competition,
    },
    moment: {
      id: moment.id,
      type: moment.type,
      clock: moment.clock.label,
      score: moment.scoreAtMoment ? `${moment.scoreAtMoment.home}-${moment.scoreAtMoment.away}` : undefined,
      team: moment.team?.name,
      confidence: moment.confidence,
      fallbackTitle: moment.fallbackTitle,
      fallbackBody: moment.fallbackBody,
    },
    sourceFacts: moment.sourceEvents.map(toSourceFact),
    constraints: [
      'Use only the sourceFacts and moment fields.',
      'Keep title under 8 words.',
      'Keep body under 24 words.',
      'Keep voiceLine under 20 words when present.',
      'Do not mention odds, betting, wagers, formations, player roles, or exact ball movement.',
      'Use cautious language for inferred or low-confidence moments.',
    ],
  };
}

export function applyTxlineMatchPulseLlmJson(
  moment: MatchPulseMoment,
  llmJson: TxlineMatchPulseLlmJson,
): MatchPulseMoment {
  return {
    ...moment,
    title: llmJson.title,
    body: llmJson.body,
    voiceLine: llmJson.voiceLine,
    type: llmJson.type ?? moment.type,
    confidence: llmJson.confidence ?? moment.confidence,
    generation: 'llm',
    boardHint: llmJson.boardHint ?? moment.boardHint,
    fallbackTitle: moment.fallbackTitle,
    fallbackBody: moment.fallbackBody,
  };
}

export function parseTxlineMatchPulseLlmJson(content: string): TxlineMatchPulseLlmJson {
  const parsed = JSON.parse(extractJsonObject(content));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a JSON object.');
  }

  const candidate = parsed as Partial<TxlineMatchPulseLlmJson>;
  if (typeof candidate.title !== 'string' || typeof candidate.body !== 'string') {
    throw new Error('LLM response must include string title and body.');
  }

  return {
    title: candidate.title,
    body: candidate.body,
    voiceLine: typeof candidate.voiceLine === 'string' ? candidate.voiceLine : undefined,
    confidence: candidate.confidence,
    type: candidate.type,
    boardHint: candidate.boardHint,
  };
}

function toSourceFact(source: MatchPulseSourceEventRef): TxlineMatchPulseSourceFact {
  return {
    id: source.id,
    seq: source.seq,
    action: source.action,
    clock: source.clock?.label,
    team: source.teamName,
    confirmed: source.confirmed,
  };
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error('LLM response did not contain a JSON object.');
}
