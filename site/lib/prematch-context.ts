import type { PredictionSnapshot } from './vct-types.ts';

export type PrematchReaderContext = {
  schemaVersion: 'prematch-reader-evidence-v1';
  cutoffAt: string;
  recentMatches: Array<{
    reference: string;
    matchId: string;
    team: string;
    opponent: string;
    teamScore: number;
    opponentScore: number;
    playedAt: string;
    knownAt: string;
    sourceUrl: string;
  }>;
  limits: string[];
};
// Invalid auxiliary context must degrade the explanation, not block a valid
// frozen mathematical prediction. No current/final state is accepted here.
export function validatedPrematchContext(
  value: unknown,
  prediction: PredictionSnapshot,
): PrematchReaderContext | null {
  const context = value as PrematchReaderContext;
  const cutoff = Date.parse(prediction.lockedAt);
  if (
    !context ||
    context.schemaVersion !== 'prematch-reader-evidence-v1' ||
    Date.parse(context.cutoffAt) !== cutoff ||
    !Number.isFinite(cutoff) ||
    !Array.isArray(context.recentMatches) ||
    context.recentMatches.length > 6 ||
    !Array.isArray(context.limits)
  )
    return null;
  const seen = new Set<string>();
  for (const match of context.recentMatches) {
    const side =
      match.team === prediction.teamA
        ? 'team_a'
        : match.team === prediction.teamB
          ? 'team_b'
          : null;
    if (
      !side ||
      !/^vlr_match_\d+$/.test(match.matchId) ||
      match.reference !== `history:${side}:${match.matchId}` ||
      seen.has(match.reference) ||
      typeof match.opponent !== 'string' ||
      !match.opponent.trim() ||
      match.opponent.length > 100 ||
      ![match.teamScore, match.opponentScore].every(
        (n) => Number.isInteger(n) && n >= 0 && n <= 3,
      ) ||
      !(Date.parse(match.playedAt) < cutoff) ||
      !(Date.parse(match.knownAt) < cutoff) ||
      !new RegExp(
        `^https://(?:www\\.)?vlr\\.gg/${match.matchId.slice(10)}(?:/|$)`,
      ).test(match.sourceUrl)
    )
      return null;
    seen.add(match.reference);
  }
  if (
    [prediction.teamA, prediction.teamB].some(
      (team) => context.recentMatches.filter((m) => m.team === team).length > 3,
    )
  )
    return null;
  return {
    schemaVersion: context.schemaVersion,
    cutoffAt: context.cutoffAt,
    recentMatches: context.recentMatches.map((m) => ({ ...m })),
    limits: context.limits
      .filter((x) => typeof x === 'string')
      .slice(0, 4)
      .map((x) => x.slice(0, 180)),
  };
}
