// Real data extracted from the certqa.reso.org screenshots for
// Aberdeen Area Association of REALTORS®. All three mockups use
// this so we compare layout, not content.
//
// Sources:
//   Screenshot 1 — cert summary, Data Elements view (DD 1.7 chart)
//   Screenshot 2 — cert summary, Performance view
//   Screenshot 3 — Organizations directory + expanded drawer
//
// Where the screenshots disagreed, the directory drawer (the more
// detailed source) won. DD 1.7 is shown as "Legacy" on the Summary
// page even though the underlying cert is still Certified — the
// Summary page flags the version as superseded.

window.MOCK_ORG = {
  uoi: 'M00000570',
  name: 'Aberdeen Area Association of REALTORS®',
  type: 'MLS',
  address: 'PO Box 703, Aberdeen, SD 57401',
  members: 84,
  website: 'aberdeen.com',

  // Synthesized health — all 3 active endorsements are certified
  healthLabel: 'Certified Current',
  certifiedActive: 3,
  totalActive: 3,

  // Most recent run — all three were run together Sep 24 2025
  lastRun: '2025-09-24',
  lastRunTime: '7:02 am',
  lastRunLabel: '6 months ago',

  // Peer ranking placeholder — the cert summary page references
  // industry averages but doesn't surface a ranking; this is the
  // kind of synthesis the new Summary page can add. MLS cohort
  // size from screenshot 3 (548 MLS orgs).
  peerCohort: 'MLS · 548 orgs',
  peerNote: 'above industry average on coverage and performance',

  endorsements: [
    {
      id: 'dd-17',
      type: 'data_dictionary',
      typeLabel: 'Data Dictionary',
      version: '1.7',
      status: 'certified',
      versionFlag: 'legacy', // version superseded but cert still valid
      statusLabel: 'Certified',
      versionFlagLabel: 'Legacy version',
      provider: 'FBS',
      system: 'Spark API',
      date: '2025-09-24',
      time: '7:02 am',
      dateLabel: '6 mo ago',
      // From screenshot 1 endorsements list
      resources: 8,
      lookups: 882,
      idxFields: 130,
      idxTotal: 251,
      idxPercent: 60,
      industryIdxPercent: 52, // approximated from chart industry-avg line
    },
    {
      id: 'dd-20',
      type: 'data_dictionary',
      typeLabel: 'Data Dictionary',
      version: '2.0',
      status: 'certified',
      statusLabel: 'Certified',
      provider: 'FBS',
      system: 'Spark API',
      date: '2025-09-24',
      time: '7:02 am',
      dateLabel: '6 mo ago',
      resources: 13,
      lookups: 287,
      idxFields: 130,
      idxTotal: 251,
      idxPercent: 61,
      industryIdxPercent: 52,
      // Per-resource coverage for the top 5 RESO resources. Sourced
      // from this (the most recent certified DD) report so the org
      // summary's coverage hero is unambiguously one report's data.
      // Numbers are availability percentages: fields populated /
      // fields advertised. Industry averages are the cohort mean.
      isPrimaryDdReport: true,

      // ── Top resources (global, industry-derived) ─────────────────
      // The canonical list of resources shown on the org summary,
      // derived from industry aggregates: the 5 most-used resources
      // across the cohort. This list is the *menu* — each payload
      // below picks the subset that applies to it.
      //
      // In the real system this is computed from the analytics layer,
      // not hand-authored. The list will evolve as cohorts grow.
      topResources: ['Property', 'Member', 'Office', 'Media', 'OpenHouse'],

      // ── Field cuts ────────────────────────────────────────────────
      // Always-visible report-wide classifications. The current cert
      // site exposes a subset of these as a filter toggle; the new
      // design promotes them to hero metrics so execs see them all
      // at once. The point of this row is *motivational*: we want
      // recipients to grow their RESO standard field count AND their
      // RESO enumeration adoption, so those two cuts get the
      // celebrated treatment. All and Local are context.
      //
      // Percentages here are about *data availability* — fields that
      // have data in the payload, not just fields declared in
      // metadata. That's the advertised-vs-available delta the
      // original requirements called out, rolled up to one number.
      fieldCuts: [
        {
          key: 'all',
          label: 'All fields available',
          providerCount: 525,
          totalCount: 700,
          providerPercent: 75,
          industryPercent: 64
        },
        {
          key: 'reso-fields',
          label: 'RESO standard fields',
          providerCount: 487,
          totalCount: 625,
          providerPercent: 78,
          industryPercent: 67,
          motivational: true
        },
        {
          key: 'reso-enums',
          label: 'RESO enumerations',
          providerCount: 96,
          totalCount: 142,
          providerPercent: 68,
          industryPercent: 71,
          motivational: true
        },
        {
          key: 'local',
          label: 'Local fields',
          providerCount: 38,
          industryAvgCount: 22,
          isCount: true
        }
      ],

      // ── Payloads ──────────────────────────────────────────────────
      // Use-case-specific subsets of the standard fields. The data
      // model assumption is that *every standard field carries a
      // payload label* (or set of labels) marking which payloads it
      // belongs to: IDX, BBO, VOW, AMS, RCF, etc. The lists below
      // are the rolled-up view of those labels.
      //
      // For each payload:
      //   - providerFields / totalFields / providerPercent / industryPercent
      //     are the payload-wide totals
      //   - resourceCoverage is the per-resource breakdown, drawn
      //     from the global topResources list above. A payload only
      //     includes the resources that have at least one field
      //     labeled with it. IDX touches all 5 of the top resources;
      //     a hypothetical AMS payload only touches Member + Office.
      //
      // In the real system resourceCoverage is computed from the
      // field labels, not hand-authored. The fixture pre-computes it.
      payloads: [
        {
          key: 'IDX',
          label: 'IDX Payload',
          providerFields: 130,
          totalFields: 251,
          providerPercent: 61,
          industryPercent: 52,
          // Subset of topResources that this payload includes — all 5.
          // Office is intentionally below industry average so the
          // mock can demo both the above-industry "reward" treatment
          // and the below-industry "subtle call-out" treatment.
          resourceCoverage: [
            { resource: 'Property',  providerPercent: 87, industryPercent: 78 },
            { resource: 'Member',    providerPercent: 72, industryPercent: 65 },
            { resource: 'Office',    providerPercent: 56, industryPercent: 64 },
            { resource: 'Media',     providerPercent: 91, industryPercent: 80 },
            { resource: 'OpenHouse', providerPercent: 45, industryPercent: 38 }
          ]
        }
        // Future example — AMS only touches 2 of the top resources:
        // {
        //   key: 'AMS',
        //   label: 'AMS Payload',
        //   providerFields: 42,
        //   totalFields: 60,
        //   providerPercent: 70,
        //   industryPercent: 58,
        //   resourceCoverage: [
        //     { resource: 'Member', providerPercent: 88, industryPercent: 72 },
        //     { resource: 'Office', providerPercent: 76, industryPercent: 65 }
        //   ]
        // }
      ]
    },
    {
      id: 'core-200',
      type: 'web_api_server_core',
      typeLabel: 'Web API Server Core',
      version: '2.0.0',
      status: 'certified',
      statusLabel: 'Certified',
      provider: 'FBS',
      system: 'Spark API',
      date: '2025-09-24',
      time: '7:02 am',
      dateLabel: '6 mo ago',
      // From screenshot 2 (Performance view)
      perfPayloadMb: 0.34,
      industryPayloadMb: 3.40,
      perfResponseS: 0.88,
      industryResponseS: 2.95, // approximated from chart bar height
      perfThroughputMbS: 0.30,
      industryThroughputMbS: 2.00, // approximated from chart bar height
      perfSecPer1k: 0.88,
      industrySecPer1k: 1.10,
      perfDeltaPercent: 20, // 20% faster than industry
      // Providers can opt their performance metrics out of public
      // view. When true, the page shows only the industry aggregates
      // and renders the provider's slot as a labeled "not publicly
      // available" state. The mock has a toggle to demo both states.
      performanceOptedOut: false,
      isPrimaryCoreReport: true
    }
  ]
};

window.STATUS_TONE = {
  certified:           ['bg-emerald-100 text-emerald-800', 'bg-emerald-900/30 text-emerald-300'],
  in_progress:         ['bg-sky-100 text-sky-800',         'bg-sky-900/30 text-sky-300'],
  recipient_notified:  ['bg-blue-100 text-blue-800',       'bg-blue-900/30 text-blue-300'],
  in_review:           ['bg-amber-100 text-amber-800',     'bg-amber-900/30 text-amber-300'],
  failed:              ['bg-rose-100 text-rose-800',       'bg-rose-900/30 text-rose-300'],
  legacy:              ['bg-gray-200 text-gray-600',       'bg-gray-700 text-gray-300'],
  withdrawn:           ['bg-gray-200 text-gray-600',       'bg-gray-700 text-gray-300']
};
