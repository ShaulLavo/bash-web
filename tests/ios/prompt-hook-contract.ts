export const promptHookCases = [
  { id: "H01", label: "a prompt provider draws each prompt and redraws it in place" },
  { id: "H02", label: "prompt hook costs" },
] as const;

export type PromptHookCaseId = (typeof promptHookCases)[number]["id"];
export type PromptHookRequest = { caseId: PromptHookCaseId };
