/**
 * Scale-set label conflicts between Profiles (ADR 0017).
 *
 * GitHub sends a job to a scale set whose labels include every label the job asks for, and to any
 * one of them when several qualify. So a scale set that also answers to another Profile's name can
 * take that Profile's jobs and run them under its own contract: its image, its egress, its pinned
 * Workers. `runs-on: [erainfra-4vcpu-ubuntu-2404, gpu]` served by a second scale set labelled with
 * both is exactly that, which is why a pin is a Profile of its own.
 *
 * No runtime imports: `scripts/profile-label-conflicts.ts` runs this file under plain Node against
 * a deployment's exported rows, before the backend that refuses new conflicts is deployed.
 */

export type ScaleSetProfile = {
  name: string;
  scaleSetName: string;
  labels?: string[];
};

/** The labels GitHub matches a Profile's scale set by: its configured labels, else its name. */
export function scaleSetLabels(profile: ScaleSetProfile) {
  const labels =
    profile.labels !== undefined && profile.labels.length > 0
      ? profile.labels
      : [profile.scaleSetName];
  return labels.map((label) => label.toLowerCase());
}

/**
 * Why `profile`'s scale set and `other`'s overlap in a way that lets one take the other's jobs,
 * from `profile`'s side; undefined when they do not.
 */
export function scaleSetConflict(profile: ScaleSetProfile, other: ScaleSetProfile) {
  if (other.name === profile.name) return undefined;
  const mine = scaleSetLabels(profile);
  const taken = mine.find(
    (label) => label === other.scaleSetName.toLowerCase() || label === other.name.toLowerCase(),
  );
  if (taken !== undefined) {
    return `scale-set label ${taken} is Profile ${other.name}'s name; its jobs could run on this Profile instead (ADR 0017)`;
  }
  const theirs = scaleSetLabels(other);
  if (
    theirs.includes(profile.scaleSetName.toLowerCase()) ||
    theirs.includes(profile.name.toLowerCase())
  ) {
    return `Profile ${other.name}'s scale set also answers to ${profile.name}; this Profile's jobs could run there instead (ADR 0017)`;
  }
  return undefined;
}

export type LabelConflict = { profile: string; other: string; reason: string };

/**
 * Every conflicting pair among `profiles` (the active ones; a paused Profile's scale set takes no
 * jobs), once per pair, from the side of the Profile whose name sorts first.
 */
export function labelConflicts(profiles: readonly ScaleSetProfile[]): LabelConflict[] {
  const sorted = profiles.toSorted((left, right) => left.name.localeCompare(right.name));
  const out: LabelConflict[] = [];
  for (const [index, profile] of sorted.entries()) {
    for (const other of sorted.slice(index + 1)) {
      const reason = scaleSetConflict(profile, other);
      if (reason !== undefined) out.push({ profile: profile.name, other: other.name, reason });
    }
  }
  return out;
}

/** The conflicts `profile` is part of, each phrased from its side. */
export function conflictsOf(
  profile: ScaleSetProfile,
  profiles: readonly ScaleSetProfile[],
): LabelConflict[] {
  return profiles.flatMap((other) => {
    const reason = scaleSetConflict(profile, other);
    return reason === undefined ? [] : [{ profile: profile.name, other: other.name, reason }];
  });
}
