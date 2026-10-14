'use strict';
const { readFile, writeFile } = require('fs/promises');
const { XMLParser } = require('fast-xml-parser');
const { CERTIFICATION_FILES } = require('../../common');

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

const convertMetadata = async xmlMetadata => {
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
                    return {
                      resourceName,
                      fieldName,
                      type,
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
                      isCollection: type?.startsWith('Collection(') ? true : undefined
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
      version: '2.0',
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

const convertAndSaveMetadata = async ({ pathToXmlMetadata = '' }) => {
  try {
    const xmlMetadata = await loadMetadataFile(pathToXmlMetadata);
    const metadataReportJson = await convertMetadata(xmlMetadata);
    await writeFile(CERTIFICATION_FILES.METADATA_REPORT, JSON.stringify(metadataReportJson, null, '  '));
  } catch (err) {
    console.error(`Something went wrong! Error: ${JSON.stringify(err, null, '  ')}`);
  }
};

module.exports = {
  convertAndSaveMetadata,
  convertMetadata
};
