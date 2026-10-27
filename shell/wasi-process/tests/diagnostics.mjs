const expected = new Map([
  [
    "raw-admission",
    /^Error: Cannot instrument WebAssembly: reserved import namespace runtime_proc(?:\n|$)/,
  ],
  ["missing-executable", /^ExecutableNotFound: executable not found: \/bin\/missing(?:\n|$)/],
  ["missing-entry", /^Error: Error: guest has no _start entry point(?:\n|$)/],
]);

export function describeError(error) {
  try {
    return error instanceof Error ? String(error.stack ?? error.message) : String(error);
  } catch {
    return "<unprintable error>";
  }
}

export function createBrokerDiagnostics() {
  const messages = [];
  return {
    messages,
    onError(error) {
      messages.push(describeError(error));
    },
    verify(labels) {
      verifyBrokerDiagnostics(messages, labels);
    },
  };
}

function verifyBrokerDiagnostics(messages, labels) {
  const counts = new Map(labels.map((label) => [label, 0]));
  for (const message of messages) countDiagnostic(message, counts);
  for (const [label, count] of counts) {
    if (count !== 1) throw new Error(`expected one broker diagnostic ${label}, got ${count}`);
  }
}

function countDiagnostic(message, counts) {
  const match = Array.from(expected).find(([, pattern]) => pattern.test(message));
  if (!match || !counts.has(match[0])) throw new Error(`unexpected broker diagnostic: ${message}`);
  counts.set(match[0], counts.get(match[0]) + 1);
}

export function verifyPageDiagnostics(messages) {
  if (messages.length) throw new Error(`unexpected page diagnostic: ${messages.join("\n")}`);
}
