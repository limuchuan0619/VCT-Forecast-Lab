import type { PostmatchScorecard, PredictionSnapshot, ResultEvidenceEnvelope } from './vct-types';

export const SCORECARD_VERSION = 'v1.4c-r1-scorecard-v1' as const;
export const SURPRISE_THRESHOLD_VERSION = 'v1.4c-r1-surprise-thresholds-v1' as const;
const EPSILON = 1e-15;

function expectedSeriesWins(seriesFormat: 'bo3' | 'bo5'): number {
  return seriesFormat === 'bo5' ? 3 : 2;
}

export function isTerminalMapScore(teamAScore: number, teamBScore: number): boolean {
  const winner = Math.max(teamAScore, teamBScore);
  const loser = Math.min(teamAScore, teamBScore);
  if (!Number.isInteger(winner) || !Number.isInteger(loser) || loser < 0 || winner < 13) return false;
  return winner === 13 ? loser <= 11 : winner - loser === 2;
}

export function validateActualScore(
  prediction: Pick<PredictionSnapshot, 'teamA' | 'teamB' | 'seriesFormat'>,
  winner: string,
  score: string,
): [number, number] {
  if (![prediction.teamA, prediction.teamB].includes(winner)) throw new Error('actual_winner_not_in_match');
  const match = /^(\d+)-(\d+)$/.exec(score);
  if (!match) throw new Error('invalid_actual_score');
  const teamAScore = Number(match[1]);
  const teamBScore = Number(match[2]);
  const target = expectedSeriesWins(prediction.seriesFormat);
  if (Math.max(teamAScore, teamBScore) !== target || Math.min(teamAScore, teamBScore) >= target || teamAScore === teamBScore) {
    throw new Error('invalid_actual_score_for_format');
  }
  if ((teamAScore > teamBScore ? prediction.teamA : prediction.teamB) !== winner) throw new Error('winner_score_conflict');
  return [teamAScore, teamBScore];
}

export function validateResultEvidence(
  prediction: PredictionSnapshot,
  winner: string,
  score: string,
  evidence: ResultEvidenceEnvelope,
): ResultEvidenceEnvelope {
  if (!evidence || evidence.schemaVersion !== 'v1.4c-r1-result-evidence-v1') throw new Error('invalid_result_evidence_version');
  if (evidence.series.actualWinner !== winner || evidence.series.actualScore !== score) throw new Error('result_evidence_series_conflict');
  if (evidence.series.scheduledAt !== prediction.scheduledAt || evidence.series.seriesFormat !== prediction.seriesFormat) throw new Error('result_evidence_match_conflict');
  if (!evidence.source.sourceId || !Number.isFinite(Date.parse(evidence.source.capturedAt))) throw new Error('invalid_result_evidence_source');
  if (Date.parse(evidence.source.capturedAt) < Date.parse(prediction.scheduledAt)) throw new Error('result_evidence_captured_before_scheduled');
  if (evidence.series.playedAt != null && !Number.isFinite(Date.parse(evidence.series.playedAt))) throw new Error('invalid_result_evidence_played_at');
  if (!Array.isArray(evidence.maps) || !evidence.missing || !('playerStats' in evidence)) throw new Error('invalid_result_evidence_shape');
  const [teamAMaps, teamBMaps] = validateActualScore(prediction, winner, score);
  const expectedMapCount = teamAMaps + teamBMaps;
  if (evidence.maps.length === 0) {
    throw new Error('result_map_evidence_required');
  } else if (evidence.missing.maps || evidence.maps.length !== expectedMapCount) {
    throw new Error('incomplete_result_map_evidence');
  }
  let reconstructedTeamAMaps = 0;
  let reconstructedTeamBMaps = 0;
  for (const map of evidence.maps) {
    if (!Number.isInteger(map.order) || map.order < 1 || !map.map || !Number.isInteger(map.teamAScore) || !Number.isInteger(map.teamBScore)
      || map.teamAScore < 0 || map.teamBScore < 0 || ![prediction.teamA, prediction.teamB].includes(map.winner)
      || (map.teamAScore > map.teamBScore ? prediction.teamA : prediction.teamB) !== map.winner
      || !Array.isArray(map.missingFields)) throw new Error('invalid_result_map_evidence');
    if (!isTerminalMapScore(map.teamAScore, map.teamBScore)) throw new Error('incomplete_result_map_score');
    if (map.winner === prediction.teamA) reconstructedTeamAMaps += 1;
    else reconstructedTeamBMaps += 1;
  }
  if (reconstructedTeamAMaps !== teamAMaps || reconstructedTeamBMaps !== teamBMaps) throw new Error('result_map_series_inconsistent');
  if (evidence.maps.some((map, index) => map.order !== index + 1)) throw new Error('invalid_result_map_order');
  if (evidence.playerStats !== null && !Array.isArray(evidence.playerStats)) throw new Error('invalid_result_player_stats');
  if (evidence.playerStats && evidence.playerStats.some((row) => !Number.isInteger(Number(row.mapOrder))
    || Number(row.mapOrder) < 1 || Number(row.mapOrder) > evidence.maps.length)) throw new Error('invalid_result_player_map_order');
  return evidence;
}

export function validateResultCorrection(
  prediction: PredictionSnapshot,
  winner: string,
  score: string,
  evidence: ResultEvidenceEnvelope,
): void {
  if (prediction.source && !prediction.source.startsWith('system')) throw new Error('result_correction_system_prediction_required');
  if (prediction.status !== 'resolved' || !prediction.actualWinner || !prediction.actualScore || !prediction.resultEvidence || !prediction.scorecard) {
    throw new Error('result_correction_resolved_evidence_required');
  }
  const previous = prediction.resultEvidence;
  if (previous.source.sourceId !== evidence.source.sourceId
    || previous.source.sourceMatchId !== evidence.source.sourceMatchId
    || (previous.source.sourceUrl ?? null) !== (evidence.source.sourceUrl ?? null)) throw new Error('result_correction_source_conflict');
  if (Date.parse(evidence.source.capturedAt) <= Date.parse(previous.source.capturedAt)) throw new Error('result_correction_not_newer');
  let previousComplete = true;
  try { validateResultEvidence(prediction, prediction.actualWinner, prediction.actualScore, previous); } catch { previousComplete = false; }
  if (previousComplete) throw new Error('result_correction_previous_evidence_complete');
  validateResultEvidence(prediction, winner, score, evidence);
}

export function computePostmatchScorecard(
  prediction: PredictionSnapshot,
  actualWinner: string,
  actualScore: string,
): PostmatchScorecard {
  validateActualScore(prediction, actualWinner, actualScore);
  const predictedWinner = prediction.teamAProbability >= 0.5 ? prediction.teamA : prediction.teamB;
  const outcome = actualWinner === prediction.teamA ? 1 : 0;
  const actualWinnerProbability = outcome ? prediction.teamAProbability : 1 - prediction.teamAProbability;
  const bounded = Math.min(Math.max(actualWinnerProbability, EPSILON), 1 - EPSILON);
  const winnerSurprisal = -Math.log(bounded);
  const actualScoreProbability = Number.isFinite(prediction.scoreDistribution[actualScore])
    ? prediction.scoreDistribution[actualScore]
    : null;
  const scorelineSurprisal = actualScoreProbability != null && actualScoreProbability > 0
    ? -Math.log(Math.max(actualScoreProbability, EPSILON))
    : null;
  const surpriseLevel: PostmatchScorecard['surpriseLevel'] = actualWinnerProbability >= 0.5 ? 'low'
    : actualWinnerProbability >= 0.3 ? 'moderate'
      : actualWinnerProbability >= 0.1 ? 'high' : 'very_high';
  return {
    schemaVersion: SCORECARD_VERSION,
    thresholdVersion: SURPRISE_THRESHOLD_VERSION,
    predictedWinner,
    actualWinner,
    winnerCorrect: predictedWinner === actualWinner,
    predictedScore: prediction.predictedScore,
    actualScore,
    exactScoreCorrect: prediction.predictedScore === actualScore,
    actualWinnerProbability,
    actualScoreProbability,
    brierScore: (prediction.teamAProbability - outcome) ** 2,
    logLoss: winnerSurprisal,
    winnerSurprisal,
    scorelineSurprisal,
    directionReversal: predictedWinner !== actualWinner,
    surpriseLevel,
  };
}
