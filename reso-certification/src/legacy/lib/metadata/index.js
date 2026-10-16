'use strict';
const { readFile, writeFile } = require('fs/promises');
const { XMLParser } = require('fast-xml-parser');
const { CERTIFICATION_FILES, DEFAULT_DD_VERSION } = require('../../common');

/** CSDL wraps a collection's element type as `Collection(<inner>)`. */
const COLLECTION_PREFIX = 'Collection(';

/********************************
 * TODO
 * WIP Node Metadata Serializer
 *  Below
 ********************************

  {
    "?xml": {
      "version": "1.0",
      "encoding": "UTF-8",
      "standalone": "yes"
    },
    "edmx:Edmx": {
      "edmx:DataServices": {
        "Schema": [
          {
            "EntityType": [
              {
                "Key": {
                  "PropertyRef": {
                    "Name": "ListingKey"
                  }
                },
                "Property": [
                  {
                    "Annotation": [
                      {
                        "Term": "RESO.OData.Metadata.StandardName",
                        "String": "Above Grade Finished Area"
                      },
                      {
                        "Term": "RESO.DDWikiUrl",
                        "String": "https://ddwiki.reso.org/display/DDW20/AboveGradeFinishedArea+Field"
                      },
                      {
                        "Term": "Core.Description",
                        "String": "Finished area within the structure that is at or above the surface of the ground."
                      }
                    ],
                    "Name": "AboveGradeFinishedArea",
                    "Type": "Edm.Decimal",
                    "Precision": "14",
                    "Scale": "2"
                  },
                  "NavigationProperty": [
                    ...
                  ],
                  "Name": Property

    */

const convertMetadata = async (xmlMetadata, version = DEFAULT_DD_VERSION) => {
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
    const parsed = parser.parse(xmlMetadata);

    const resourceMap = {},
      schemas = parsed?.['edmx:Edmx']?.['edmx:DataServices']?.['Schema'] ?? [];

    const processedMetadata = schemas.reduce(
      (
        acc,
        { EntityType: entityTypes = [] /* EnumType: enumTypes = [], EntityContainer: entityContainer = {}, Namespace: namespace = null */ }
      ) => {
        if (entityTypes?.length) {
          acc.fields.push(
            ...entityTypes.map(
              ({
                Key: primaryKey,
                Property: fields = [],
                BaseType: baseType,
                /* NavigationProperty: expansions = [], */ Name: resourceName
              }) => {
                if (!resourceMap?.[resourceName]) {
                  resourceMap[resourceName] = {
                    resourceName,
                    baseType,
                    primaryKey: primaryKey?.PropertyRef?.Name ?? null
                  };
                }

                //sometimes fields can be a singleton object and needs to be turned into an array
                return (fields?.map ? fields : [fields]).map(
                  ({
                    Annotation: annotations = [],
                    Name: fieldName,
                    Type: type,
                    MaxLength: maxLength,
                    Precision: precision,
                    Scale: scale,
                    Nullable: nullable,
                    isExpansion
                  }) => {
                    // A collection reports its ELEMENT type in `type`, with the collection-ness carried
                    // solely by `isCollection`. That is the contract every consumer of a metadata report
                    // is written against, and the one `src/test-runner/metadata.ts` already follows for
                    // the Core path ("extracting the inner type and setting isCollection").
                    //
                    // Keeping the CSDL `Collection(...)` wrapper here encodes collection-ness twice, and
                    // the wrapped form then fails every bare-`Edm.*` test downstream, silently: the JSON
                    // Schema generator maps it through `typeMappings[field.type] || 'object'` and types
                    // the array's items as objects (schema/generate.js:106), `isEnumType` calls it an
                    // enumeration (reso-common metadata/helpers.ts:11), and `isComplexType` calls it a
                    // complex type (metadata-map.ts:168). Most fields escape this only by accident — the
                    // Lookup Resource merge rewrites `type` for anything carrying a LookupName
                    // annotation. A vendor extension has no such annotation, so nothing normalizes it:
                    // A single vendor extension field typed `Collection(Edm.String)` produced
                    // 1,109,350 "MUST be object but found string" errors against a payload that
                    // was a plain string array.
                    //
                    // The Java commander emitted the unwrapped form, which is why reports certified
                    // before this parser took over carry `type: "Edm.String"` with `isCollection: true`.
                    const isCollection = typeof type === 'string' && type.startsWith(COLLECTION_PREFIX);
                    const elementType = isCollection ? type.slice(COLLECTION_PREFIX.length, -1) : type;

                    return {
                      resourceName,
                      fieldName,
                      type: elementType,
                      maxLength,
                      precision,
                      scale,
                      nullable: new Boolean(nullable),
                      annotations: annotations?.length
                        ? annotations?.map(({ Term: term, String: string }) => {
                          return { term, string };
                        })
                        : undefined,
                      isExpansion,
                      isCollection: isCollection ? true : undefined
                    };
                  }
                );
              }
            )
          );
        }

        // if (enumTypes?.length) {
        //   acc.lookups.push(...entityTypes.map(() => {}));
        // }

        return acc;
      },
      {
        resources: [],
        fields: [],
        lookups: []
      }
    );

    return {
      description: 'RESO Data Dictionary Metadata Report',
      version,
      generatedOn: new Date().toISOString(),
      ...processedMetadata
    };
  } catch (err) {
    console.error(err);
  }
};

const loadMetadataFile = async (pathToXmlMetadata = '') => {
  try {
    return await readFile(pathToXmlMetadata);
  } catch {
    console.error(`Could not read file '${pathToXmlMetadata}'!`);
    return null;
  }
};

const convertAndSaveMetadata = async ({ pathToXmlMetadata = '', version }) => {
  try {
    const xmlMetadata = await loadMetadataFile(pathToXmlMetadata);
    const metadataReportJson = await convertMetadata(xmlMetadata, version);
    await writeFile(CERTIFICATION_FILES.METADATA_REPORT, JSON.stringify(metadataReportJson, null, '  '));
  } catch (err) {
    console.error(`Something went wrong! Error: ${JSON.stringify(err, null, '  ')}`);
  }
};

module.exports = {
  convertAndSaveMetadata,
  convertMetadata
};
