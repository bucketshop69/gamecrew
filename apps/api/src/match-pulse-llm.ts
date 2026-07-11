import {
  applyTxlineMatchPulseLlmJson,
  buildTxlineMatchPulseEnrichmentPrompt,
  parseTxlineMatchPulseLlmJson,
  validateTxlineMatchPulseMoment,
  validateTxlineMatchPulseMoments,
  type MatchPulseCommentaryEntry,
  type MatchPulseMoment,
  type TxlineMatchPulseSourceContext,
  type TxlineMatchPulseValidationReport,
} from '@gamecrew/core';
import type { ApiConfig } from './config.js';

export interface MatchPulseEnrichmentService {
  enrichMoments(
    context: TxlineMatchPulseSourceContext,
    fallbackMoments: readonly MatchPulseMoment[],
  ): Promise<MatchPulseEnrichmentResult>;
  enrichCommentaryEntries(
    context: TxlineMatchPulseSourceContext,
    pendingEntries: readonly MatchPulseCommentaryEntry[],
    previousEntries: readonly MatchPulseCommentaryEntry[],
  ): Promise<MatchPulseCommentaryEnrichmentResult>;
}

export interface MatchPulseEnrichmentResult {
  moments: readonly MatchPulseMoment[];
  reports: readonly TxlineMatchPulseValidationReport[];
  provider: 'disabled' | 'openai-compatible';
}

export interface MatchPulseCommentaryEnrichmentResult {
  entries: readonly MatchPulseCommentaryEntry[];
  provider: 'disabled' | 'openai-compatible';
  attempted: number;
  completed: number;
  failed: number;
}

interface MatchPulseCommentaryLlmJson {
  commentary: string;
  voiceLine?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export function createMatchPulseEnrichmentService(config: ApiConfig): MatchPulseEnrichmentService {
  if (!config.llmEnabled || !config.llmBaseUrl) {
    return {
      async enrichMoments(context, fallbackMoments) {
        const validated = validateTxlineMatchPulseMoments(context, fallbackMoments);
        return {
          moments: validated.moments,
          reports: validated.reports,
          provider: 'disabled',
        };
      },
      async enrichCommentaryEntries() {
        return {
          entries: [],
          provider: 'disabled',
          attempted: 0,
          completed: 0,
          failed: 0,
        };
      },
    };
  }

  return new OpenAiCompatibleMatchPulseEnrichmentService(config);
}

class OpenAiCompatibleMatchPulseEnrichmentService implements MatchPulseEnrichmentService {
  constructor(private readonly config: ApiConfig) {}

  async enrichMoments(
    context: TxlineMatchPulseSourceContext,
    fallbackMoments: readonly MatchPulseMoment[],
  ): Promise<MatchPulseEnrichmentResult> {
    const results = [];
    for (const fallbackMoment of fallbackMoments) {
      results.push(await this.enrichMoment(context, fallbackMoment));
    }

    return {
      moments: results.map((result) => result.moment),
      reports: results.map((result) => result.report),
      provider: 'openai-compatible',
    };
  }

  async enrichCommentaryEntries(
    context: TxlineMatchPulseSourceContext,
    pendingEntries: readonly MatchPulseCommentaryEntry[],
    previousEntries: readonly MatchPulseCommentaryEntry[],
  ): Promise<MatchPulseCommentaryEnrichmentResult> {
    const enrichedEntries: MatchPulseCommentaryEntry[] = [];
    const previousContext = [...previousEntries];
    let failed = 0;

    for (const entry of pendingEntries) {
      try {
        const prompt = buildCommentaryEnrichmentPrompt(context, entry, previousContext);
        const content = await this.createChatCompletion(prompt);
        const llmJson = parseCommentaryLlmJson(content);
        const enriched = applyCommentaryLlmJson(context, entry, llmJson);
        enrichedEntries.push(enriched);
        previousContext.push(enriched);
      } catch (error) {
        failed += 1;
        console.warn(JSON.stringify({
          event: 'match_pulse_commentary_enrichment_failed',
          entryId: entry.id,
          reason: error instanceof Error ? error.message : 'Unknown enrichment error',
        }));
        enrichedEntries.push({
          ...entry,
          enrichmentStatus: 'failed',
        });
      }
    }

    return {
      entries: enrichedEntries,
      provider: 'openai-compatible',
      attempted: pendingEntries.length,
      completed: enrichedEntries.filter((entry) => entry.enrichmentStatus === 'complete').length,
      failed,
    };
  }

  private async enrichMoment(
    context: TxlineMatchPulseSourceContext,
    fallbackMoment: MatchPulseMoment,
  ) {
    try {
      const prompt = buildTxlineMatchPulseEnrichmentPrompt(context, fallbackMoment);
      const content = await this.createChatCompletion(prompt.messages);
      const llmJson = parseTxlineMatchPulseLlmJson(content);
      const candidate = applyTxlineMatchPulseLlmJson(fallbackMoment, llmJson);
      return validateTxlineMatchPulseMoment(context, candidate, { fallbackMoment });
    } catch {
      return validateTxlineMatchPulseMoment(context, fallbackMoment, { fallbackMoment });
    }
  }

  private async createChatCompletion(messages: readonly { role: 'system' | 'user'; content: string }[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.llmTimeoutMs);
    try {
      const response = await fetch(`${this.config.llmBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.llmApiKey ? { Authorization: `Bearer ${this.config.llmApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.llmModel,
          messages,
          temperature: 0.4,
          ...getProviderRequestOptions(this.config.llmModel),
          max_tokens: 220,
          max_completion_tokens: 220,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LLM request failed with ${response.status}`);
      }

      const payload = await response.json() as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('LLM response did not include message content.');
      }

      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildCommentaryEnrichmentPrompt(
  context: TxlineMatchPulseSourceContext,
  entry: MatchPulseCommentaryEntry,
  previousEntries: readonly MatchPulseCommentaryEntry[],
): readonly { role: 'system' | 'user'; content: string }[] {
  const modelInput = {
    match: {
      home: context.homeTeam.name,
      away: context.awayTeam.name,
    },
    current: {
      kind: entry.kind,
      clock: entry.clock.label,
      score: entry.scoreAtMoment ? `${entry.scoreAtMoment.home}-${entry.scoreAtMoment.away}` : undefined,
      team: entry.team?.name,
      events: [...entry.sourceEvents]
        .sort(compareSourceEventsBySeq)
        .map((source) => ({
          seq: source.seq,
          action: source.action ?? source.label,
        })),
    },
    recent: previousEntries
      .filter((previous) => previous.commentary.trim().length > 0)
      .slice(-4)
      .map((previous) => ({
        clock: previous.clock.label,
        actions: [...previous.sourceEvents]
          .sort(compareSourceEventsBySeq)
          .map((source) => source.action ?? source.label)
          .filter((action): action is string => Boolean(action)),
        commentary: previous.commentary,
      })),
  };

  return [
    {
      role: 'system',
      content: [
        'You are GameCrew Match Pulse, a football commentator following the match moment by moment.',
        'Sound like a human commentator speaking to supporters who are following live, not like an event log, notification template, or data analyst.',
        '',
        'CONTINUITY:',
        'Write only the current update, but treat recent commentary as words you have already spoken during the same live broadcast.',
        'Make the new line answer: what changed since the previous line?',
        'If recent actions show a repeated event, acknowledge it naturally with another, again, still, or the pressure continues.',
        'Never say another or again unless the supplied records establish the earlier action.',
        'The interface already shows the minute. Omit it from routine commentary unless timing itself makes the moment significant.',
        'Do not keep repeating the score, competition, matchup, or both full team names when listeners already have that context.',
        '',
        'VOICE:',
        'Use natural spoken football English with varied sentence openings and rhythm.',
        'A routine free kick, corner, shot, or pressure update needs one connected sentence. Do not add a second sentence merely for colour.',
        'Confirmed goals and major incidents may breathe for two or three short sentences. There is no fixed word or character target.',
        'Be lively when the facts deserve it, but do not manufacture drama.',
        'Avoid event-log phrasing, stat-list phrasing, and stock lines such as looking to, setting the tempo, building pressure, knocking on the door, early doors, warning signs, or asking questions.',
        'For kickoff, prefer one direct line such as "And we are underway" or "[Team] get us underway". Do not say kickoff and the game begins in the same line.',
        '',
        'STYLE EXAMPLE — copy the conversational movement, never its facts or bracketed placeholders:',
        '"[Team] get us underway."',
        '"[Team] take an early throw-in before winning a free kick moments later."',
        '"Another one for [Team] moments later. [Opponent] have barely managed to get out."',
        '"That spell now brings a shot from [Team]."',
        '"That early pressure continues: a corner for [Team], followed by two efforts."',
        '',
        'GROUNDING:',
        'The current object and its events are the only authority for what happened now. Recent records are narrative context, not evidence for a new current fact.',
        'Cover every material current action. If current events contain two shots and one corner, the commentary must account for both the shots and the corner.',
        'Use current event seq values to preserve the order in which the actions happened.',
        'Sparse event data is not full play-by-play. Do not invent causal links, player names, formations, injuries, exact locations, possession, chance quality, or event outcomes.',
        'Do not mention the box, goalkeeper, save, miss, block, clearance, delivery, cross, header, goal, card, penalty, VAR, or score change unless that fact is explicitly supplied for the current entry.',
        'In particular, when current events contain only shots, corners, free kicks, or throw-ins, do not use goal, goalward, goalmouth, net, scorer, opener, breakthrough, or scoring language.',
        'Never expose confidence, verification, source, validation, action-label, or schema terminology to the supporter.',
        '',
        'OUTPUT:',
        'Return only valid JSON.',
        'Use exactly this shape: {"commentary":"...","voiceLine":"optional shorter spoken alternative"}.',
        'Omit voiceLine when it would merely repeat commentary.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify(modelInput),
    },
  ];
}

function compareSourceEventsBySeq(
  left: MatchPulseCommentaryEntry['sourceEvents'][number],
  right: MatchPulseCommentaryEntry['sourceEvents'][number],
): number {
  return (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER);
}

function getProviderRequestOptions(model: string): Record<string, unknown> {
  if (/^MiniMax-M3$/i.test(model)) {
    return {
      thinking: {
        type: 'disabled',
      },
    };
  }

  return {};
}

function parseCommentaryLlmJson(content: string): MatchPulseCommentaryLlmJson {
  const parsed = JSON.parse(extractJsonObject(content));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Commentary LLM response is not a JSON object.');
  }

  const candidate = parsed as Partial<MatchPulseCommentaryLlmJson>;
  if (typeof candidate.commentary !== 'string') {
    throw new Error('Commentary LLM response must include commentary.');
  }

  return {
    commentary: candidate.commentary,
    voiceLine: typeof candidate.voiceLine === 'string' ? candidate.voiceLine : undefined,
  };
}

function applyCommentaryLlmJson(
  context: TxlineMatchPulseSourceContext,
  entry: MatchPulseCommentaryEntry,
  llmJson: MatchPulseCommentaryLlmJson,
): MatchPulseCommentaryEntry {
  validateCommentaryLlmJson(context, entry, llmJson);

  return {
    ...entry,
    commentary: llmJson.commentary.trim(),
    voiceLine: llmJson.voiceLine?.trim(),
    generation: 'llm',
    enrichmentStatus: 'complete',
    fallbackCommentary: entry.fallbackCommentary,
  };
}

function validateCommentaryLlmJson(
  context: TxlineMatchPulseSourceContext,
  entry: MatchPulseCommentaryEntry,
  llmJson: MatchPulseCommentaryLlmJson,
): void {
  const commentary = llmJson.commentary.trim();
  const voiceLine = llmJson.voiceLine?.trim();
  const combined = `${commentary} ${voiceLine ?? ''}`;
  if (!commentary) {
    throw new Error('Commentary must be non-empty.');
  }

  if (/\b(?:verified|verdict|confidence|source[_ -]?backed)\b/i.test(combined)) {
    throw new Error('Commentary cannot expose validation or confidence metadata.');
  }

  const sourceActions = new Set(entry.sourceEvents.map((source) => String(source.action ?? '').toLowerCase()));
  assertNoUnsupportedClaim(combined, 'goal', entry.kind === 'goal' || sourceActions.has('goal'));
  assertNoUnsupportedClaim(combined, 'penalty', entry.kind === 'penalty' || sourceActions.has('penalty'));
  assertNoUnsupportedClaim(combined, 'var', entry.kind === 'var' || sourceActions.has('var'));
  assertNoUnsupportedClaim(
    combined,
    'red card',
    entry.kind === 'card' || sourceActions.has('red_card') || sourceActions.has('yellow_card'),
  );
  assertNoUnsupportedClaim(
    combined,
    'yellow card',
    entry.kind === 'card' || sourceActions.has('red_card') || sourceActions.has('yellow_card'),
  );

  if (/\b(odds?|bet|bets|betting|wager|price)\b/i.test(combined)) {
    throw new Error('Commentary cannot include betting language.');
  }

  const scoreClaim = combined.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);
  if (scoreClaim && entry.scoreAtMoment) {
    const home = Number(scoreClaim[1]);
    const away = Number(scoreClaim[2]);
    if (home !== entry.scoreAtMoment.home || away !== entry.scoreAtMoment.away) {
      throw new Error('Commentary score claim does not match source score.');
    }
  }

  const sourceIds = new Set(context.sourceEvents.map((source) => source.sourceRef.id).filter(Boolean));
  for (const sourceEvent of entry.sourceEvents) {
    if (sourceEvent.id && !sourceIds.has(sourceEvent.id)) {
      throw new Error(`Commentary references unknown source event ${sourceEvent.id}.`);
    }
  }
}

function assertNoUnsupportedClaim(text: string, phrase: string, allowed: boolean): void {
  if (!allowed && new RegExp(`\\b${phrase}\\b`, 'i').test(text)) {
    throw new Error(`Commentary made unsupported ${phrase} claim.`);
  }
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
