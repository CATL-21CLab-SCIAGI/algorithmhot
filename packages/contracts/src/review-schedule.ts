/** Each review shares the day's 600-call budget; these are cumulative research ceilings. */
export const REVIEW_CALL_CEILINGS = { 9: 290, 15: 435, 21: 580 } as const;
export type ReviewPolicy = "twice-daily" | "three-times-daily";

export function reviewCallCeiling(hour: number, correction = false): number {
  if (!Object.hasOwn(REVIEW_CALL_CEILINGS, hour)) throw new Error("Invalid scheduled review hour");
  // Explicit source correction retains its existing full-day allowance. It shares the
  // same ledger, so any advance usage reduces the later review's remaining allowance.
  return correction ? 580 : REVIEW_CALL_CEILINGS[hour as keyof typeof REVIEW_CALL_CEILINGS];
}
