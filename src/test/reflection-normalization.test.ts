import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReflectionResponse } from "../ditto/reflection-normalization.js";
import { validateReflectionResponse } from "../ditto/reflection-schema.js";

const issue = { severity: "warning", description: "Check the stated assumption.", suggestedFix: "Keep the stated units." };
const revisedResult = { role: "assistant", content: "The original answer remains 48 hours.", metadata: { source: "model" } };
const assessment = { passed: false, summary: "Arithmetic is consistent; the assumption needs clarification." };
const valid = JSON.stringify({ assessment, issues: [issue], revisedResult });

test("valid REFLECT JSON and accepted fences remain byte-for-byte unchanged", () => {
  for (const content of [valid, ` \n\`\`\`json\n${valid}\n\`\`\`\n`, JSON.stringify({ assessment: { summary: "" }, issues: [] })]) {
    const result = normalizeReflectionResponse(content, content.includes('"passed"') ? "verify" : "critique");
    assert.equal(result.content, content);
    assert.deepEqual(result.repairs, []);
  }
});

test("misnested issues and revisedResult move intact without inferring assessment or answer", () => {
  const original = { assessment: { ...assessment, issues: [issue], revisedResult, other: { unchanged: [false, null, 0] } }, label: "retain" };
  const result = normalizeReflectionResponse(JSON.stringify(original), "revise");
  assert.deepEqual(JSON.parse(result.content), {
    assessment: { ...assessment, other: { unchanged: [false, null, 0] } }, label: "retain", issues: [issue], revisedResult,
  });
  assert.deepEqual(result.repairs, ["promote-assessment.issues", "promote-assessment.revisedResult"]);
  validateReflectionResponse(result.content, "revise");
});

test("identical nested fields are removed as redundant, while conflicts are refused", () => {
  const duplicated = {
    assessment: { ...assessment, issues: [issue], revisedResult: { metadata: { source: "model" }, content: revisedResult.content, role: "assistant" } },
    issues: [issue], revisedResult,
  };
  const result = normalizeReflectionResponse(JSON.stringify(duplicated), "revise");
  assert.deepEqual(JSON.parse(result.content), JSON.parse(valid));
  assert.deepEqual(result.repairs, ["remove-redundant-assessment.issues", "remove-redundant-assessment.revisedResult"]);
  for (const change of [
    { issues: [] },
    { revisedResult: { role: "assistant", content: "a different answer" } },
    { issues: null },
  ]) {
    assert.throws(() => normalizeReflectionResponse(JSON.stringify({ ...duplicated, ...change }), "revise"), /Conflicting/);
  }
});

test("only surplus closing object braces after a complete object are trimmed", () => {
  const content = JSON.stringify({ assessment: { ...assessment, summary: 'Literal } { [ ] and "quotes" stay intact.' }, issues: [], revisedResult });
  const result = normalizeReflectionResponse(`${content} \n} }\t}`, "verify");
  assert.equal(result.content, content);
  assert.deepEqual(result.repairs, Array(3).fill("remove-surplus-closing-brace"));
  for (const tail of ["{}", " more text", " ]", ' "quoted text"', " }\n{}", " }\nexplanation"]) {
    assert.throws(() => normalizeReflectionResponse(content + tail, "verify"), /trailing content/);
  }
  assert.throws(() => normalizeReflectionResponse(content.slice(0, -1), "verify"), /Incomplete/);
});

test("only invalid backslash escapes are doubled; all existing valid escapes keep their meaning", () => {
  const content = String.raw`{"assessment":{"passed":false,"summary":"Keep \n \t \b \f \r \/ \" \\ \u4e2d valid; fix \] and \q and \u12G4."},"issues":[],"revisedResult":{"role":"assistant","content":"48"}}`;
  const result = normalizeReflectionResponse(content, "verify");
  assert.deepEqual(result.repairs, Array(3).fill("escape-invalid-backslash"));
  const expected = content.replace(String.raw`\]`, String.raw`\\]`).replace(String.raw`\q`, String.raw`\\q`).replace(String.raw`\u12G4`, String.raw`\\u12G4`);
  assert.equal(result.content, expected);
  assert.equal(JSON.parse(result.content).assessment.passed, false);
  assert.equal(JSON.parse(result.content).revisedResult.content, "48");
  const alreadyValid = JSON.stringify({ assessment: { passed: false, summary: "\n\t\\]\\q\"\\" }, issues: [] });
  assert.equal(normalizeReflectionResponse(alreadyValid, "verify").content, alreadyValid);
});

test("repairs compose across escaped mathematical text, surplus braces, and nested fields", () => {
  const content = String.raw`{"assessment":{"passed":false,"summary":"Keep \[x\] literal.","issues":[],"revisedResult":{"role":"assistant","content":"same answer"}}}}`;
  const result = normalizeReflectionResponse(content, "revise");
  assert.deepEqual(result.repairs, [
    "escape-invalid-backslash", "escape-invalid-backslash", "remove-surplus-closing-brace",
    "promote-assessment.issues", "promote-assessment.revisedResult",
  ]);
  assert.deepEqual(JSON.parse(result.content), {
    assessment: { passed: false, summary: String.raw`Keep \[x\] literal.` }, issues: [], revisedResult: { role: "assistant", content: "same answer" },
  });
});

test("semantic omissions, invalid types, nulls, raw quotes, and control ambiguity remain errors", () => {
  for (const [content, mode] of [
    [JSON.stringify({ assessment: { summary: "Missing passed" }, issues: [] }), "verify"],
    [JSON.stringify({ assessment, issues: [] }), "revise"],
    [JSON.stringify({ assessment, issues: [{ ...issue, suggestedFix: null }] }), "verify"],
    [JSON.stringify({ assessment: { ...assessment, issues: null } }), "verify"],
    [JSON.stringify({ assessment: { ...assessment, issues: [{ severity: "guess", description: "wrong" }] } }), "verify"],
    ['{"assessment":{"passed":false,"summary":"said "hello""},"issues":[]}', "verify"],
    ['{"assessment":{"passed":false,"summary":"raw\nnewline"},"issues":[]}', "verify"],
    ['{"assessment":{"passed":false,"summary":"backslash\\\nnewline"},"issues":[]}', "verify"],
    ["plain answer", "verify"],
    ["[]", "verify"],
  ] as const) {
    assert.throws(() => normalizeReflectionResponse(content, mode), Error);
  }
  assert.throws(() => normalizeReflectionResponse([], "verify"), /JSON object string/);
});

test("duplicate JSON keys including escaped spellings are refused before values can be discarded", () => {
  for (const content of [
    '{"assessment":{"passed":false,"passed":true,"summary":"ambiguous"},"issues":[]}',
    String.raw`{"assessment":{"passed":false,"summary":"ambiguous"},"issues":[],"\u0069ssues":[{"severity":"error","description":"discarded?"}]}`,
    '{"assessment":{"passed":false,"summary":"ok"},"issues":[],"extra":[{"x":1,"x":2}]}',
  ]) {
    assert.throws(() => normalizeReflectionResponse(content, "verify"), /Ambiguous duplicate/);
  }
});

test("structural rewriting refuses numeric values that JSON serialization would change", () => {
  for (const numericText of ["-0", "1e400"]) {
    const nested = `{"assessment":{"passed":false,"summary":"ok","issues":[]},"extra":${numericText}}`;
    assert.throws(() => normalizeReflectionResponse(nested, "verify"), /would change JSON values/);
    const alreadyValid = `{"assessment":{"passed":false,"summary":"ok"},"issues":[],"extra":${numericText}}`;
    assert.equal(normalizeReflectionResponse(alreadyValid, "verify").content, alreadyValid);
  }
});
