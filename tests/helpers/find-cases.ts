import type { Runtime } from "waffle";

export const findDirectories = ["sub/deep", "empty-dir"];
export const findFiles = [
  ["a.txt", "a"],
  ["sub/b.txt", "bb"],
  ["sub/deep/c.txt", "ccc"],
  ["UPPER.TXT", "upper"],
  ["empty", ""],
  ["two words.txt", "space"],
  ["line\nbreak.txt", "newline"],
  ["-option", "dash"],
  ["$(touch injected)", "literal"],
  ["-exec", "literal"],
  ["-execdir", "literal"],
  ["-ok", "literal"],
  ["-okdir", "literal"],
  ["reply", "y\nuntouched\n"],
  ["roots", "./sub/deep\0./a.txt\0"],
  ["invalid-roots", "./a.txt\0\0./sub/deep\0"],
];

export const findCases: { name: string; script: string; records: "lines" | "nul" | "bytes" }[] = [
  {
    name: "case insensitive name",
    script: "find . -type f -iname '*.TXT' -print0",
    records: "nul",
  },
  { name: "case insensitive path", script: "find . -ipath '*SUB/B.TXT'", records: "lines" },
  {
    name: "whole path regular expression",
    script: "find . -regex './sub/[^/]*[.]txt'",
    records: "lines",
  },
  { name: "empty files and directories", script: "find . -empty", records: "lines" },
  { name: "exact byte size", script: "find sub -type f -size 2c", records: "lines" },
  { name: "size comparison", script: "find sub -type f -size +1c ! -size +2c", records: "lines" },
  { name: "rounded size units", script: "find sub -type f -size 1k", records: "lines" },
  {
    name: "grouped boolean expression",
    script: "find sub \\( -name b.txt -o -name c.txt \\) -a -type f",
    records: "lines",
  },
  {
    name: "default print after false or",
    script: "find sub -false -o -name b.txt",
    records: "lines",
  },
  { name: "depth first order", script: "find sub/deep -depth", records: "bytes" },
  {
    name: "formatted portable fields",
    script: "find sub -type f -printf '%P:%f:%s:%d\\n'",
    records: "lines",
  },
  {
    name: "NUL separated starting paths",
    script: "find -files0-from roots -type f -print0",
    records: "nul",
  },
  {
    name: "NUL starting paths from stdin",
    script: "find -files0-from - -type f -print0 < roots",
    records: "nul",
  },
  { name: "empty starting paths file", script: "find -files0-from empty -print", records: "bytes" },
  {
    name: "unusual operands remain data",
    script: "find './-option' './two words.txt' './line\nbreak.txt' './$(touch injected)' -print0",
    records: "nul",
  },
  {
    name: "quit stops before later roots",
    script: "find a.txt sub -print -quit",
    records: "bytes",
  },
  { name: "inverted depth range", script: "find sub -mindepth 3 -maxdepth 1", records: "bytes" },
  {
    name: "file output with NUL records",
    script:
      "find sub -type f -fprint0 listing; printf 'status:%s\\n' \"$?\"; while IFS= read -r -d '' line; do printf '%s\\0' \"$line\"; done < listing",
    records: "nul",
  },
  { name: "missing starting path fails", script: "find missing -print", records: "bytes" },
  {
    name: "starting paths input read error fails",
    script: "find -files0-from sub -print",
    records: "bytes",
  },
  { name: "invalid expression fails", script: "find sub -name", records: "bytes" },
  {
    name: "empty starting path record fails but keeps later roots",
    script: "find -files0-from invalid-roots -type f -print0",
    records: "nul",
  },
];

for (const predicate of ["-exec", "-execdir", "-ok", "-okdir"]) {
  findCases.push({
    name: `execution spelling is a literal name: ${predicate}`,
    script: `find . -name ${predicate} -print0`,
    records: "nul",
  });
  findCases.push({
    name: `execution spelling is a literal path: ${predicate}`,
    script: `find . -path ${predicate} -print0`,
    records: "nul",
  });
}
findCases.push({
  name: "execution spelling is a literal output format",
  script: "find a.txt -printf -exec",
  records: "bytes",
});

const executionForms = [
  ["-exec", "\\;"],
  ["-exec", "+"],
  ["-execdir", "\\;"],
  ["-execdir", "+"],
  ["-ok", "\\;"],
  ["-okdir", "\\;"],
];

export const findRejections = executionForms.flatMap(([predicate, terminator]) => {
  const action = `${predicate} /bin/true '{}' ${terminator}`;
  return [
    { name: "before print", expression: `a.txt -print , ${action}` },
    { name: "short circuit", expression: `a.txt -false ${action}` },
    { name: "nonmatching traversal", expression: `sub -name absent ${action}` },
    { name: "empty roots", expression: `-files0-from empty ${action}` },
    { name: "before roots input", expression: `-files0-from sub ${action}` },
    { name: "before stdin roots", expression: `-files0-from - ${action}` },
    { name: "before missing root", expression: `missing ${action}` },
  ].map(({ name, expression }) => ({
    name: `${predicate} ${terminator}: ${name}`,
    script: `find ${expression} < reply`,
    diagnostic: `${predicate} is unsupported on WASI`,
    stdout: "",
  }));
});

for (const predicate of ["-ok", "-okdir"]) {
  findRejections.push({
    name: `${predicate}: leaves stdin unread`,
    script: `{ find a.txt ${predicate} /bin/true '{}' \\;; status=$?; IFS= read -r answer; printf 'remaining:%s\\n' "$answer"; exit "$status"; } < reply`,
    diagnostic: `${predicate} is unsupported on WASI`,
    stdout: "remaining:y\n",
  });
}

export async function seedFindTree(runtime: Runtime) {
  for (const path of findDirectories) await runtime.filesystem.mkdirp(`/tree/${path}`);
  for (const [path, contents] of findFiles)
    await runtime.filesystem.writeFile(`/tree/${path}`, contents);
  await runtime.filesystem.mkdirp("/bin");
}

export function findOutput(bytes: Uint8Array, records: "lines" | "nul" | "bytes") {
  const value = new TextDecoder().decode(bytes);
  if (records === "bytes") return value;
  return value.split(records === "lines" ? "\n" : "\0").sort();
}
