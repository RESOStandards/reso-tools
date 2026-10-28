/**
 * What run-compliance and metadata-report hand the SDK, and what they answer with.
 *
 * Three things an agent was not told. A compliance run wrote its reports under the server's working
 * directory, which an MCP host chooses (often `/`), so the run failed before testing anything. The
 * answer dropped the certification verdict, so an EntityEvent observe run read as certifiable. And
 * both tools defaulted to versions older than the CLI's (Core 2.0.0, DD 2.0).
 *
 * The SDK's compliance runner and metadata fetch are faked; the handlers run as they are.
 */

import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OBSERVE_REASON = 'observe mode – the run exercised no writes, so there is nothing to certify';

const TINY_EDMX = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Property">
        <Key><PropertyRef Name="ListingKey"/></Key>
        <Property Name="ListingKey" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="RESO">
        <EntitySet Name="Property" EntityType="org.reso.metadata.Property"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

vi.mock('@reso-standards/reso-certification', async () => {
  const actual = await vi.importActual<typeof import('@reso-standards/reso-certification')>('@reso-standards/reso-certification');
  return {
    ...actual,
    runComplianceTests: vi.fn(async (config: { endorsement: string }) => ({
      status: 'passed',
      endorsement: config.endorsement,
      duration: 1,
      steps: [],
      context: { outputPath: '/reports/entity-event-1.0.0/current' },
      certification: { valid: false, reasons: [OBSERVE_REASON] }
    })),
    fetchMetadata: vi.fn(async () => TINY_EDMX)
  };
});

const { CURRENT_CORE_VERSION, CURRENT_DD_VERSION, runComplianceTests } = await import('@reso-standards/reso-certification');
const { handlers } = await import('../src/handlers.js');

const SERVER = 'http://localhost:9999';
const answerOf = (result: { content: ReadonlyArray<{ text: string }> }): Record<string, unknown> => JSON.parse(result.content[0].text);
const configOf = (): Record<string, unknown> => vi.mocked(runComplianceTests).mock.calls[0][0] as unknown as Record<string, unknown>;

// A block body, not an expression: `mockClear` returns the mock, and a function returned from
// `beforeEach` is run as its cleanup, which would call the fake runner with no config.
beforeEach(() => {
  vi.mocked(runComplianceTests).mockClear();
});

describe('run-compliance', () => {
  for (const endorsement of ['add-edit', 'entity-event', 'core']) {
    it(`writes ${endorsement} reports under the system temp dir, never the server's working directory`, async () => {
      await handlers['run-compliance']({ endorsement, url: SERVER, authToken: 'token' });
      const options = configOf().options as { outputDir?: string };
      expect(options?.outputDir?.startsWith(join(tmpdir(), 'reso-mcp-server-'))).toBe(true);
    });
  }

  it('uses one private directory per server process', async () => {
    // A fixed name under a shared temp dir could be created first by another user on the machine.
    await handlers['run-compliance']({ endorsement: 'core', url: SERVER, authToken: 'token' });
    const first = (configOf().options as { outputDir: string }).outputDir;
    vi.mocked(runComplianceTests).mockClear();
    await handlers['run-compliance']({ endorsement: 'add-edit', url: SERVER, authToken: 'token' });
    const second = (configOf().options as { outputDir: string }).outputDir;
    expect(second).toBe(first);
    const stat = statSync(first);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(stat.uid).toBe(process.getuid?.());
  });

  it('answers with the certification verdict and where the reports are', async () => {
    const answer = answerOf(await handlers['run-compliance']({ endorsement: 'entity-event', url: SERVER, authToken: 'token' }));
    expect(answer.status).toBe('passed');
    expect(answer.certification).toEqual({ valid: false, reasons: [OBSERVE_REASON] });
    expect(answer.reports).toBe('/reports/entity-event-1.0.0/current');
  });

  it("runs the CLI's current Web API Core version when none is named", async () => {
    await handlers['run-compliance']({ endorsement: 'core', url: SERVER, authToken: 'token' });
    expect(configOf().version).toBe(CURRENT_CORE_VERSION);
  });

  it('runs the Web API Core version it is asked for', async () => {
    await handlers['run-compliance']({ endorsement: 'core', url: SERVER, authToken: 'token', version: '2.0.0' });
    expect(configOf().version).toBe('2.0.0');
  });
});

describe('metadata-report', () => {
  it("labels the report with the CLI's current DD version when none is named", async () => {
    const report = answerOf(await handlers['metadata-report']({ url: SERVER, authToken: 'token' }));
    expect(report.version).toBe(CURRENT_DD_VERSION);
  });

  it('labels the report with the DD version it is asked for', async () => {
    const report = answerOf(await handlers['metadata-report']({ url: SERVER, authToken: 'token', version: '2.0' }));
    expect(report.version).toBe('2.0');
  });
});
