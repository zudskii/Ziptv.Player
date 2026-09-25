import type { ParseWarning, ParseWarningCode } from './types.js';

/** Collects warnings with a storage cap while still counting every occurrence. */
export class WarningCollector {
  private readonly items: ParseWarning[] = [];
  private total = 0;

  constructor(private readonly limit: number) {}

  add(line: number, code: ParseWarningCode, message: string): void {
    this.total++;
    if (this.items.length < this.limit) this.items.push({ line, code, message });
  }

  get warnings(): ParseWarning[] {
    return this.items;
  }

  get count(): number {
    return this.total;
  }
}

export function preview(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
