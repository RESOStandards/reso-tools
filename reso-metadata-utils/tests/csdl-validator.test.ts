import { describe, expect, it } from 'vitest';
import type { CsdlSchema } from '../src/csdl/types.js';
import { validateCsdl } from '../src/csdl/validator.js';

const validSchema: CsdlSchema = {
  namespace: 'org.reso.metadata',
  entityTypes: [
    {
      name: 'Property',
      key: ['ListingKey'],
      properties: [
        { name: 'ListingKey', type: 'Edm.String' },
        { name: 'ListPrice', type: 'Edm.Decimal' },
        { name: 'City', type: 'Edm.String' }
      ],
      navigationProperties: []
    }
  ],
  enumTypes: [
    {
      name: 'StandardStatus',
      members: [
        { name: 'Active', value: '0' },
        { name: 'Pending', value: '1' }
      ]
    }
  ],
  complexTypes: [],
  actions: [],
  functions: [],
  entityContainer: {
    name: 'Default',
    // Keep the base fixture's container empty so a test can override `entityTypes` without the inherited
    // container dangling an entity-set reference to a type it replaced (the validator now resolves same-namespace
    // references — see `isUnresolvedLocalType`). Tests that exercise the entity-set / binding rules declare their
    // own populated container below.
    entitySets: [],
    singletons: [],
    actionImports: [],
    functionImports: []
  }
};

describe('validateCsdl', () => {
  it('accepts a valid schema', () => {
    const result = validateCsdl(validSchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('requires an entity container and links the OData spec', () => {
    const schema: CsdlSchema = { ...validSchema, entityContainer: undefined };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    const containerError = result.errors.find(e => e.path === 'EntityContainer');
    expect(containerError?.message).toContain('EntityContainer');
    expect(containerError?.specUrl).toContain('oasis-open.org');
  });

  it('links the 4.01 EntityContainer section when validating as 4.01', () => {
    const schema: CsdlSchema = { ...validSchema, entityContainer: undefined };
    const result = validateCsdl(schema, '4.01');
    expect(result.errors.find(e => e.path === 'EntityContainer')?.specUrl).toContain('sec_EntityContainer');
  });

  it('detects missing namespace', () => {
    const schema: CsdlSchema = { ...validSchema, namespace: '' };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('namespace');
  });

  it('detects missing key properties with spec URL', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [{ name: 'NoKey', key: [], properties: [], navigationProperties: [] }]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('no key');
    expect(result.errors[0].specUrl).toContain('oasis-open.org');
  });

  it('detects key property not in properties list', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'BadKey',
          key: ['MissingProp'],
          properties: [{ name: 'SomeField', type: 'Edm.String' }],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('MissingProp');
  });

  it('detects invalid property types', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'BadType',
          key: ['Id'],
          properties: [
            { name: 'Id', type: 'Edm.String' },
            { name: 'Broken', type: 'InvalidType' }
          ],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('InvalidType');
  });

  it('allows namespace-qualified types (enum references)', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'WithEnum',
          key: ['Id'],
          properties: [
            { name: 'Id', type: 'Edm.String' },
            { name: 'Status', type: 'org.reso.metadata.StandardStatus' }
          ],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('allows Collection types', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'WithCollection',
          key: ['Id'],
          properties: [
            { name: 'Id', type: 'Edm.String' },
            { name: 'Tags', type: 'Collection(Edm.String)' }
          ],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('accepts Edm.Stream as a valid type', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Document',
          key: ['Id'],
          properties: [
            { name: 'Id', type: 'Edm.String' },
            { name: 'Content', type: 'Edm.Stream' }
          ],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('validates schema with complex types correctly', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      complexTypes: [
        {
          name: 'Address',
          properties: [
            { name: 'Street', type: 'Edm.String' },
            { name: 'City', type: 'Edm.String' }
          ],
          navigationProperties: []
        }
      ],
      entityTypes: [
        {
          name: 'Customer',
          key: ['Id'],
          properties: [
            { name: 'Id', type: 'Edm.String' },
            { name: 'HomeAddress', type: 'org.reso.metadata.Address' }
          ],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('allows abstract entity types without keys', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'BaseEntity',
          key: [],
          properties: [{ name: 'CreatedAt', type: 'Edm.DateTimeOffset' }],
          navigationProperties: [],
          abstract: true
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('allows derived entity types without keys', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'BaseEntity',
          key: ['Id'],
          properties: [{ name: 'Id', type: 'Edm.Guid' }],
          navigationProperties: []
        },
        {
          name: 'DerivedEntity',
          key: [],
          properties: [{ name: 'Extra', type: 'Edm.String' }],
          navigationProperties: [],
          baseType: 'org.reso.metadata.BaseEntity'
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('validates navigation property targets reference known entity types', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Order',
          key: ['Id'],
          properties: [{ name: 'Id', type: 'Edm.String' }],
          navigationProperties: [
            {
              name: 'Customer',
              type: 'UnknownType',
              isCollection: false,
              entityTypeName: 'UnknownType'
            }
          ]
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('UnknownType'))).toBe(true);
  });

  // --- Complex type base type validation ---

  it('detects invalid complex type base type', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      complexTypes: [
        {
          name: 'Address',
          baseType: 'NonExistent',
          properties: [{ name: 'Street', type: 'Edm.String' }],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('NonExistent'))).toBe(true);
  });

  it('accepts valid complex type base type', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      complexTypes: [
        {
          name: 'BaseAddress',
          properties: [{ name: 'Country', type: 'Edm.String' }],
          navigationProperties: []
        },
        {
          name: 'FullAddress',
          baseType: 'org.reso.metadata.BaseAddress',
          properties: [{ name: 'Street', type: 'Edm.String' }],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  // --- Navigation property binding path validation ---

  it('detects binding path referencing nonexistent navigation property', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [{ name: 'ListingKey', type: 'Edm.String' }],
          navigationProperties: []
        }
      ],
      entityContainer: {
        name: 'Default',
        entitySets: [
          {
            name: 'Property',
            entityType: 'org.reso.metadata.Property',
            navigationPropertyBindings: [
              { path: 'NonExistentNav', target: 'Property' }
            ]
          }
        ],
        singletons: [],
        actionImports: [],
        functionImports: []
      }
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('NonExistentNav'))).toBe(true);
  });

  // --- Navigation property binding target validation ---

  it('detects binding target referencing nonexistent entity set with spec URL', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [{ name: 'ListingKey', type: 'Edm.String' }],
          navigationProperties: [
            { name: 'Photos', type: 'Collection(org.reso.metadata.Media)', isCollection: true, entityTypeName: 'Media' }
          ]
        }
      ],
      entityContainer: {
        name: 'Default',
        entitySets: [
          {
            name: 'Property',
            entityType: 'org.reso.metadata.Property',
            navigationPropertyBindings: [
              { path: 'Photos', target: 'Media' }
            ]
          }
        ],
        singletons: [],
        actionImports: [],
        functionImports: []
      }
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Media') && e.message.includes('entity set'))).toBe(true);
  });

  it('accepts valid binding path and target', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [{ name: 'ListingKey', type: 'Edm.String' }],
          navigationProperties: [
            { name: 'Photos', type: 'Collection(org.reso.metadata.Media)', isCollection: true, entityTypeName: 'Media' }
          ]
        },
        {
          name: 'Media',
          key: ['MediaKey'],
          properties: [{ name: 'MediaKey', type: 'Edm.String' }],
          navigationProperties: []
        }
      ],
      entityContainer: {
        name: 'Default',
        entitySets: [
          {
            name: 'Property',
            entityType: 'org.reso.metadata.Property',
            navigationPropertyBindings: [
              { path: 'Photos', target: 'Media' }
            ]
          },
          { name: 'Media', entityType: 'org.reso.metadata.Media' }
        ],
        singletons: [],
        actionImports: [],
        functionImports: []
      }
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  // --- Navigation property type vs binding target type ---

  it('detects nav property type mismatch with binding target entity type', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [{ name: 'ListingKey', type: 'Edm.String' }],
          navigationProperties: [
            { name: 'Photos', type: 'Collection(org.reso.metadata.Media)', isCollection: true, entityTypeName: 'Media' }
          ]
        },
        {
          name: 'Media',
          key: ['MediaKey'],
          properties: [{ name: 'MediaKey', type: 'Edm.String' }],
          navigationProperties: []
        },
        {
          name: 'Office',
          key: ['OfficeKey'],
          properties: [{ name: 'OfficeKey', type: 'Edm.String' }],
          navigationProperties: []
        }
      ],
      entityContainer: {
        name: 'Default',
        entitySets: [
          {
            name: 'Property',
            entityType: 'org.reso.metadata.Property',
            navigationPropertyBindings: [
              { path: 'Photos', target: 'Office' }
            ]
          },
          { name: 'Media', entityType: 'org.reso.metadata.Media' },
          { name: 'Office', entityType: 'org.reso.metadata.Office' }
        ],
        singletons: [],
        actionImports: [],
        functionImports: []
      }
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('does not match'))).toBe(true);
  });

  // --- Referential constraint validation ---

  it('detects referential constraint with invalid source property', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [{ name: 'ListingKey', type: 'Edm.String' }],
          navigationProperties: [
            {
              name: 'ListAgent',
              type: 'org.reso.metadata.Member',
              isCollection: false,
              entityTypeName: 'Member',
              referentialConstraints: [
                { property: 'NonExistentFK', referencedProperty: 'MemberKey' }
              ]
            }
          ]
        },
        {
          name: 'Member',
          key: ['MemberKey'],
          properties: [{ name: 'MemberKey', type: 'Edm.String' }],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('NonExistentFK'))).toBe(true);
  });

  it('detects referential constraint with invalid referenced property', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [
            { name: 'ListingKey', type: 'Edm.String' },
            { name: 'ListAgentKey', type: 'Edm.String' }
          ],
          navigationProperties: [
            {
              name: 'ListAgent',
              type: 'org.reso.metadata.Member',
              isCollection: false,
              entityTypeName: 'Member',
              referentialConstraints: [
                { property: 'ListAgentKey', referencedProperty: 'BadProperty' }
              ]
            }
          ]
        },
        {
          name: 'Member',
          key: ['MemberKey'],
          properties: [{ name: 'MemberKey', type: 'Edm.String' }],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('BadProperty'))).toBe(true);
  });

  it('accepts valid referential constraints', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [
            { name: 'ListingKey', type: 'Edm.String' },
            { name: 'ListAgentKey', type: 'Edm.String' }
          ],
          navigationProperties: [
            {
              name: 'ListAgent',
              type: 'org.reso.metadata.Member',
              isCollection: false,
              entityTypeName: 'Member',
              referentialConstraints: [
                { property: 'ListAgentKey', referencedProperty: 'MemberKey' }
              ]
            }
          ]
        },
        {
          name: 'Member',
          key: ['MemberKey'],
          properties: [{ name: 'MemberKey', type: 'Edm.String' }],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  // --- A11: same-namespace type-reference resolution ---
  // The validator once waved through ANY dotted type name as an "external reference" (a bare `!type.includes('.')`
  // escape). That masked a `org.reso.metadata.Typo` — a dangling reference to THIS schema's own namespace — as if
  // it were external. `isUnresolvedLocalType` now resolves same-namespace (and bare) references while still leaving
  // genuinely external (different-namespace) names unresolved, so real cross-namespace metadata never false-errors.

  it('A11: a navigation target qualified with this schema’s namespace but undeclared → ERROR (previously masked)', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [{ name: 'ListingKey', type: 'Edm.String' }],
          navigationProperties: [{ name: 'Ghost', type: 'org.reso.metadata.NoSuchType', isCollection: false, entityTypeName: 'NoSuchType' }]
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('NoSuchType'))).toBe(true);
  });

  it('A11: a navigation target in a DIFFERENT (external) namespace is left unresolved — no false error', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [{ name: 'ListingKey', type: 'Edm.String' }],
          navigationProperties: [{ name: 'Ext', type: 'com.other.ns.Widget', isCollection: false, entityTypeName: 'Widget' }]
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('A11: a same-namespace navigation target that IS declared resolves cleanly', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [{ name: 'ListingKey', type: 'Edm.String' }],
          navigationProperties: [{ name: 'Photos', type: 'Collection(org.reso.metadata.Media)', isCollection: true, entityTypeName: 'Media' }]
        },
        { name: 'Media', key: ['MediaKey'], properties: [{ name: 'MediaKey', type: 'Edm.String' }], navigationProperties: [] }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('A11: an entity BaseType in this namespace but undeclared → ERROR (same escape, closed for base types)', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        { name: 'Derived', key: ['Id'], properties: [{ name: 'Id', type: 'Edm.String' }], navigationProperties: [], baseType: 'org.reso.metadata.NoBase' }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('NoBase'))).toBe(true);
  });

  it('A11: an entity BaseType in an external namespace is left unresolved — no false error', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        { name: 'Derived', key: ['Id'], properties: [{ name: 'Id', type: 'Edm.String' }], navigationProperties: [], baseType: 'com.other.ns.Base' }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });

  it('A11: an entity-set type in this namespace but undeclared → ERROR (same escape, closed for entity sets)', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityContainer: {
        name: 'Default',
        entitySets: [{ name: 'Ghosts', entityType: 'org.reso.metadata.Ghost' }],
        singletons: [],
        actionImports: [],
        functionImports: []
      }
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Ghost') && e.message.includes('entity type'))).toBe(true);
  });

  it('A11: a property type in the enums sub-namespace (external to this schema) is left unresolved — mirrors real RESO metadata', () => {
    const schema: CsdlSchema = {
      ...validSchema,
      entityTypes: [
        {
          name: 'Property',
          key: ['ListingKey'],
          properties: [
            { name: 'ListingKey', type: 'Edm.String' },
            { name: 'Status', type: 'org.reso.metadata.enums.StandardStatus' } // different namespace → external → escaped
          ],
          navigationProperties: []
        }
      ]
    };
    const result = validateCsdl(schema);
    expect(result.valid).toBe(true);
  });
});
