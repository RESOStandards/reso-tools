/**
 * Web API Add/Edit specification versions. There is one: RCP-10 2.0.0, ratified December 2023. The suite this package
 * runs is that version's, so a run labeled with any other version would describe a test it did not run.
 *
 * Parallels `dd-versions.ts` and `core-versions.ts`, and certifies by the same rule (`version-policy.ts`).
 */

import { latestOfEachMajor, whyVersionDoesNotCertify } from './version-policy.js';

/** Add/Edit spec versions the runner supports. SOURCE OF TRUTH for the CLI and the certification rule. */
export const SUPPORTED_ADD_EDIT_VERSIONS = ['2.0.0'] as const;

/** A supported Web API Add/Edit version. Derived from the constant. */
export type AddEditVersion = (typeof SUPPORTED_ADD_EDIT_VERSIONS)[number];

/** The version a run defaults to. */
export const CURRENT_ADD_EDIT_VERSION: AddEditVersion = '2.0.0';

/** Type guard: is this exact value a supported Add/Edit version? */
export const isAddEditVersion = (version: string): version is AddEditVersion =>
  (SUPPORTED_ADD_EDIT_VERSIONS as ReadonlyArray<string>).includes(version);

/** Versions a provider can be certified on: the latest minor of each major. */
export const CERTIFIABLE_ADD_EDIT_VERSIONS: ReadonlyArray<AddEditVersion> = latestOfEachMajor(SUPPORTED_ADD_EDIT_VERSIONS);

/** Why a run on this Add/Edit version cannot certify, or undefined when it can. */
export const whyAddEditVersionDoesNotCertify = (version: string): string | undefined =>
  whyVersionDoesNotCertify('Web API Add/Edit', version, CERTIFIABLE_ADD_EDIT_VERSIONS);
