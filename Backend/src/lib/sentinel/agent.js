/**
 * Sentinel's reasoning loop: Claude + tools until it submits a result (or answers in text).
 * Every tool result passes through the run's Pseudonymizer on the way to the model.
 */
const { createMessage } = require('./llm');
const models = require('./models');
const { SYSTEM } = require('./prompts');

const MAX_TOOL_RESULT_CHARS = 24000;

function truncate(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} characters — narrow the query]`;
}

/**
 * @param {object} p
 * @param {object} p.cfg        sentinelConfig()
 * @param {string} p.task       first user message (raw; pseudonymised here)
 * @param {Array}  p.tools      tool definitions
 * @param {object} p.handlers   name -> async (input) => { data, code }
 * @param {string|null} p.finalTool  tool whose input is the result; null = answer in text
 * @param {Pseudonymizer} p.privacy
 * @returns {Promise<{ result: object|null, text: string, usage: object, toolCalls: number }>}
 */
async function runAgent({ cfg, task, tools, handlers, finalTool, privacy }) {
  const messages = [{ role: 'user', content: privacy.outbound(task) }];
  const usage = { input: 0, output: 0 };
  const caps = models.info(cfg.model);
  const servedBy = new Set();
  let toolCalls = 0;
  let nudges = 0;

  for (let step = 1; step <= cfg.maxSteps + 2; step += 1) {
    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
    };
    // Per-model request shape: Haiku 4.5 rejects adaptive thinking and effort.
    if (cfg.thinking && caps.thinking === 'adaptive') body.thinking = { type: 'adaptive' };
    if (caps.effort && cfg.effort) body.output_config = { effort: cfg.effort };

    const resp = await createMessage(cfg, body, { fallbacks: cfg.fallbacks && caps.fallbacks });
    const u = resp.usage || {};
    usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    usage.output += u.output_tokens || 0;
    if (resp.stop_reason === 'refusal') {
      const why = resp.stop_details?.category ? ` (${resp.stop_details.category})` : '';
      const err = new Error(`Claude declined to continue this investigation${why}. Review the report manually.`);
      err.usage = usage;
      err.toolCalls = toolCalls;
      throw err;
    }
    const content = Array.isArray(resp.content) ? resp.content : [];
    // A refusal fallback leaves one `fallback` block per switch; note which model took over.
    for (const b of content) if (b.type === 'fallback' && b.to?.model) servedBy.add(b.to.model);
    messages.push({ role: 'assistant', content });

    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const uses = content.filter((b) => b.type === 'tool_use');
    const final = finalTool ? uses.find((b) => b.name === finalTool) : null;
    if (final) return { result: final.input || {}, text, usage, toolCalls, servedBy: [...servedBy] };

    if (uses.length === 0) {
      if (!finalTool) return { result: null, text, usage, toolCalls, servedBy: [...servedBy] };
      if (nudges >= 2) break;
      nudges += 1;
      messages.push({ role: 'user', content: `Please call ${finalTool} now with your findings.` });
      continue;
    }

    const results = [];
    for (const use of uses) {
      toolCalls += 1;
      const handler = handlers[use.name];
      let out;
      let isError = false;
      try {
        out = handler ? await handler(use.input || {}) : { data: { error: `Unknown tool ${use.name}` } };
        isError = Boolean(out?.data?.error);
      } catch (err) {
        console.error(`Sentinel tool ${use.name} failed:`, err.message);
        out = { data: { error: `Tool failed: ${err.message}` } };
        isError = true;
      }
      const raw = typeof out.data === 'string' ? out.data : JSON.stringify(out.data ?? null);
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: truncate(privacy.outbound(raw, { code: Boolean(out.code) })),
        ...(isError ? { is_error: true } : {}),
      });
    }
    if (step >= cfg.maxSteps - 1) {
      results.push({
        type: 'text',
        text: finalTool
          ? `Tool budget nearly used. In your next response, call ${finalTool} with your best assessment so far.`
          : 'Tool budget nearly used. Answer now with what you have.',
      });
    }
    messages.push({ role: 'user', content: results });
  }
  const err = new Error(`Sentinel did not finish within ${cfg.maxSteps} tool rounds.`);
  err.usage = usage;
  err.toolCalls = toolCalls;
  throw err;
}

module.exports = { runAgent };
