import type { TxlineScore } from './types';

export function parseTxlineScoreEvents(text: string): readonly TxlineScore[] {
  const directJson = parseScoreEventPayload(text.trim());
  if (directJson.length > 0) {
    return directJson;
  }

  const events: TxlineScore[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }

    const payload = dataLines.join('\n').trim();
    events.push(...parseScoreEventPayload(payload));
    dataLines = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      flush();
      continue;
    }

    const normalizedLine = line.replace(/^\uFEFF/, '');
    if (normalizedLine.startsWith(':')) {
      continue;
    }

    const separator = normalizedLine.indexOf(':');
    const field = separator === -1 ? normalizedLine : normalizedLine.slice(0, separator);
    if (field !== 'data') {
      continue;
    }

    const value = separator === -1 ? '' : normalizedLine.slice(separator + 1).replace(/^ /, '');
    if (value.trim() !== '[DONE]') {
      dataLines.push(value);
    }
  }

  flush();
  return events;
}

function parseScoreEventPayload(payload: string): readonly TxlineScore[] {
  if (!payload) {
    return [];
  }

  try {
    return collectScoreEvents(JSON.parse(payload));
  } catch {
    return payload
      .split(/\r?\n/)
      .flatMap((line) => {
        try {
          return collectScoreEvents(JSON.parse(line.trim()));
        } catch {
          return [];
        }
      });
  }
}

function collectScoreEvents(value: unknown): readonly TxlineScore[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectScoreEvents);
  }

  if (typeof value === 'string') {
    return parseScoreEventPayload(value);
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (
    'Seq' in record ||
    'seq' in record ||
    'Action' in record ||
    'action' in record ||
    'Clock' in record
  ) {
    return [record as unknown as TxlineScore];
  }

  for (const key of ['scores', 'Scores', 'events', 'Events', 'items', 'Items', 'data', 'payload']) {
    const childEvents = collectScoreEvents(record[key]);
    if (childEvents.length > 0) {
      return childEvents;
    }
  }

  return [];
}
