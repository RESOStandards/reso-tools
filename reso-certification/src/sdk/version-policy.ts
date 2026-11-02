/**
 * Which version of a standard certifies. One rule for every endorsement: RESO certifies on the latest minor version
 * within a given major branch. A run on an older minor is a retest, so it runs and it does not certify. Majors stand
 * apart, so the latest of each major certifies until that major is deprecated.
 *
 * Versions are dotted numbers, `2.1` or `2.1.0`, compared part by part.
 */

const partsOf = (version: string): ReadonlyArray<number> => version.split('.').map(Number);
const majorOf = (version: string): number => partsOf(version)[0] ?? Number.NaN;

const compareVersions = (a: string, b: string): number => {
  const pa = partsOf(a);
  const pb = partsOf(b);
  const length = Math.max(pa.length, pb.length);
  const differing = Array.from({ length }, (_, i) => (pa[i] ?? 0) - (pb[i] ?? 0)).find(difference => difference !== 0);
  return differing ?? 0;
};

/** The highest version of each major in the list, in the list's order. */
export const latestOfEachMajor = <V extends string>(versions: ReadonlyArray<V>): ReadonlyArray<V> =>
  versions.filter(version => versions.every(other => majorOf(other) !== majorOf(version) || compareVersions(other, version) <= 0));

/**
 * Why a run on `version` cannot certify, or undefined when it can. `standard` names it in the reason, such as
 * "Data Dictionary". An older minor names the version certification is on; a version whose major has nothing
 * certifiable is not certified at all.
 */
export const whyVersionDoesNotCertify = (standard: string, version: string, certifiable: ReadonlyArray<string>): string | undefined => {
  if (certifiable.includes(version)) return undefined;
  const latest = certifiable.find(candidate => majorOf(candidate) === majorOf(version));
  return latest
    ? `Certification is on ${standard} ${latest}, the latest ${majorOf(latest)}.x. A run on ${version} is a retest and is not eligible for certification.`
    : `RESO does not certify ${standard} ${version}.`;
};
