export interface IgnoreRule {
  readonly base: string;
  readonly negate: boolean;
  readonly directory: boolean;
  readonly pattern: RegExp;
}

export function parseIgnore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const source of text.split(/\r?\n/u)) {
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
    pattern: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${glob(line)}$`, "u"),
  };
}

function escaped(text: string, offset: number): boolean {
  let count = 0;
  while (offset > 0 && text[--offset] === "\\") count++;
  return count % 2 === 1;
}

export function ignored(path: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  let result = false;
  for (const rule of rules) {
    if (rule.directory && !directory) continue;
    if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
    const relative = rule.base ? path.slice(rule.base.length + 1) : path;
    if (rule.pattern.test(relative)) result = !rule.negate;
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
  punct: "!-/:-@[-`{-~",
  space: "\\s",
  upper: "A-Z",
  xdigit: "a-fA-F0-9",
};

function glob(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      result += literal(pattern[++index] ?? "\\");
      continue;
    }
    if (char === "*") {
      const end = starEnd(pattern, index);
      const recursive =
        end > index + 1 &&
        (index === 0 || pattern[index - 1] === "/") &&
        (end === pattern.length || pattern[end] === "/");
      result += recursive ? (pattern[end] === "/" ? "(?:.*/)?" : ".*") : "[^/]*";
      index = recursive && pattern[end] === "/" ? end : end - 1;
      continue;
    }
    if (char === "[") {
      const bracket = bracketPattern(pattern, index);
      result += bracket.text;
      index = bracket.end;
      continue;
    }
    result += char === "?" ? "[^/]" : literal(char);
  }
  return result;
}

function starEnd(pattern: string, start: number): number {
  while (pattern[start] === "*") start++;
  return start;
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

function literal(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
