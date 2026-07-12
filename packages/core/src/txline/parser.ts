import type { TxlineScore, TxlineSseMessage } from './types';

interface IncrementalTextDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

type IncrementalTextDecoderConstructor = new () => IncrementalTextDecoder;

export class TxlineSseDecoder {
  private readonly decoder: IncrementalTextDecoder;
  private buffer = '';

  constructor() {
    const Decoder = (globalThis as typeof globalThis & {
      TextDecoder: IncrementalTextDecoderConstructor;
    }).TextDecoder;
    if (!Decoder) {
      throw new Error('TxLINE SSE decoding requires TextDecoder.');
    }
    this.decoder = new Decoder();
  }

  push(chunk: string | Uint8Array): readonly TxlineSseMessage[] {
    this.buffer += typeof chunk === 'string'
      ? chunk
      : this.decoder.decode(chunk, { stream: true });
    return this.drainCompleteBlocks();
  }

  finish(): readonly TxlineSseMessage[] {
    this.buffer += this.decoder.decode();
    const messages = [...this.drainCompleteBlocks()];
    const trailing = parseTxlineSseBlock(this.buffer);
    this.buffer = '';
    if (trailing) messages.push(trailing);
    return messages;
  }

  private drainCompleteBlocks(): TxlineSseMessage[] {
    const messages: TxlineSseMessage[] = [];
    let separator = this.buffer.match(/\r?\n\r?\n/);
    while (separator?.index !== undefined) {
      const block = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      const message = parseTxlineSseBlock(block);
      if (message) messages.push(message);
      separator = this.buffer.match(/\r?\n\r?\n/);
    }
    return messages;
  }
}

export function parseTxlineSseBlock(block: string): TxlineSseMessage | undefined {
  const message: TxlineSseMessage = { data: '' };
  const dataLines: string[] = [];

  for (const sourceLine of block.split(/\r?\n/)) {
    const line = sourceLine.replace(/^\uFEFF/, '');
    if (!line || line.startsWith(':')) continue;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') dataLines.push(value);
    if (field === 'event') message.event = value;
    if (field === 'id') message.id = value;
    if (field === 'retry') {
      const retry = Number(value);
      if (Number.isFinite(retry) && retry >= 0) message.retry = retry;
    }
  }

  message.data = dataLines.join('\n');
  return message.data || message.event !== undefined || message.id !== undefined || message.retry !== undefined
    ? message
    : undefined;
}

export function parseTxlineScoreEvents(text: string): readonly TxlineScore[] {
  const directJson = parseScoreEventPayload(text.trim());
  if (directJson.length > 0) {
    return directJson;
  }

  const decoder = new TxlineSseDecoder();
  const messages = [...decoder.push(text), ...decoder.finish()];
  return messages.flatMap((message) => message.data.trim() === '[DONE]'
    ? []
    : parseScoreEventPayload(message.data.trim()));
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

export function parseTxlineScoreEventData(payload: string): readonly TxlineScore[] {
  return parseScoreEventPayload(payload.trim());
}
