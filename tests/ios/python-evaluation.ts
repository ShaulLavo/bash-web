import type { HostCase } from "waffle/testing/page-runner";

export function pythonEvaluationValue(encoded: unknown): unknown {
  if (typeof encoded !== "string") throw new Error("Missing Python evaluation JSON");
  const envelope: unknown = JSON.parse(encoded);
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.keys(envelope).some((key) => key !== "value")
  )
    throw new Error("Invalid Python evaluation envelope");
  return "value" in envelope ? envelope.value : undefined;
}

export class PythonEvaluation {
  private next = 0;
  constructor(protected readonly host: HostCase) {}
  async evaluate(callback: unknown, argument?: unknown): Promise<unknown> {
    if (typeof callback !== "function") throw new Error("Expected original Python page callback");
    const key = `python-value-${this.next++}`;
    await this.host.task(`const value = await (${callback.toString()})(${JSON.stringify(argument)});
(window.__pythonValues ??= new Map()).set(${JSON.stringify(key)}, JSON.stringify({value}));`);
    const encoded = await this.host.script(`const key=${JSON.stringify(key)};
const value=window.__pythonValues.get(key);window.__pythonValues.delete(key);return value;`);
    return pythonEvaluationValue(encoded);
  }
}
