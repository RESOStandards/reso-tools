/**
 * JSON rendering of a run's results, for `--output json`.
 *
 * Lives apart from the CLI entry point so it can be tested. Importing the entry point runs
 * commander, which parses argv and exits, so anything testable has to sit outside it.
 */

import type { PipelineResult } from '../sdk/types.js';
import { maskSecrets } from './secrets.js';

/**
 * Remove the credential from the serialized context.
 *
 * The context carries `authToken` because every step after `Resolve authentication` needs it to
 * make requests. A consumer of this JSON never does. Before this, a bare JSON.stringify of the
 * result put the live bearer token on stdout — in the output the guide recommends archiving in a
 * results store.
 */
const withoutCredentials = (result: PipelineResult): PipelineResult => {
  const { authToken: _dropped, ...context } = result.context as Record<string, unknown> & { authToken?: string };
  return { ...result, context } as PipelineResult;
};

/**
 * Format pipeline results as JSON, with credentials removed and any registered secret masked.
 *
 * Two layers, and both are needed. Dropping the field removes the path we know about. Masking by
 * value catches the paths nobody enumerated — a token echoed in a request URL, quoted in an error
 * message, or returned in a response body — which is how it got into the context unnoticed in the
 * first place. Each is sufficient alone; together neither has to be the one that was remembered.
 */
export const formatResultJson = (results: ReadonlyArray<PipelineResult>): string => {
  const stripped = results.map(withoutCredentials);
  return maskSecrets(JSON.stringify(stripped.length === 1 ? stripped[0] : stripped, null, 2));
};
