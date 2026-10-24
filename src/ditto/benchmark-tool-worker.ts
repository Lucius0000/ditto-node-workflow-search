import { parentPort, workerData } from "node:worker_threads";

type Request = { id: number; tool: "bounded_arithmetic" | "literal_text_find"; args: Record<string, unknown> };
type Response = { id: number; ok: true; value: unknown } | { id: number; ok: false; kind: "input" | "limit"; message: string };

const delayMs = (workerData as { testDelayMs?: number } | undefined)?.testDelayMs ?? 0;
const crashForTest = (workerData as { testCrash?: boolean } | undefined)?.testCrash === true;

parentPort?.on("message", (request: Request) => {
  if (crashForTest) throw new TypeError('Injected tool implementation fault');
  if (delayMs > 0) {
    const until = Date.now() + delayMs;
    while (Date.now() < until) { /* test-only worker delay */ }
  }
  let response: Response;
  try {
    const value = request.tool === "bounded_arithmetic"
      ? evaluateArithmetic(request.args.expression)
      : findLiteralMatches(request.args.text, request.args.needle);
    response = { id: request.id, ok: true, value };
  } catch (error) {
    if (!(error instanceof ToolInputFault) && !(error instanceof ToolLimitFault)) throw error;
    response = {
      id: request.id,
      ok: false,
      kind: error instanceof ToolLimitFault ? "limit" : "input",
      message: error instanceof Error ? error.message : "Invalid tool input",
    };
  }
  parentPort?.postMessage(response);
});

class ToolLimitFault extends Error {}
class ToolInputFault extends Error {}

function evaluateArithmetic(input: unknown): number {
  if (typeof input !== "string" || input.length === 0) throw new ToolInputFault("expression must be a non-empty string");
  if (input.length > 4096) throw new ToolLimitFault("expression exceeds 4096 characters");
  return new ArithmeticParser(input).parse();
}

class ArithmeticParser {
  private nodes = 0;
  private readonly tokens: string[];
  private tokenIndex = 0;

  constructor(source: string) {
    const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/^]/g) ?? [];
    if (tokens.join("") !== source.replace(/\s+/g, "")) throw new ToolInputFault("expression contains unsupported characters");
    if (tokens.length > 256) throw new ToolLimitFault("expression exceeds 256 syntax items");
    for (const token of tokens) {
      if (/\d/.test(token) && token.replace(/\D/g, "").replace(/^0+/, "").length > 32) {
        throw new ToolLimitFault("numeric literal exceeds 32 significant decimal digits");
      }
    }
    this.tokens = tokens;
  }

  parse(): number {
    if (this.tokens.length === 0) throw new ToolInputFault("expression is empty");
    const value = this.additive(0);
    if (this.tokenIndex !== this.tokens.length) throw new ToolInputFault("expression has trailing or invalid syntax");
    return this.check(value);
  }

  private additive(depth: number): number {
    this.guardDepth(depth);
    let value = this.multiplicative(depth + 1);
    while (this.peek() === "+" || this.peek() === "-") {
      const operator = this.take();
      const right = this.multiplicative(depth + 1);
      this.countNode();
      value = this.check(operator === "+" ? value + right : value - right);
    }
    return value;
  }

  private multiplicative(depth: number): number {
    this.guardDepth(depth);
    let value = this.unary(depth + 1);
    while (this.peek() === "*" || this.peek() === "/") {
      const operator = this.take();
      const right = this.unary(depth + 1);
      if (operator === "/" && right === 0) throw new ToolInputFault("division by zero is not allowed");
      this.countNode();
      value = this.check(operator === "*" ? value * right : value / right);
    }
    return value;
  }

  private unary(depth: number): number {
    this.guardDepth(depth);
    if (this.peek() === "+" || this.peek() === "-") {
      const operator = this.take();
      const value = this.unary(depth + 1);
      this.countNode();
      return this.check(operator === "-" ? -value : value);
    }
    return this.power(depth + 1);
  }

  private power(depth: number): number {
    this.guardDepth(depth);
    let value = this.primary(depth + 1);
    if (this.peek() === "^") {
      this.take();
      const exponent = this.unary(depth + 1);
      if (!Number.isInteger(exponent) || exponent < -100 || exponent > 100) {
        throw new ToolInputFault("power exponent must be an integer from -100 to 100");
      }
      if (value === 0 && exponent < 0) throw new ToolInputFault("zero cannot be raised to a negative power");
      this.countNode();
      value = this.check(value ** exponent);
    }
    return value;
  }

  private primary(depth: number): number {
    this.guardDepth(depth);
    const token = this.peek();
    if (token === "(") {
      this.take();
      const value = this.additive(depth + 1);
      if (this.take() !== ")") throw new ToolInputFault("missing closing parenthesis");
      this.countNode();
      return value;
    }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new ToolInputFault("expected a decimal number");
    this.take();
    this.countNode();
    return this.check(Number(token));
  }

  private check(value: number): number {
    if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw new ToolLimitFault("intermediate result is non-finite or exceeds 1e100");
    return value;
  }

  private countNode(): void {
    this.nodes += 1;
    if (this.nodes > 256) throw new ToolLimitFault("expression exceeds 256 AST nodes");
  }

  private guardDepth(depth: number): void {
    if (depth > 32) throw new ToolLimitFault("expression nesting exceeds depth 32");
  }

  private peek(): string | undefined { return this.tokens[this.tokenIndex]; }
  private take(): string | undefined { return this.tokens[this.tokenIndex++]; }
}

function findLiteralMatches(textValue: unknown, needleValue: unknown): { count: number; truncated: boolean; matches: Array<{ position: number; snippet: string }> } {
  if (typeof textValue !== "string") throw new ToolInputFault("text must be a string");
  if (typeof needleValue !== "string" || needleValue.length === 0) throw new ToolInputFault("needle must be a non-empty string");
  if (textValue.length > 65536) throw new ToolLimitFault("text exceeds 65536 characters");
  if (needleValue.length > 256) throw new ToolLimitFault("needle exceeds 256 characters");
  const matches: Array<{ position: number; snippet: string }> = [];
  let position = 0;
  let truncated = false;
  while (position <= textValue.length - needleValue.length) {
    const found = textValue.indexOf(needleValue, position);
    if (found < 0) break;
    if (matches.length === 100) { truncated = true; break; }
    matches.push({
      position: found,
      snippet: textValue.slice(Math.max(0, found - 64), found + needleValue.length + 64).slice(0, 256),
    });
    position = found + Math.max(needleValue.length, 1);
  }
  return { count: matches.length, truncated, matches };
}
