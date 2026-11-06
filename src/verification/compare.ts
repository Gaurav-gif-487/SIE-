/**
 * Compare primary evidence (a set of call sites the engine's own analysis
 * established) against challenge evidence (the same, from an independently
 * implemented mechanism — see challenge.ts). Disagreement is reported, never
 * silently reconciled: this module never merges the two sets into one
 * "corrected" answer.
 */

export type ComparisonOutcome = "CONFIRMED" | "CONTRADICTED" | "PARTIALLY_CONFIRMED" | "CONFLICTING" | "UNVERIFIED";

export interface EvidenceComparison {
  outcome: ComparisonOutcome;
  primaryCount: number;
  challengeCount: number;
  agreedCount: number;
  onlyInPrimary: string[];
  onlyInChallenge: string[];
  explanation: string;
}

export function compareEvidence(primarySites: string[], challengeSites: string[]): EvidenceComparison {
  const primary = new Set(primarySites);
  const challenge = new Set(challengeSites);
  const onlyInPrimary = [...primary].filter((s) => !challenge.has(s)).sort();
  const onlyInChallenge = [...challenge].filter((s) => !primary.has(s)).sort();
  const agreedCount = primary.size - onlyInPrimary.length;

  if (primary.size === 0 && challenge.size === 0) {
    return {
      outcome: "UNVERIFIED",
      primaryCount: 0,
      challengeCount: 0,
      agreedCount: 0,
      onlyInPrimary,
      onlyInChallenge,
      explanation: "neither the primary analysis nor the challenge found any candidate site",
    };
  }

  if (onlyInPrimary.length === 0 && onlyInChallenge.length === 0) {
    return {
      outcome: "CONFIRMED",
      primaryCount: primary.size,
      challengeCount: challenge.size,
      agreedCount,
      onlyInPrimary,
      onlyInChallenge,
      explanation: "the independent mechanism established exactly the same sites",
    };
  }

  if (agreedCount === 0) {
    return {
      outcome: "CONTRADICTED",
      primaryCount: primary.size,
      challengeCount: challenge.size,
      agreedCount,
      onlyInPrimary,
      onlyInChallenge,
      explanation: "the independent mechanism agrees with none of the primary sites",
    };
  }

  if (onlyInPrimary.length === 0 && onlyInChallenge.length > 0) {
    // Every primary claim was corroborated; the challenge additionally found
    // sites the primary did not. Challenge mechanisms documented in
    // challenge.ts are known to be over-inclusive relative to the primary
    // path, so this is expected, not a red flag — but it is still reported,
    // not discarded.
    return {
      outcome: "PARTIALLY_CONFIRMED",
      primaryCount: primary.size,
      challengeCount: challenge.size,
      agreedCount,
      onlyInPrimary,
      onlyInChallenge,
      explanation: "every primary site was corroborated; the challenge also reported additional sites",
    };
  }

  // Either the challenge failed to corroborate some primary sites, or both
  // sets have sites the other lacks: real disagreement about completeness,
  // not just breadth.
  return {
    outcome: "CONFLICTING",
    primaryCount: primary.size,
    challengeCount: challenge.size,
    agreedCount,
    onlyInPrimary,
    onlyInChallenge,
    explanation: `${onlyInPrimary.length} primary site(s) were not corroborated by the independent mechanism`,
  };
}
