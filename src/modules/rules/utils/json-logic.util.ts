import { BadRequestException } from '@nestjs/common';
import type { AdditionalOperation, RulesLogic } from 'json-logic-js';
import * as jsonLogicNamespace from 'json-logic-js';
import { FORBIDDEN_PATH_SEGMENTS } from '../../../common/utils/get-by-path.util.js';

export type JsonLogicCondition = Record<string, unknown> | boolean;

interface JsonLogicRuntime {
  apply(logic: RulesLogic<AdditionalOperation>, data?: unknown): unknown;
  truthy(value: unknown): boolean;
}

const jsonLogic: JsonLogicRuntime =
  typeof (jsonLogicNamespace as unknown as { apply?: unknown }).apply === 'function'
    ? (jsonLogicNamespace as unknown as JsonLogicRuntime)
    : (jsonLogicNamespace as unknown as { default: JsonLogicRuntime }).default;

const MAX_AST_DEPTH = 32;
const PATH_OPERATORS: ReadonlySet<string> = new Set(['var', 'missing', 'missing_some']);

function assertSafeVariablePath(pathCandidate: unknown): void {
  if (typeof pathCandidate !== 'string') {
    return;
  }

  for (const segment of pathCandidate.split('.')) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new BadRequestException(
        `JsonLogic variable path contains forbidden segment "${segment}"`,
      );
    }
  }
}

function inspectPathOperatorArgs(operator: string, args: unknown): void {
  if (operator === 'var') {
    if (typeof args === 'string') {
      assertSafeVariablePath(args);
    } else if (Array.isArray(args) && args.length > 0) {
      assertSafeVariablePath(args[0]);
    }
    return;
  }

  if (operator === 'missing') {
    if (typeof args === 'string') {
      assertSafeVariablePath(args);
    } else if (Array.isArray(args)) {
      for (const entry of args) {
        assertSafeVariablePath(entry);
      }
    }
    return;
  }

  if (operator === 'missing_some' && Array.isArray(args) && Array.isArray(args[1])) {
    for (const entry of args[1]) {
      assertSafeVariablePath(entry);
    }
  }
}

export function assertSafeJsonLogicAst(node: unknown, depth = 0): void {
  if (depth > MAX_AST_DEPTH) {
    throw new BadRequestException('JsonLogic condition exceeds maximum nesting depth');
  }

  if (node === null || node === undefined || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      assertSafeJsonLogicAst(item, depth + 1);
    }
    return;
  }

  for (const key of Object.keys(node)) {
    if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
      throw new BadRequestException(`JsonLogic AST contains forbidden key "${key}"`);
    }

    const child = (node as Record<string, unknown>)[key];
    if (PATH_OPERATORS.has(key)) {
      inspectPathOperatorArgs(key, child);
    }
    assertSafeJsonLogicAst(child, depth + 1);
  }
}

function cloneSafeEvaluationData(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => cloneSafeEvaluationData(entry, seen));
  }

  const safeObj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
      continue;
    }
    if (Object.hasOwn(value, key)) {
      safeObj[key] = cloneSafeEvaluationData((value as Record<string, unknown>)[key], seen);
    }
  }
  return safeObj;
}

export function evaluateJsonLogicCondition(
  condition: JsonLogicCondition | null | undefined,
  context: Record<string, unknown>,
): boolean {
  if (condition === null || condition === undefined) {
    return true;
  }

  if (typeof condition === 'boolean') {
    return condition;
  }

  assertSafeJsonLogicAst(condition);

  if (Object.keys(condition).length === 0) {
    return true;
  }

  const safeData = cloneSafeEvaluationData(context);
  const outcome = jsonLogic.apply(condition as RulesLogic<AdditionalOperation>, safeData);
  return jsonLogic.truthy(outcome);
}
