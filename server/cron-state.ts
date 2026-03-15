// Shared cron job state - avoids circular imports between index.ts and router.ts
export const cronState = {
  running: false,
  lastRun: null as string | null,
  lastResult: null as string | null,
  intervalHours: 1,
};
