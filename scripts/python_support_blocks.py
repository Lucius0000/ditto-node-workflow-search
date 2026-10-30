"""Classify supporting Python declarations without executing model code."""
import ast
import json
import sys


def supporting_block(source):
    try:
        module = ast.parse(source)
    except (SyntaxError, ValueError):
        return False
    # A separate example/test transcript is not a support module. Preserve
    # whole declaration blocks, including decorators, constants and imports;
    # do not alter the chosen entry point or select by grading outcomes.
    declarations = (ast.Import, ast.ImportFrom, ast.FunctionDef,
                    ast.AsyncFunctionDef, ast.ClassDef, ast.Assign, ast.AnnAssign)
    return bool(module.body) and all(
        isinstance(node, declarations)
        or (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str))
        for node in module.body
    )


def signature_only(source):
    """An explanatory function header can precede the actual implementation."""
    try:
        module = ast.parse(source + "\n    pass\n")
    except (SyntaxError, ValueError):
        return False
    if not module.body:
        return False
    function = module.body[-1]
    return (isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef))
            and len(function.body) == 1 and isinstance(function.body[0], ast.Pass)
            and function.body[0].lineno > len(source.splitlines())
            and all(isinstance(node, (ast.Import, ast.ImportFrom)) for node in module.body[:-1]))


if __name__ == "__main__":
    blocks = json.load(sys.stdin)
    if not isinstance(blocks, list) or not all(isinstance(block, str) for block in blocks):
        raise ValueError("Expected a list of source strings")
    json.dump([{"support": supporting_block(block), "signatureOnly": signature_only(block)}
               for block in blocks], sys.stdout)
