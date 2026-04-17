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
    entitySets: [{ name: 'Property', entityType: 'org.reso.metadata.Property' }],
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
});
