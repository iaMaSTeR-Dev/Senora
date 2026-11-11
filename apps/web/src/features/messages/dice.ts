export interface DiceResult { outcome: number; slots: number[] }

export function parseDiceResult(value: unknown): DiceResult | undefined {
  if (!value || typeof value !== 'object') return;
  const p=value as Partial<DiceResult>;
  if (!Number.isInteger(p.outcome)||p.outcome!<1||p.outcome!>6||!Array.isArray(p.slots)||p.slots.length!==3||!p.slots.every(n=>Number.isInteger(n)&&n>=0&&n<5))return;
  return {outcome:p.outcome!,slots:p.slots};
}

function randomBelow(limit: number): number {
  const byte = new Uint8Array(1); const ceiling = 256 - (256 % limit);
  do { crypto.getRandomValues(byte); } while (byte[0] >= ceiling);
  return byte[0] % limit;
}

export function newDiceResult(): DiceResult {
  return { outcome: randomBelow(6) + 1, slots: [randomBelow(5), randomBelow(5), randomBelow(5)] };
}

export async function legacyDiceResult(messageId: string): Promise<DiceResult> {
  // Historical emoji-only messages have no recorded result. Display the same
  // deterministic result on every device, instead of rerolling during rendering.
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`senora.legacy-dice:${messageId}`));
  const bytes = new Uint8Array(data);
  return { outcome: (bytes[0] % 6) + 1, slots: [bytes[1] % 5, bytes[2] % 5, bytes[3] % 5] };
}
