'use strict';

/**
 * `@reso.context` validation (reso-tools #298).
 *
 * RESO Common Format §3.4.1(a) and the IANA `reso` URN assignment define the payload context as
 *   urn:reso:metadata:{version}:resource:{resource-name}
 * with a lowercase resource name (every example in the assignment is lowercase; RFC 8141 leaves the NSS
 * case-sensitive unless the namespace says otherwise). RCF adds: "Additional parameters may be added to the
 * URN" — so segments after the resource element are accepted and ignored here. A `field` element
 * (…:resource:{name}:field:{field}) identifies a field, not a payload, and is not a payload context.
 *
 * Severity follows the ACQUISITION PATH, never the annotation's presence:
 *   rcf        — the context is the only model identifier an RCF payload has: absent, malformed, or disagreeing
 *                with the run's version or resource is an ERROR.
 *   transport  — a Web API Core page, a DD run replicated over the provider's Web API, an $expand child: the
 *                context is optional until DD 3.0 (no new failing rule on an existing element in a minor
 *                version); when present and wrong it is a WARNING until DD 3.0, an ERROR from 3.0, when the
 *                context also becomes required.
 */

const CONTEXT_REQUIRED_FROM_DD_VERSION = '3.0';
const KNOWN_DD_VERSIONS = Object.freeze(['1.7', '2.0', '2.1', '3.0']);
const RESOURCE_NAME_RE = /^[a-z][a-z0-9_]*$/;

// Messages start with "The" / "RCF" on purpose: the legacy cache upper-cases the first word of any message that
// does not start with "The" (warnings) / "Fields" (errors) to emphasise a modal — a message starting with the
// quoted annotation name would come back as "@RESO.CONTEXT".
const RESO_CONTEXT_MESSAGES = Object.freeze({
  REQUIRED: 'RCF payloads MUST carry "@reso.context" (urn:reso:metadata:{version}:resource:{resource-name})',
  MALFORMED: 'The "@reso.context" value MUST be urn:reso:metadata:{version}:resource:{resource-name} with a lowercase resource name',
  VERSION_MISMATCH: 'The "@reso.context" version does not match the run version',
  RESOURCE_MISMATCH: 'The "@reso.context" resource does not match the requested resource'
});

const versionAtLeast = (version, floor) => {
  const [a, b] = String(version ?? '').split('.').map(Number);
  const [fa, fb] = floor.split('.').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && (a > fa || (a === fa && b >= fb));
};

/**
 * Parse a payload context. Returns { version, resource, extra } for a well-formed resource context, else null.
 * Well-formed = exactly `urn:reso:metadata:{version}:resource:{name}` in the first six segments, name lowercase;
 * any further segments are RCF "additional parameters" (kept as `extra`, not interpreted).
 */
const parsePayloadContext = context => {
  if (typeof context !== 'string') return null;
  const parts = context.split(':');
  if (parts.length < 6) return null;
  if (parts[0] !== 'urn' || parts[1] !== 'reso' || parts[2] !== 'metadata' || parts[4] !== 'resource') return null;
  if (!/^\d+\.\d+$/.test(parts[3])) return null;
  if (!RESOURCE_NAME_RE.test(parts[5])) return null;
  const extra = parts.slice(6);
  if (extra[0] === 'field') return null; // a field element identifies a field, not a payload
  return { version: parts[3], resource: parts[5], extra };
};

/**
 * @param {object} obj
 * @param {unknown} obj.context       the payload's `@reso.context` value (undefined when absent)
 * @param {string=} obj.resource      the resource the payload was requested/declared for (compared lowercase)
 * @param {string=} obj.version       the run's declared DD version (authoritative on a transport run)
 * @param {'rcf'|'transport'} obj.mode the acquisition path
 * @param {ReadonlyArray<string>=} obj.knownVersions
 * @returns {{ findings: Array<{ severity: 'error'|'warning', message: string }>, parsed: object|null }}
 */
const checkResoContext = ({ context, resource, version, mode = 'transport', knownVersions = KNOWN_DD_VERSIONS } = {}) => {
  const strict = mode === 'rcf' || versionAtLeast(version, CONTEXT_REQUIRED_FROM_DD_VERSION);
  const severity = strict ? 'error' : 'warning';
  const findings = [];

  if (context === undefined || context === null) {
    if (strict) findings.push({ severity: 'error', message: RESO_CONTEXT_MESSAGES.REQUIRED });
    return { findings, parsed: null };
  }

  const parsed = parsePayloadContext(context);
  if (!parsed) {
    findings.push({ severity, message: `${RESO_CONTEXT_MESSAGES.MALFORMED}; found ${JSON.stringify(context)}` });
    return { findings, parsed: null };
  }

  if (version !== undefined && version !== null && version !== '') {
    if (parsed.version !== String(version)) {
      findings.push({ severity, message: `${RESO_CONTEXT_MESSAGES.VERSION_MISMATCH}: context "${parsed.version}", run "${version}"` });
    }
  } else if (!knownVersions.includes(parsed.version)) {
    findings.push({ severity, message: `${RESO_CONTEXT_MESSAGES.MALFORMED}; version "${parsed.version}" is not a Data Dictionary version` });
  }

  if (resource && parsed.resource !== String(resource).toLowerCase()) {
    findings.push({ severity, message: `${RESO_CONTEXT_MESSAGES.RESOURCE_MISMATCH}: context "${parsed.resource}", requested "${resource}"` });
  }

  return { findings, parsed };
};

module.exports = { checkResoContext, parsePayloadContext, RESO_CONTEXT_MESSAGES, CONTEXT_REQUIRED_FROM_DD_VERSION, KNOWN_DD_VERSIONS };
