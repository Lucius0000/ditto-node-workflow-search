import type { GraphTransition } from '../domain.js';

/** Declarative node configuration and Graph/Loop wiring; implementations stay trusted. */
export interface OrganizationSpec {
  readonly version: 1;
  readonly dataset: 'humaneval' | 'mbpp' | 'automationbench';
  readonly nodes: readonly { readonly id: string; readonly template: string; readonly dependencies: readonly string[]; readonly feedback?: readonly string[];
    /** Direct result dependency assessed/revised by this REFLECT node. */
    readonly targetNodeId?: string;
    readonly config?: Readonly<Record<string, unknown>> }[];
  readonly graphs: readonly { readonly id: string; readonly nodeIds: readonly string[] }[];
  readonly entryGraphId: string;
  readonly transitions: Readonly<Record<string, GraphTransition>>;
  /** Explicit delivery source on a terminating graph; omitted entries use outputNodeId. */
  readonly outputByGraph?: Readonly<Record<string, string>>;
  readonly outputNodeId: string;
}
