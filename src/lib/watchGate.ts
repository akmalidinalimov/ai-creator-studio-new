/**
 * Decide whether a lesson counts as "genuinely watched" and may therefore be
 * marked complete (via the "Mark complete" button OR the silent completion in the
 * "Next" button). This is the anti-cheat gate that keeps watched-stats / XP honest.
 *
 * Rules:
 *  - Text / homework lessons (no video) → always allowed; there is nothing to watch.
 *  - A video lesson with a KNOWN duration → require watching at least half.
 *  - A video lesson with an UNKNOWN duration → require real watch time as evidence.
 *    Bunny reports no duration until the video is actually PLAYED, so treating
 *    "unknown duration" as "watched enough" let un-played videos be marked watched
 *    (the bulk false-"completed" stats bug). Requiring evidence closes that.
 */
export function watchedEnough(opts: {
  isTextLesson: boolean;
  durationSeconds: number;
  watchedSeconds: number;
}): boolean {
  const { isTextLesson, durationSeconds, watchedSeconds } = opts;
  if (isTextLesson) return true;
  if (durationSeconds > 0) return watchedSeconds >= durationSeconds * 0.5;
  // Unknown duration (not played yet, or the player never reported it): require
  // at least a minute of genuine playback so tapping through un-played videos
  // can't complete them.
  return watchedSeconds >= 60;
}
