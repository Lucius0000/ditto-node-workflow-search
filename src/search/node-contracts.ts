/** Optimizer-facing contracts use only public inputs and existing main Node permissions. */
export const NODE_CONTRACTS = Object.freeze({
  context:{input:'Original public task.',output:'Context items.',boundary:'CONTEXT.LOAD only; no external retrieval or task rewriting.'},
  sample:{input:'Public task and explicitly wired evidence.',output:'Assistant message.',boundary:'One ordinary generation; configurable instruction and solver/finalizer role; no actions or tools.'},
  cot:{input:'Public task and wired evidence.',output:'Result message, steps, status and stopReason.',boundary:'All existing strategies and legal options are searchable: cot/long-cot/tot/got/self-consistency. maxSteps is a positive safe integer enforced by Runtime, bounded by the fixed experiment ceiling. No external actions or hidden reasoning access.'},
  reflect:{input:'targetNodeId naming a directly wired guaranteed result. Other dependencies are evidence.',output:'assessment, issues, optional revisedResult. verify guarantees assessment.passed; revise guarantees revisedResult.',boundary:'Modes critique/verify assess only and never deliver replacement code. revise may replace its explicit target. Main checker contract applies. LLM assessments are not private judge results.'},
  deliberate:{input:'At least two directly wired guaranteed answer sources.',output:'Result message and optional selection metadata.',boundary:'Modes select/merge/consensus/debate follow main permissions. Does not access evaluator answers or tests.'},
});
export const BINDING_CONTRACT = Object.freeze({
  capabilities:'Templates choose an existing main Node type. config overrides its defaults. Legal fields: context includeTaskMetadata; sample role/instruction; cot instruction/strategy/options/maxSteps; reflect mode/criteria; deliberate mode. generation must equal the fixed protocol exactly. No tools, actions, schemas, code execution, providers or private tests.',
  dependencies:'Read current same-Graph output or committed preceding-Graph output. All mandatory inputs exist on every incoming path. Reflection targetNodeId is a direct guaranteed-result dependency. A same-Graph revise depends on the latest preceding verify/critique so it receives findings.',
  feedback:'Optional previous committed outputs; absent on the first visit. Does not replace mandatory current dependencies.',
  graphs:'Explicit nonempty dependency DAGs; all active nodes assigned exactly once. Assembly changes Graph membership, transitions and delivery only; never node configs or bindings.',
  loop:'Explicit next/switch/repeat/end over public declared outputs. No oracle or implicit checker/revision suffix.',
  scoring:'Private code tests grade final delivered code outside this workflow. Only valid complete evaluations are experiences; score zero is valid. No private answers, hidden tests or judge diagnostics are supplied to the optimizer.',
  search:'One add/replace/rewire/remove or pure organize per proposal. Real node versions form vertices; workflow evaluations have a separate ledger. Initial evaluation is separate from the two new valid workflow evaluations.',
});
