import { describe, expect, it } from 'vitest';
import { extractTemplateVariables } from './extract-template-variables.util.js';

describe('extractTemplateVariables', () => {
  it('extracts simple and nested mustache paths, sorted and de-duplicated', () => {
    expect(
      extractTemplateVariables('Hi {{customer.name}}, order {{orderId}} ({{orderId}})'),
    ).toEqual(['customer.name', 'orderId']);
  });

  it('skips helper names but keeps helper arguments and hash values', () => {
    expect(
      extractTemplateVariables('{{formatDate createdAt format=dateFormat}} {{upper (lower title)}}'),
    ).toEqual(['createdAt', 'dateFormat', 'title']);
  });

  it('walks block programs and inverse branches without reporting block helper names', () => {
    const source =
      '{{#if isPaid}}Paid {{amount}}{{else}}Due {{dueDate}}{{/if}}{{#each items}}{{sku}}{{/each}}';
    expect(extractTemplateVariables(source)).toEqual([
      'amount',
      'dueDate',
      'isPaid',
      'items',
      'sku',
    ]);
  });

  it('ignores this, @data variables, parent-scope references, comments and literals', () => {
    const source =
      '{{#each items}}{{this}} {{@index}} {{../currency}}{{/each}}{{!-- {{secret}} --}}{{"literal"}}';
    expect(extractTemplateVariables(source)).toEqual(['items']);
  });

  it('collects partial parameters', () => {
    expect(extractTemplateVariables('{{> footer company}}')).toEqual(['company']);
  });

  it('returns an empty list for static content', () => {
    expect(extractTemplateVariables('<p>Hello</p>')).toEqual([]);
  });

  it('throws on invalid template syntax', () => {
    expect(() => extractTemplateVariables('{{#if open}}unterminated')).toThrow();
  });
});
