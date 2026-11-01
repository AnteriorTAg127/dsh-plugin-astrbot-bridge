/**
 * Host LLM helpers: build a real `UserMessage` and decide whether a resolved
 * model route can accept images (protocol §13.5).
 *
 * A message must be constructed through the host's own factory: the protocol
 * forbids fabricating message identities, and the host owns `MessageId`
 * minting plus the frozen shape the session log round-trips.
 *
 * Vision is a **resolved model capability**, not a field on `AgentOptions` (the
 * real type is `{provider, model, reasoningEffort, maxTokens}` only). The only
 * authority is `LlmModelInfo.inputModalities` returned by
 * `ctx.llm.resolveModelInfo(provider, model)`; an absent declaration means
 * "unknown", and unknown MUST fail closed (§13.5: never assume vision).
 * @module dsh-plugin-astrbot-bridge/host/llm
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * Three-valued vision answer for one exact provider/model route.
 *
 * `UNKNOWN` is deliberately distinct from `TEXT`: the first is a missing or
 * failed capability query (fail closed), the second is a real adapter saying
 * the route does not accept images.
 */
export const VisionCapability = Object.freeze({
  IMAGE: 'image',
  TEXT: 'text',
  UNKNOWN: 'unknown',
});

/**
 * Build one user message from text and image attachments.
 *
 * `createUserMessage` mints the identity and deep-freezes the value, so the
 * result is exactly what the harness would have produced for an interactive
 * prompt.
 * @param {object} input - message content.
 * @param {string} input.text - prompt text.
 * @param {object[]} [input.images] - `ImageAttachmentRef` values to attach.
 * @param {boolean} [input.textOnly] - drop images and describe them instead.
 * @returns {object} frozen `UserMessage`.
 */
export function buildUserMessage(input) {
  /** @type {import('@deepseek-ai/dsh-llm').ContentBlock[]} */
  const blocks = [];
  if (typeof input.text === 'string' && input.text.length > 0) {
    blocks.push({ type: 'text', text: input.text });
  }
  for (const attachment of input.images ?? []) {
    if (input.textOnly === true) {
      blocks.push({ type: 'text', text: textOnlyPlaceholder(attachment) });
      continue;
    }
    blocks.push({ type: 'image', attachment });
  }
  return createUserMessage({ content: blocks, source: { kind: 'user' } });
}

/**
 * Placeholder text for one image the target model cannot see (§13.5).
 * @param {object} attachment - `ImageAttachmentRef`.
 * @returns {string} model-facing description.
 */
export function textOnlyPlaceholder(attachment) {
  const width = Number(attachment?.width ?? 0);
  const height = Number(attachment?.height ?? 0);
  const bytes = Number(attachment?.bytes ?? 0);
  const mediaType = String(attachment?.mediaType ?? 'image');
  return `[image omitted: ${mediaType}, ${width}x${height}, ${bytes} bytes; the selected model cannot view images]`;
}

/**
 * Read the vision answer out of one resolved model record.
 *
 * Only the real field is consulted. `inputModalities` is optional in
 * `LlmModelInfo`; its absence is "unknown" (fail closed), while a present list
 * without `'image'` is a negative capability.
 * @param {object|undefined} modelInfo - `LlmModelInfo` / `LlmResolvedModelInfo`.
 * @returns {'image'|'text'|'unknown'} capability.
 */
export function visionCapabilityOf(modelInfo) {
  const modalities = modelInfo?.inputModalities;
  if (!Array.isArray(modalities)) return VisionCapability.UNKNOWN;
  return modalities.includes('image') ? VisionCapability.IMAGE : VisionCapability.TEXT;
}

/**
 * Whether a *declared* route record carries image input modality.
 *
 * Deprecated for host capability decisions: this reads the bridge/protocol
 * spelling `modalities`, which the real `AgentOptions` does not have, so using
 * it on `agent.options` always answers "no". Use {@link visionCapabilityOf}
 * with a `ctx.llm.resolveModelInfo(...)` result instead.
 * @deprecated host delivery must resolve `inputModalities` through `ctx.llm`.
 * @param {object|undefined} route - record carrying a declared `modalities` list.
 * @returns {boolean} whether images are declared.
 */
export function routeSupportsImages(route) {
  const modalities = route?.modalities;
  if (!Array.isArray(modalities)) return false;
  return modalities.includes('image');
}
