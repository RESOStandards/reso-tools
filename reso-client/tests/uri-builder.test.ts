import { describe, expect, it } from 'vitest';
import { buildUri } from '../src/uri/builder.js';

describe('buildUri', () => {
  const base = 'http://localhost:8080';

  it('builds a simple resource URL', () => {
    expect(buildUri(base, 'Property').build()).toBe('http://localhost:8080/Property');
  });

  it('strips trailing slash from base URL', () => {
    expect(buildUri('http://localhost:8080/', 'Property').build()).toBe('http://localhost:8080/Property');
  });

  it('adds key syntax', () => {
    expect(buildUri(base, 'Property').key('ABC123').build()).toBe("http://localhost:8080/Property('ABC123')");
  });

  it('URI-encodes key values', () => {
    expect(buildUri(base, 'Property').key('key with spaces').build()).toBe("http://localhost:8080/Property('key%20with%20spaces')");
  });

  it('adds $select', () => {
    const url = buildUri(base, 'Property').select('ListPrice', 'City').build();
    expect(url).toBe('http://localhost:8080/Property?%24select=ListPrice,City');
  });

  it('adds $filter', () => {
    const url = buildUri(base, 'Property').filter('ListPrice gt 200000').build();
    expect(url).toContain('%24filter=');
    expect(url).toContain('ListPrice');
  });

  it('adds $orderby', () => {
    const url = buildUri(base, 'Property').orderby('ListPrice desc').build();
    expect(url).toContain('%24orderby=');
  });

  it('adds $top', () => {
    const url = buildUri(base, 'Property').top(10).build();
    expect(url).toBe('http://localhost:8080/Property?%24top=10');
  });

  it('adds $skip', () => {
    const url = buildUri(base, 'Property').skip(20).build();
    expect(url).toBe('http://localhost:8080/Property?%24skip=20');
  });

  it('adds $count', () => {
    const url = buildUri(base, 'Property').count().build();
    expect(url).toBe('http://localhost:8080/Property?%24count=true');
  });

  it('combines multiple query options', () => {
    const url = buildUri(base, 'Property')
      .select('ListPrice', 'City')
      .filter('ListPrice gt 200000')
      .orderby('ListPrice desc')
      .top(10)
      .skip(0)
      .count()
      .build();
    expect(url).toContain('%24select=ListPrice,City');
    expect(url).toContain('%24top=10');
    expect(url).toContain('%24skip=0');
    expect(url).toContain('%24count=true');
  });

  it('combines key with query options', () => {
    const url = buildUri(base, 'Property').key('ABC').select('ListPrice').build();
    expect(url).toBe("http://localhost:8080/Property('ABC')?%24select=ListPrice");
  });

  it('adds $expand', () => {
    const url = buildUri(base, 'Property').expand('Media').build();
    expect(url).toBe('http://localhost:8080/Property?%24expand=Media');
  });

  it('adds $expand with nested options', () => {
    const url = buildUri(base, 'Property').expand('Media($select=MediaURL,MimeType)').build();
    expect(url).toContain('%24expand=');
    expect(url).toContain('Media');
  });

  it('adds compound key', () => {
    const url = buildUri(base, 'OrderLine').compoundKey({ OrderId: '123', LineNumber: '1' }).build();
    expect(url).toBe("http://localhost:8080/OrderLine(OrderId='123',LineNumber='1')");
  });

  it('adds $search', () => {
    const url = buildUri(base, 'Property').search('luxury pool').build();
    expect(url).toContain('%24search=');
    expect(url).toContain('luxury');
  });

  it('adds $compute', () => {
    const url = buildUri(base, 'Property').compute('ListPrice mul 1.1 as AdjustedPrice').build();
    expect(url).toContain('%24compute=');
  });

  it('adds $format', () => {
    const url = buildUri(base, 'Property').format('json').build();
    expect(url).toContain('%24format=json');
  });

  it('is immutable — chaining returns new builder', () => {
    const builder = buildUri(base, 'Property');
    const withKey = builder.key('ABC');
    const withTop = builder.top(10);

    expect(builder.build()).toBe('http://localhost:8080/Property');
    expect(withKey.build()).toBe("http://localhost:8080/Property('ABC')");
    expect(withTop.build()).toBe('http://localhost:8080/Property?%24top=10');
  });

  it('encodes OData system query option $ prefix as %24', () => {
    const url = buildUri(base, 'Lookup').top(1000).skip(0).build();
    expect(url).toBe('http://localhost:8080/Lookup?%24top=1000&%24skip=0');
    // Must not contain unencoded $ in query string
    const qs = url.split('?')[1];
    expect(qs).not.toContain('$');
  });
});
