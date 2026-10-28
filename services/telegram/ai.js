// services/telegram/ai.js — one call to the AI model with ONE forced tool, so the answer is always structured JSON.
// The model only READS the supervisor's message into a fixed shape; every reply the bot sends is a fixed template
// (messages.js) and every write goes through the app's own routes after the supervisor confirms.
//
// Settings (this server's own key, separate from Team Flow's):
//   BOT_AI_PROVIDER        'openai' or 'anthropic' (default: openai when OPENAI_API_KEY is set, otherwise anthropic)
//   OPENAI_API_KEY         OpenAI key (also used for voice)
//   ANTHROPIC_API_KEY      Anthropic key
//   BOT_AI_MODEL           optional; default gpt-4.1-mini / claude-haiku-4-5
//   BOT_AI_STRONG_MODEL    optional second look at a message the first model did not understand
//                          (default gpt-4.1 / claude-sonnet-4-5; 'off' = never). Tests: only when set.
//   BOT_AI_TIMEOUT_MS      optional, default 30000
// Tests replace the HTTP call with setTransport() (Anthropic shape in and out).
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

let transport = null;

class AiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const key = (name) => String(process.env[name] || '').trim();

function provider() {
  const p = key('BOT_AI_PROVIDER').toLowerCase();
  if (p === 'openai' || p === 'anthropic') return p;
  return key('OPENAI_API_KEY') ? 'openai' : 'anthropic';
}

function isConfigured() {
  if (transport) return true;
  return provider() === 'openai' ? Boolean(key('OPENAI_API_KEY')) : Boolean(key('ANTHROPIC_API_KEY'));
}

function model() { return key('BOT_AI_MODEL') || (provider() === 'openai' ? 'gpt-4.1-mini' : 'claude-haiku-4-5'); }

function strongModel() {
  const v = key('BOT_AI_STRONG_MODEL');
  if (v.toLowerCase() === 'off') return null;
  const m = v || (transport ? '' : provider() === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5');
  return m && m !== model() ? m : null;
}

function timeoutMs() { return Number(process.env.BOT_AI_TIMEOUT_MS) || 30000; }

async function post(url, headers, body, timeout) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new AiError(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', e.message);
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const err = data && data.error;
    throw new AiError(res.status === 429 || res.status === 529 ? 'BUSY' : 'API_ERROR', err ? `${err.type || err.code || 'error'}: ${err.message}` : `HTTP ${res.status}`);
  }
  return data;
}

async function callAnthropic(request, toolName, timeout) {
  const data = transport ? await transport(request) : await post(ANTHROPIC_URL, { 'x-api-key': key('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, request, timeout);
  if (data && data.stop_reason === 'max_tokens') throw new AiError('TRUNCATED', 'The reply was cut (max_tokens).');
  const block = data && Array.isArray(data.content) ? data.content.find((c) => c.type === 'tool_use' && c.name === toolName) : null;
  if (!block || !block.input || typeof block.input !== 'object') throw new AiError('BAD_REPLY', 'The model did not use the tool.');
  return { input: block.input, usage: data.usage || null, model: data.model || request.model };
}

async function callOpenAI(request, tool, timeout) {
  const reasoning = /^(gpt-5|o\d)/i.test(request.model);
  const body = {
    model: request.model,
    ...(reasoning ? {} : { temperature: 0 }),
    max_completion_tokens: reasoning ? Math.max(request.max_tokens, 4000) : request.max_tokens,
    messages: [{ role: 'system', content: request.system.map((s) => s.text).join('\n\n') }, ...request.messages],
    tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
    tool_choice: { type: 'function', function: { name: tool.name } },
  };
  const data = await post(OPENAI_URL, { authorization: `Bearer ${key('OPENAI_API_KEY')}` }, body, timeout);
  const choice = data && data.choices && data.choices[0];
  if (choice && choice.finish_reason === 'length') throw new AiError('TRUNCATED', 'The reply was cut (max tokens).');
  const call = choice && choice.message && Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls.find((c) => c.function && c.function.name === tool.name) : null;
  let input = null;
  try { input = call ? JSON.parse(call.function.arguments) : null; } catch (_) { input = null; }
  if (!input || typeof input !== 'object') throw new AiError('BAD_REPLY', 'The model did not use the tool.');
  const u = data.usage || null;
  return { input, usage: u ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } : null, model: data.model || body.model };
}

/** callTool({ system, user, tool, maxTokens?, timeoutMs?, model? }) -> { input, usage, model, latencyMs, provider } */
async function callTool({ system, user, tool, maxTokens = 2000, timeoutMs: timeout = timeoutMs(), model: chosen = null }) {
  if (!isConfigured()) throw new AiError('NOT_CONFIGURED', 'No AI key is set (OPENAI_API_KEY or ANTHROPIC_API_KEY).');
  const request = {
    model: chosen || model(), max_tokens: maxTokens, temperature: 0,
    system: [{ type: 'text', text: system }], tools: [tool], tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }],
  };
  const started = Date.now();
  const p = transport ? 'test' : provider();
  const r = p === 'openai' ? await callOpenAI(request, tool, timeout) : await callAnthropic(request, tool.name, timeout);
  return { ...r, latencyMs: Date.now() - started, provider: p };
}

module.exports = { callTool, isConfigured, provider, model, strongModel, timeoutMs, AiError, setTransport(fn) { transport = fn; } };
