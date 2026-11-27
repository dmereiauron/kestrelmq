import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { extractCurrentWorkspaceId } from '../decorators/current-workspace.decorator.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';
import {
  FORBIDDEN_PATH_SEGMENTS,
  getByPath,
  isSafePathSegment,
} from './get-by-path.util.js';

describe('getByPath', () => {
  it('resolves nested object properties, falsy scalar values, and canonical array indices', () => {
    const payload = {
      order: {
        id: 'ord_1001',
        paid: false,
        discount: 0,
        note: null,
        customer: {
          email: 'buyer@example.com',
        },
      },
      items: [
        { sku: 'KMQ-PRO', qty: 2 },
        { sku: 'KMQ-ADDON', qty: 1 },
      ],
    };

    expect(getByPath(payload, 'order.customer.email')).toBe('buyer@example.com');
    expect(getByPath(payload, 'order.paid')).toBe(false);
    expect(getByPath(payload, 'order.discount')).toBe(0);
    expect(getByPath(payload, 'order.note')).toBeNull();
    expect(getByPath(payload, 'items.0.sku')).toBe('KMQ-PRO');
    expect(getByPath(payload, 'items.1.qty')).toBe(1);
  });

  it('returns undefined for missing paths, malformed paths, non-canonical array indices, and primitive roots', () => {
    const payload = {
      items: [{ sku: 'A' }],
      nested: { count: 5 },
    };

    expect(getByPath(null, 'a.b')).toBeUndefined();
    expect(getByPath(undefined, 'a.b')).toBeUndefined();
    expect(getByPath('primitive', 'length')).toBeUndefined();
    expect(getByPath(42, 'toString')).toBeUndefined();
    expect(getByPath(payload, '')).toBeUndefined();
    expect(getByPath(payload, '.nested.count')).toBeUndefined();
    expect(getByPath(payload, 'nested..count')).toBeUndefined();
    expect(getByPath(payload, 'nested.count.')).toBeUndefined();
    expect(getByPath(payload, 'nested.count.deep')).toBeUndefined();
    expect(getByPath(payload, 'items.length')).toBeUndefined();
    expect(getByPath(payload, 'items.01.sku')).toBeUndefined();
    expect(getByPath(payload, 'items.9.sku')).toBeUndefined();
    expect(getByPath(payload, 'missing.key')).toBeUndefined();
  });

  it('strictly blocks prototype pollution and inherited property traversal', () => {
    expect(FORBIDDEN_PATH_SEGMENTS.has('__proto__')).toBe(true);
    expect(FORBIDDEN_PATH_SEGMENTS.has('constructor')).toBe(true);
    expect(FORBIDDEN_PATH_SEGMENTS.has('prototype')).toBe(true);
    expect(isSafePathSegment('__proto__')).toBe(false);
    expect(isSafePathSegment('constructor')).toBe(false);
    expect(isSafePathSegment('prototype')).toBe(false);
    expect(isSafePathSegment('')).toBe(false);
    expect(isSafePathSegment('email')).toBe(true);

    const inheritedProto = { leakedSecret: 'classified' };
    const objectWithInherited = Object.create(inheritedProto) as Record<string, unknown>;
    objectWithInherited['safeField'] = 'visible';

    // JSON.parse own-property "__proto__" attack vector
    const parsedJsonAttack = JSON.parse(
      '{"__proto__": {"polluted": "pwned"}, "constructor": {"prototype": {"admin": true}}, "user": {"name": "Ada"}}',
    ) as Record<string, unknown>;

    expect(getByPath(objectWithInherited, 'safeField')).toBe('visible');
    expect(getByPath(objectWithInherited, 'leakedSecret')).toBeUndefined();
    expect(getByPath(objectWithInherited, 'toString')).toBeUndefined();
    expect(getByPath(objectWithInherited, 'valueOf')).toBeUndefined();
    expect(getByPath(objectWithInherited, 'hasOwnProperty')).toBeUndefined();
    expect(getByPath(objectWithInherited, '__proto__.leakedSecret')).toBeUndefined();
    expect(getByPath(objectWithInherited, 'constructor.prototype')).toBeUndefined();

    expect(getByPath(parsedJsonAttack, 'user.name')).toBe('Ada');
    expect(getByPath(parsedJsonAttack, '__proto__')).toBeUndefined();
    expect(getByPath(parsedJsonAttack, '__proto__.polluted')).toBeUndefined();
    expect(getByPath(parsedJsonAttack, 'constructor.prototype.admin')).toBeUndefined();
    expect(getByPath(parsedJsonAttack, 'user.__proto__.toString')).toBeUndefined();
  });
});

describe('extractCurrentWorkspaceId', () => {
  it('returns workspaceId when populated and throws BadRequestException when missing', () => {
    const validCtx = {
      switchToHttp: () => ({
        getRequest: () => ({ workspaceId: '11111111-1111-4111-8111-111111111111' }) as AuthenticatedRequest,
      }),
    } as unknown as ExecutionContext;

    const missingCtx = {
      switchToHttp: () => ({
        getRequest: () => ({}) as AuthenticatedRequest,
      }),
    } as unknown as ExecutionContext;

    expect(extractCurrentWorkspaceId(validCtx)).toBe('11111111-1111-4111-8111-111111111111');
    expect(() => extractCurrentWorkspaceId(missingCtx)).toThrow(BadRequestException);
  });
});
