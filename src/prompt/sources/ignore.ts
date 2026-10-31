import type { WorkBudget } from "../live";
export interface IgnoreRule {
  readonly base: string;
  readonly negate: boolean;
  readonly directory: boolean;
  readonly pattern: {
    readonly source: string;
    test(path: string, budget: WorkBudget): Promise<boolean>;
  };
}

export async function parseIgnore(
  text: string,
  base: string,
  budget: WorkBudget,
): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const source of text.split(/\r?\n/u)) {
    await budget.checkpoint();
    if (source.length > 4096) throw new Error("ignore limit");
    const rule = parseRule(source, base);
    if (rule) rules.push(rule);
  }
  return rules;
}

function parseRule(source: string, base: string): IgnoreRule | undefined {
  let line = source;
  while (line.endsWith(" ") && !escaped(line, line.length - 1)) line = line.slice(0, -1);
  if (!line || line.startsWith("#")) return undefined;
  const negate = line.startsWith("!");
  if (negate) line = line.slice(1);
  const directory = line.endsWith("/");
  if (directory) line = line.slice(0, -1);
  const anchored = line.startsWith("/") || line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  if (!line) return undefined;
  return {
    base,
    negate,
    directory,
    pattern: compile(line, anchored),
  };
}

function escaped(text: string, offset: number): boolean {
  let count = 0;
  while (offset > 0 && text[--offset] === "\\") count++;
  return count % 2 === 1;
}

export async function ignored(
  path: string,
  directory: boolean,
  rules: readonly IgnoreRule[],
  budget: WorkBudget,
): Promise<boolean> {
  let result = false;
  let index = 0;
  for (const rule of rules) {
    if (index++ % 32 === 0) await budget.checkpoint();
    if (rule.directory && !directory) continue;
    if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
    const relative = rule.base ? path.slice(rule.base.length + 1) : path;
    if (await rule.pattern.test(relative, budget)) result = !rule.negate;
  }
  return result;
}

const classes: Readonly<Record<string, string>> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "\\x21-\\x7e",
  lower: "a-z",
  print: "\\x20-\\x7e",
  punct: "!-/:-@\\[-`{-~",
  space: "\\s",
  upper: "A-Z",
  xdigit: "a-fA-F0-9",
};

type Token = string | RegExp | 0 | 1;
function compile(source: string, anchored: boolean): IgnoreRule["pattern"] {
  const parts = source.split("/").map((part) => (part === "**" ? part : tokens(part)));
  return {
    source: anchored ? `/${source}` : source,
    test(path, budget) {
      return matchParts(
        parts,
        anchored ? path.split("/") : [path.slice(path.lastIndexOf("/") + 1)],
        budget,
      );
    },
  };
}
function tokens(pattern: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      result.push(pattern[++index] ?? "\\");
      continue;
    }
    if (char === "[") {
      const bracket = bracketPattern(pattern, index);
      result.push(new RegExp(`^${bracket.text}$`, "u"));
      index = bracket.end;
      continue;
    }
    result.push(char === "*" ? 0 : char === "?" ? 1 : char);
  }
  return result;
}
async function matchParts(
  pattern: readonly (Token[] | "**")[],
  path: readonly string[],
  budget: WorkBudget,
): Promise<boolean> {
  let positions = new Set([0]);
  for (let index = 0; index < pattern.length; index++) {
    const next = new Set<number>();
    for (const offset of positions) {
      await budget.checkpoint();
      await advance(
        next,
        pattern[index],
        path,
        offset,
        index === pattern.length - 1 && index > 0,
        budget,
      );
    }
    positions = next;
  }
  return positions.has(path.length);
}

async function advance(
  next: Set<number>,
  pattern: Token[] | "**",
  path: readonly string[],
  offset: number,
  trailing: boolean,
  budget: WorkBudget,
): Promise<void> {
  if (pattern !== "**") {
    if (offset < path.length && (await matchName(pattern, path[offset], budget)))
      next.add(offset + 1);
    return;
  }
  for (let index = offset + Number(trailing); index <= path.length; index++) next.add(index);
}
async function matchName(
  tokens: readonly Token[],
  name: string,
  budget: WorkBudget,
): Promise<boolean> {
  let pattern = 0,
    index = 0,
    star = -1,
    retry = 0;
  let steps = 0;
  while (index < name.length) {
    if (steps++ % 256 === 0) await budget.checkpoint();
    const token = tokens[pattern];
    if (token === 0) {
      star = pattern++;
      retry = index;
      continue;
    }
    if (
      token === 1 ||
      token === name[index] ||
      (token instanceof RegExp && token.test(name[index]))
    ) {
      index++;
      pattern++;
      continue;
    }
    if (star < 0) return false;
    pattern = star + 1;
    index = ++retry;
  }
  while (tokens[pattern] === 0) pattern++;
  return pattern === tokens.length;
}

function bracketPattern(pattern: string, start: number): { text: string; end: number } {
  let index = start + 1;
  const negate = pattern[index] === "!" || pattern[index] === "^";
  if (negate) index++;
  let content = "";
  if (pattern[index] === "]") {
    content = "\\]";
    index++;
  }
  for (; index < pattern.length; index++) {
    if (pattern[index] === "]")
      return { text: `(?!/)[${negate ? "^" : ""}${content}]`, end: index };
    const match = /^\[:([a-z]+):\]/u.exec(pattern.slice(index));
    if (match && classes[match[1]]) {
      content += classes[match[1]];
      index += match[0].length - 1;
      continue;
    }
    if (pattern[index] === "\\") {
      content += `\\${pattern[++index] ?? "\\"}`;
      continue;
    }
    content += pattern[index] === "[" ? "\\[" : pattern[index];
  }
  return { text: "\\[", end: start };
}
