import {parse} from 'acorn';
export class ModuleContractError extends Error { readonly candidateFailure = true; }
const forbiddenNames = new Set(['process','require','global','globalThis','eval','Function','WebAssembly','fetch','Date','setTimeout','setInterval','Reflect','Proxy']);
const forbiddenProperties = new Set(['constructor','__proto__','prototype','getPrototypeOf','setPrototypeOf','getOwnPropertyDescriptor','getOwnPropertyDescriptors','defineProperty','defineProperties','create','toJSON','toString','random']);

/** A syntax guard and bounded VM, not an OS sandbox. Generated tools have a separate JSON-only worker VM. */
export function validateModuleSyntax(source: string): void {
  if (!source.trim() || source.length > 80000) throw new ModuleContractError('Module source must contain 1..80000 characters');
  const ast: any = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration','ImportExpression','ExportAllDeclaration'].includes(node.type)) throw new ModuleContractError('Imports and re-exports are not permitted');
    if (node.type === 'ExportNamedDeclaration' && node.source) throw new ModuleContractError('Re-exports are not permitted');
    if (node.type === 'Identifier' && forbiddenNames.has(node.name)) throw new ModuleContractError(`Unavailable host capability: ${node.name}`);
    if ((node.type === 'Property' || node.type === 'MethodDefinition') && ['get','set'].includes(node.kind)) throw new ModuleContractError('Accessors are not permitted across module boundaries');
    if (node.type === 'Property' && ['toJSON','toString'].includes(node.key?.name ?? node.key?.value)) throw new ModuleContractError('Custom serialization hooks are not permitted');
    if (node.type === 'MemberExpression') {
      const property = node.computed ? node.property?.value : node.property?.name;
      if (typeof property === 'string' && forbiddenProperties.has(property)) throw new ModuleContractError(`Unavailable property: ${property}`);
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'start' && key !== 'end') {
      if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
}
