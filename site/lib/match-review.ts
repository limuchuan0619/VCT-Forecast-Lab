import type { PredictionSnapshot, PredictionRecord } from './vct-types.ts';
import { postmatchPacketMatchesRecord } from './evidence-presentation.ts';
import { readerInsights, validateReaderReview } from './reader-analysis.ts';
import {
  EVIDENCE_REVIEW_SCHEMA,
  EVIDENCE_REVIEW_POLICY,
  validateEvidenceArticle,
} from './review-evidence.ts';

// Descriptive match evidence, not causal attribution or a new model feature.
export function teamResults(prediction: PredictionSnapshot) {
  if (
    prediction.status !== 'resolved' ||
    !prediction.resultEvidence ||
    ![prediction.teamA, prediction.teamB].includes(
      prediction.actualWinner ?? '',
    )
  )
    return [];
  return [prediction.teamA, prediction.teamB].map((team) => ({
    team,
    outcome:
      team === prediction.actualWinner ? ('won' as const) : ('lost' as const),
    wonMaps: prediction
      .resultEvidence!.maps.filter((map) => map.winner === team)
      .map((map) => ({
        order: map.order,
        map: map.map,
        score: `${map.teamAScore}:${map.teamBScore}`,
        evidenceId: `fact:map:${map.order}`,
      })),
    lostMaps: prediction
      .resultEvidence!.maps.filter((map) => map.winner !== team)
      .map((map) => ({
        order: map.order,
        map: map.map,
        score: `${map.teamAScore}:${map.teamBScore}`,
        evidenceId: `fact:map:${map.order}`,
      })),
  }));
}

export function mapExpectationChecks(prediction: PredictionSnapshot) {
  return (prediction.resultEvidence?.maps ?? []).map((actual) => {
    const expected = prediction.maps.find((map) => map.map === actual.map);
    const p = expected?.teamAProbability;
    const valid = typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 1;
    const favored =
      !valid || p === 0.5
        ? null
        : p > 0.5
          ? prediction.teamA
          : prediction.teamB;
    return {
      ...actual,
      probabilityTeamA: valid ? p : null,
      favored,
      assessment: !valid
        ? ('unavailable' as const)
        : favored === null
          ? ('close' as const)
          : actual.winner === favored
            ? ('matched' as const)
            : ('reversed' as const),
    };
  });
}

export function verifiedTeamReviews(record: PredictionRecord) {
  const packet = record.postmatchEvidence;
  if (!packet || !postmatchPacketMatchesRecord(packet, record)) return [];
  const items = record.postmatchReview?.team_reviews;
  if (
    !Array.isArray(items) ||
    items.length !== 2 ||
    new Set(items.map((item) => item.team)).size !== 2
  )
    return [];
  const known = new Set(packet.evidenceReferences);
  const valid = items.every(
    (item) =>
      [record.teamA, record.teamB].includes(item.team) &&
      item.outcome === (item.team === record.actualWinner ? 'won' : 'lost') &&
      [item.strengths, item.weaknesses].every(
        (list) =>
          Array.isArray(list) &&
          list.length <= 2 &&
          list.every(
            (claim) =>
              typeof claim.claim === 'string' &&
              claim.claim.trim().length > 0 &&
              claim.claim.length <= 180 &&
              claim.evidence_ids?.length > 0 &&
              claim.evidence_ids.every(
                (id) => id.startsWith('fact:') && known.has(id),
              ),
          ),
      ) &&
      (!item.possible_explanation ||
        (typeof item.possible_explanation.claim === 'string' &&
          item.possible_explanation.claim.trim().length > 0 &&
          item.possible_explanation.claim.length <= 180 &&
          item.possible_explanation.evidence_ids?.length > 0 &&
          item.possible_explanation.evidence_ids.every(
            (id) => id.startsWith('fact:') && known.has(id),
          ))),
  );
  return valid ? items : [];
}

export function verifiedReaderReview(record: PredictionRecord) {
  const packet = record.postmatchEvidence;
  const review = record.postmatchReview?.reader_review;
  if (
    !packet?.readerInsights ||
    !review ||
    !postmatchPacketMatchesRecord(packet, record)
  )
    return null;
  // Bind persisted source statistics, not today's derived selection or display
  // names. A new candidate-selection policy must not hide a valid old article.
  const current = readerInsights(record);
  const comparable = (maps: typeof current.maps) =>
    maps.map((map) => ({
      ...map,
      players: map.players
        .map(({ name: _name, ...player }) => player)
        .sort((a, b) => a.id.localeCompare(b.id)),
    }));
  if (
    JSON.stringify(comparable(packet.readerInsights.maps)) !==
    JSON.stringify(comparable(current.maps))
  )
    return null;
  try {
    validateReaderReview(
      review,
      packet.readerInsights,
      packet.evidenceReferences,
      {
        advisory:
          record.postmatchReview?.reader_editorial_policy ===
          EVIDENCE_REVIEW_POLICY,
      },
    );
    if (
      record.postmatchReview?.reader_evidence_version === EVIDENCE_REVIEW_SCHEMA
    )
      validateEvidenceArticle(
        record.postmatchReview as unknown as Record<string, unknown>,
        packet.readerInsights,
        [record.teamA, record.teamB],
        packet.evidenceReferences,
      );
    return review;
  } catch {
    return null;
  }
}
