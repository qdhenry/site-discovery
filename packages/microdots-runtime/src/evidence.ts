/** Browser-safe advisory evidence contract. Stages are assigned by the owning
 * application from its ledger; no model answer may promote a stage. */
import { Schema as S } from 'effect'
export const EvidenceStage = S.Literals(['proposed', 'implemented', 'observed'])
export type EvidenceStage = typeof EvidenceStage.Type
export const EvidenceRequirement = S.Struct({
  id: S.NonEmptyString, source: S.NonEmptyString, behavior: S.NonEmptyString,
})
export type EvidenceRequirement = typeof EvidenceRequirement.Type
export const EvidenceFact = S.Struct({
  id: S.NonEmptyString, label: S.NonEmptyString, stage: EvidenceStage,
  /** Literal operation contract, source fact or owned assertion; not a model summary. */
  text: S.NonEmptyString, reference: S.NonEmptyString, digest: S.NonEmptyString,
})
export type EvidenceFact = typeof EvidenceFact.Type
export const EvidenceSnapshot = S.Struct({
  owner: S.NonEmptyString, revision: S.NonEmptyString, stage: EvidenceStage,
  brief: S.NonEmptyString, requirements: S.NonEmptyArray(EvidenceRequirement), facts: S.Array(EvidenceFact),
})
export type EvidenceSnapshot = typeof EvidenceSnapshot.Type
export const EvidenceRow = S.Struct({
  requirement: EvidenceRequirement,
  clarity: S.Literals(['atomic', 'compound', 'ambiguous', 'unmeasured']),
  disposition: S.Literals(['review-match', 'needs-evidence', 'decompose', 'unknown']),
  /** Heuristic signals, not calibrated probabilities of delivery. */
  signals: S.Record(S.String, S.Finite),
  factIds: S.Array(S.String),
})
export type EvidenceRow = typeof EvidenceRow.Type
export const EvidenceMatrix = S.Struct({
  snapshot: EvidenceSnapshot, snapshotHash: S.String, policyVersion: S.String, model: S.String,
  rows: S.Array(EvidenceRow), evaluatedAt: S.Finite, inputTokens: S.Natural, elapsedMs: S.Finite,
})
export type EvidenceMatrix = typeof EvidenceMatrix.Type
