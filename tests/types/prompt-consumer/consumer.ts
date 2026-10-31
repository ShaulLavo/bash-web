import { createPrompt, type CreatePromptOptions, type PromptProvider } from "bash-web/prompt";

const promptFactory: (options: CreatePromptOptions) => PromptProvider = createPrompt;
void promptFactory;
