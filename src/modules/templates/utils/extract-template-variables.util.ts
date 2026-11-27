import Handlebars from 'handlebars';

type AstNode = hbs.AST.Node;

function isPathExpression(node: AstNode): node is hbs.AST.PathExpression {
  return node.type === 'PathExpression';
}

function isHelperCall(params: readonly hbs.AST.Expression[], hash: hbs.AST.Hash | undefined): boolean {
  return params.length > 0 || (hash !== undefined && hash.pairs.length > 0);
}

/**
 * Collects payload variable paths referenced by a Handlebars template
 * (e.g. `{{customer.name}}` -> `customer.name`).
 *
 * Helper names in callee position (`{{#each items}}` -> `each`, `{{formatDate createdAt}}`
 * -> `formatDate`), `this`, `@data` variables, and parent-scope (`../`) references are skipped.
 * Returns a sorted, de-duplicated list. Throws on invalid template syntax.
 */
export function extractTemplateVariables(source: string): string[] {
  const variables = new Set<string>();

  const collectPath = (path: hbs.AST.PathExpression): void => {
    if (path.data || path.depth > 0 || path.parts.length === 0) {
      return;
    }
    variables.add(path.parts.join('.'));
  };

  const visitExpressions = (expressions: readonly hbs.AST.Expression[]): void => {
    for (const expression of expressions) {
      visit(expression);
    }
  };

  const visitHash = (hash: hbs.AST.Hash | undefined): void => {
    if (hash === undefined) {
      return;
    }
    for (const pair of hash.pairs) {
      visit(pair.value);
    }
  };

  const visitProgram = (program: hbs.AST.Program | undefined): void => {
    if (program === undefined) {
      return;
    }
    for (const statement of program.body) {
      visit(statement);
    }
  };

  const visit = (node: AstNode): void => {
    switch (node.type) {
      case 'PathExpression': {
        collectPath(node as hbs.AST.PathExpression);
        return;
      }
      case 'MustacheStatement': {
        const mustache = node as hbs.AST.MustacheStatement;
        if (isHelperCall(mustache.params, mustache.hash)) {
          visitExpressions(mustache.params);
          visitHash(mustache.hash);
        } else if (isPathExpression(mustache.path)) {
          collectPath(mustache.path);
        }
        return;
      }
      case 'SubExpression': {
        const sexpr = node as hbs.AST.SubExpression;
        visitExpressions(sexpr.params);
        visitHash(sexpr.hash);
        return;
      }
      case 'BlockStatement': {
        const block = node as hbs.AST.BlockStatement;
        visitExpressions(block.params);
        visitHash(block.hash);
        visitProgram(block.program);
        visitProgram(block.inverse);
        return;
      }
      case 'PartialStatement': {
        const partial = node as hbs.AST.PartialStatement;
        visitExpressions(partial.params);
        visitHash(partial.hash);
        return;
      }
      case 'PartialBlockStatement': {
        const partialBlock = node as hbs.AST.PartialBlockStatement;
        visitExpressions(partialBlock.params);
        visitHash(partialBlock.hash);
        visitProgram(partialBlock.program);
        return;
      }
      case 'Program': {
        visitProgram(node as hbs.AST.Program);
        return;
      }
      default:
        return;
    }
  };

  visitProgram(Handlebars.parse(source));

  return [...variables].sort((a, b) => a.localeCompare(b));
}
