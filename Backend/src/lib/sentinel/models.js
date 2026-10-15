/**
 * The Claude models Sentinel may run on, and what each accepts on the Messages API.
 *
 *   thinking   'adaptive' — send thinking: {type: 'adaptive'}; null — send no thinking
 *              parameter (Haiku 4.5 rejects adaptive thinking)
 *   effort     accepts output_config.effort (Haiku 4.5 errors on it)
 *   fallbacks  accepts server-side refusal fallbacks (fallbacks: "default")
 *
 * Only these ids can be selected at run time (from Milo). SENTINEL_MODEL in .env is not
 * restricted to this list, so an operator can still pin any model by hand.
 */
const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', thinking: 'adaptive', effort: true, fallbacks: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', thinking: 'adaptive', effort: true, fallbacks: true },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', thinking: 'adaptive', effort: true, fallbacks: false },
  { id: 'claude-opus-5', label: 'Opus 5', thinking: 'adaptive', effort: true, fallbacks: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', thinking: 'adaptive', effort: true, fallbacks: false },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', thinking: null, effort: false, fallbacks: false },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const isSelectable = (id) => BY_ID.has(String(id || ''));

/** Capabilities for a model id; unknown ids (an operator's manual pin) get the modern defaults. */
function info(id) {
  return BY_ID.get(id) || { id, label: id, thinking: 'adaptive', effort: true, fallbacks: false };
}

module.exports = { MODELS, EFFORTS, isSelectable, info };
