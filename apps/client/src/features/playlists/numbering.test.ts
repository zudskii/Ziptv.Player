import { describe, expect, it } from 'vitest';

import { numberingProblem } from './numbering';

describe('numberingProblem', () => {
  it('accepts schemes that fit', () => {
    expect(numberingProblem(1, 1, 50_000)).toBeNull();
    expect(numberingProblem(100, 10, 100)).toBeNull();
    expect(numberingProblem(99_999, 1, 1)).toBeNull();
    expect(numberingProblem(1, 1, 0)).toBeNull();
  });

  it('rejects bad starts and steps', () => {
    expect(numberingProblem(0, 1, 10)).toMatch(/Start/);
    expect(numberingProblem(1.5, 1, 10)).toMatch(/Start/);
    expect(numberingProblem(Number.NaN, 1, 10)).toMatch(/Start/);
    expect(numberingProblem(1, 0, 10)).toMatch(/step/);
    expect(numberingProblem(1, 1001, 10)).toMatch(/at most 1000/);
  });

  it('says where it would end when it does not fit', () => {
    expect(numberingProblem(99_999, 1, 2)).toMatch(/100,000/);
    expect(numberingProblem(1, 10, 20_000)).toMatch(/199,991/);
  });
});
