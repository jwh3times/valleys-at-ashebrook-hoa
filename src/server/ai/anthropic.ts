import Anthropic from '@anthropic-ai/sdk';

export class AssistantNotConfiguredError extends Error {
  constructor() {
    super('The assistant is not configured');
    this.name = 'AssistantNotConfiguredError';
  }
}

export function getAnthropic(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new AssistantNotConfiguredError();
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}
