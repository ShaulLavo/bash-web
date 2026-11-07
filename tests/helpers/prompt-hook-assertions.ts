import { expect } from "@playwright/test";

export function checkPromptHookResult(result: unknown): void {
  expect(result).toEqual({
    prepared: ["/home/guest"],
    contexts: [
      {
        turn: 1,
        cwd: "/home/guest",
        status: 0,
        pipestatus: [],
        ran: false,
        jobs: 0,
        columns: 80,
        lineEditor: "bash",
        ps1: "PS1> ",
        variables: { HOME: "/home/guest" },
      },
      {
        turn: 2,
        cwd: "/home/guest",
        status: 0,
        pipestatus: [1, 0],
        ran: true,
        jobs: 0,
        columns: 80,
        lineEditor: "bash",
        ps1: "PS1> ",
        variables: { HOME: "/home/guest" },
      },
      {
        turn: 3,
        cwd: "/tmp",
        status: 0,
        pipestatus: [0],
        ran: true,
        jobs: 0,
        columns: 80,
        lineEditor: "bash",
        ps1: "PS1> ",
        variables: { FOO: "bar", HOME: "/home/guest" },
      },
      {
        turn: 4,
        cwd: "/tmp",
        status: 0,
        pipestatus: [0],
        ran: false,
        jobs: 0,
        columns: 80,
        lineEditor: "bash",
        ps1: "PS1> ",
        variables: { FOO: "bar", HOME: "/home/guest" },
      },
    ],
    fallbacks: ["null:true", "throw:true", "reject:true", "never:true", "huge:true"],
    lateRepaired: true,
    caretKept: true,
    afterEnterAborted: true,
    noRedrawAfterEnter: true,
    noRedrawAfterInterrupt: true,
    jobsWhileRunning: 1,
    backgroundAfterPrompt: true,
    noRedrawOverBackground: true,
    ctrlLShowsNewest: true,
    usable: true,
    renders: expect.any(Number),
    prompts: expect.any(Number),
    strayWinchIgnored: true,
    plainAlive: true,
  });
  const { renders, prompts } = result as { renders: number; prompts: number };
  expect(renders).toBe(prompts);
}

export type PromptHookAttach = (
  name: string,
  options: { body: string; contentType: string },
) => Promise<void>;

export async function recordPromptHookCosts(
  result: unknown,
  attach: PromptHookAttach,
): Promise<void> {
  console.log(JSON.stringify(result, null, 2));
  await attach("prompt-hook-costs", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
}
