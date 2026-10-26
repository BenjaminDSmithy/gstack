import type { TemplateContext } from '../types';

export function generateConfusionProtocol(ctx?: TemplateContext): string {
  if (ctx?.explainLevel === 'terse') return '';
  return `## Confusion Protocol

For high-stakes ambiguity (architecture, data model, destructive scope, missing context), STOP. Name it in one sentence, then ask with AskUserQuestion: 2-3 options with tradeoffs, the recommended one first. Do not use for routine coding or obvious changes.`;
}
