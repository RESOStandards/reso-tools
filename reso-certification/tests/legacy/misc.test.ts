import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pascalCase } = require(resolve(import.meta.dirname, '../../src/legacy/lib/misc/index.js'));

describe('pascalCase tests', () => {
  it('Should convert a simple lowercase word to PascalCase', () => {
    expect(pascalCase('property')).toBe('Property');
  });

  it('Should convert multiple lowercase words separated by spaces', () => {
    expect(pascalCase('postal code')).toBe('PostalCode');
  });

  it('Should convert hyphen-separated words to PascalCase', () => {
    expect(pascalCase('some-field-name')).toBe('SomeFieldName');
  });

  it('Should convert underscore-separated words to PascalCase', () => {
    expect(pascalCase('some_field_name')).toBe('SomeFieldName');
  });

  it('Should handle mixed delimiters', () => {
    expect(pascalCase('some-field_name here')).toBe('SomeFieldNameHere');
  });

  it('Should preserve a string that is already PascalCase', () => {
    expect(pascalCase('PostalCode')).toBe('Postalcode');
  });

  it('Should handle a single character', () => {
    expect(pascalCase('a')).toBe('A');
  });

  it('Should return an empty string when given an empty string', () => {
    expect(pascalCase('')).toBe('');
  });

  it('Should return an empty string when called with no arguments', () => {
    expect(pascalCase()).toBe('');
  });

  it('Should strip non-alphanumeric characters', () => {
    expect(pascalCase('hello!@#world')).toBe('HelloWorld');
  });

  it('Should handle strings with numbers', () => {
    expect(pascalCase('version2update')).toBe('Version2update');
  });

  it('Should handle strings with leading/trailing non-alphanumeric characters', () => {
    expect(pascalCase('--hello-world--')).toBe('HelloWorld');
  });

  it('Should convert an ALL CAPS string', () => {
    expect(pascalCase('POSTAL CODE')).toBe('PostalCode');
  });

  it('Should handle a fully qualified lookup name after extracting the suffix', () => {
    const lookupName = 'org.reso.metadata.enums.CountryCode';
    const suffix = lookupName.substring(lookupName.lastIndexOf('.') + 1);
    expect(pascalCase(suffix)).toBe('Countrycode');
  });
});
