import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import type { DrainOperation } from "./session-drain-controls";

type Bindings = Record<string, string>;

function quotedEnd(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === quote) return index + 1;
  }
  throw new Error("Unclosed original source string");
}

function closing(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = quotedEnd(source, index) - 1;
      continue;
    }
    if (char === source[start]) depth++;
    if (char === { "(": ")", "{": "}", "[": "]" }[source[start] ?? ""]) depth--;
    if (depth === 0) return index;
  }
  throw new Error("Unclosed original source block");
}

function expressionEnd(source: string, start: number): number {
  const first = source[start];
  if (['"', "'", "`"].includes(first)) return quotedEnd(source, start) - 1;
  if (["(", "{", "["].includes(first)) return closing(source, start);
  return start;
}

function argumentsOf(source: string): string[] {
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < source.length; index++) {
    const end = expressionEnd(source, index);
    if (end !== index) {
      index = end;
      continue;
    }
    const char = source[index];
    if (char !== ",") continue;
    parts.push(source.slice(start, index).trim());
    start = index + 1;
  }
  return parts.concat([source.slice(start).trim()]).filter(Boolean);
}

async function expressionSource(source: string): Promise<string> {
  const { code } = await transform(
    `async function parity() {
${source}
}`,
    {
      loader: "ts",
      target: "esnext",
    },
  );
  let body = code.slice(code.indexOf("{") + 1, code.lastIndexOf("}")).trim();
  if (body.endsWith(";")) body = body.slice(0, -1).trim();
  if (body.startsWith("return ")) body = body.slice("return ".length).trim();
  while (body.startsWith("(") && closing(body, 0) === body.length - 1)
    body = body.slice(1, -1).trim();
  return body;
}

export async function tokens(source: string, bindings: Bindings = {}): Promise<string> {
  source = await expressionSource(source);
  const result: string[] = [];
  const pattern =
    /\s+|(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)|[A-Za-z_$][\w$]*|(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?)|./giy;
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '"' || char === "'") {
      const end = quotedEnd(source, index);
      const text = source.slice(index, end);
      result.push(
        char === '"' ? JSON.stringify(JSON.parse(text)) : JSON.stringify(text.slice(1, -1)),
      );
      index = end;
      continue;
    }
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new Error("Unrecognized source token");
    const text = match[0];
    index = pattern.lastIndex;
    if (/^\s|^\/\/|^\/\*/u.test(text) || text === ";") continue;
    result.push(
      Object.hasOwn(bindings, text)
        ? JSON.stringify(bindings[text])
        : /^\d/u.test(text)
          ? String(Number(text))
          : text,
    );
  }
  return result.join(" ").replace(/ , ([}\]])/gu, " $1");
}

function expandParts(body: string): string {
  const loop = body.indexOf("for (let part");
  if (loop >= 0) {
    const start = body.indexOf("{", loop),
      end = closing(body, start);
    body = body.slice(0, loop) + body.slice(start + 1, end).repeat(3) + body.slice(end + 1);
  }
  return body;
}

async function bodyOperations(body: string, bindings: Bindings): Promise<DrainOperation[]> {
  body = expandParts(body);
  const result: DrainOperation[] = [];
  const pattern = /page\.(evaluate|waitForTimeout)\(/gu;
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    const start = match.index + match[0].length - 1,
      end = closing(body, start);
    const args = argumentsOf(body.slice(start + 1, end));
    pattern.lastIndex = end + 1;
    if (match[1] === "waitForTimeout") {
      result.push({ kind: "sleep", ms: Number(args[0]) });
      continue;
    }
    const callback = args[0] ?? "";
    const arrow = callback.indexOf("=>");
    if (arrow < 0) throw new Error("Missing original evaluate arrow callback");
    let expression = callback.slice(arrow + 2).trim();
    if (expression.startsWith("{")) expression = expression.slice(1, -1);
    const local = { ...bindings };
    const parameter = callback.slice(0, arrow).replace(/async|[()\s]/gu, "");
    if (parameter) local[parameter] = bindings[args[1] ?? ""] ?? "";
    result.push({
      kind: callback.startsWith("async") ? "task" : "script",
      source: await tokens(expression, local),
    });
  }
  return result;
}

export async function originalSessionDrainCases() {
  const original = await readFile(new URL("../session-drain.spec.ts", import.meta.url), "utf8");
  const { code } = await transform(original, { loader: "ts", target: "esnext" });
  const result: { label: string; operations: DrainOperation[]; assertions: string[] }[] = [];
  const pattern = /\btest\(/gu;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    const start = match.index + match[0].length - 1,
      end = closing(code, start);
    const [title = "", callback = ""] = argumentsOf(code.slice(start + 1, end));
    const variable = /\$\{(reader|kind)\}/u.exec(title)?.[1];
    const values = variable ? loopValues(code, variable) : [""];
    const bodyStart = callback.indexOf("=>") + 2;
    for (const value of values) {
      const bindings = variable ? { [variable]: value } : {};
      const label = title.slice(1, -1).replace(`\u0024{${variable}}`, value);
      result.push({
        label,
        operations: await bodyOperations(callback.slice(bodyStart), bindings),
        assertions: await assertionCalls(callback.slice(bodyStart)),
      });
    }
    pattern.lastIndex = end + 1;
  }
  return result;
}

function loopValues(source: string, variable: string): string[] {
  const declaration = `for (const ${variable} of [`;
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`Missing original ${variable} expansion`);
  const array = start + declaration.length - 1;
  const parsed: unknown = JSON.parse(source.slice(array, closing(source, array) + 1));
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string"))
    throw new Error("Invalid original loop parameters");
  return parsed;
}

async function assertionCalls(body: string): Promise<string[]> {
  body = expandParts(body);
  const pattern = /\.(toBe|toEqual|toMatch|toBeLessThan|toBeLessThanOrEqual)\(/gu;
  const assertions: string[] = [];
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    const start = match.index + match[0].length - 1,
      end = closing(body, start);
    assertions.push(`${match[1]} ${await tokens(body.slice(start + 1, end))}`);
    pattern.lastIndex = end + 1;
  }
  return assertions;
}

export async function portSessionDrainAssertions(): Promise<string[][]> {
  const { code } = await transform(
    await readFile(new URL("./session-drain.ts", import.meta.url), "utf8"),
    { loader: "ts", target: "esnext" },
  );
  const names = [
    "idle",
    "phases",
    "paste",
    "paste",
    "burst",
    "completedDrain",
    "capacity",
    "terminal",
    "terminal",
    "disposal",
    "race",
    "interrupt",
  ];
  return Promise.all(
    names.map(async (name) => {
      const nameIndex = code.indexOf(`async function ${name}(`);
      if (nameIndex < 0) throw new Error(`Missing ${name} assertion body`);
      const parameters = code.indexOf("(", nameIndex);
      const start = code.indexOf("{", closing(code, parameters));
      return assertionCalls(code.slice(start + 1, closing(code, start)));
    }),
  );
}
