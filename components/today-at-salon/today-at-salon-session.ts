export const TODAY_AT_SALON_DELAY_MS = 3_000;

export function shouldOpenTodayAtSalon(input: {
  reducedMotion: boolean;
  hasBlockingInteraction: boolean;
}): boolean {
  return !input.reducedMotion && !input.hasBlockingInteraction;
}
