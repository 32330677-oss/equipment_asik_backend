// services/telegram/transcriber.js — voice note -> text (OpenAI speech to text). The audio stays in memory for this
// call only: never saved, never logged. The machines of the day are given as a hint so names come out right.
//   OPENAI_API_KEY   required for voice      BOT_STT_MODEL   optional, default gpt-4o-mini-transcribe
let transport = null;

class TranscribeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const key = () => String(process.env.OPENAI_API_KEY || '').trim();
const model = () => String(process.env.BOT_STT_MODEL || '').trim() || 'gpt-4o-mini-transcribe';
const MAX_SECONDS = 120;

function isConfigured() { return Boolean(transport) || Boolean(key()); }

function hint(words, language) {
  const list = [...new Set((words || []).filter(Boolean))].slice(0, 80).join('، ');
  if (language === 'en') return list ? `Site supervisor recording rented machines. Machines: ${list}`.slice(0, 900) : '';
  return ['مشرف موقع بناء يسجّل دوام الآليات المستأجرة باللهجة السورية. اكتب الكلام بالعربية كما قيل تماماً، بدون ترجمة.',
    list ? `الآليات: ${list}` : ''].filter(Boolean).join(' ').slice(0, 900);
}

async function transcribe(buffer, { mime = 'audio/ogg', filename = 'voice.ogg', words = [], language = 'ar' } = {}) {
  if (!isConfigured()) throw new TranscribeError('NOT_CONFIGURED', 'OPENAI_API_KEY is not set.');
  const prompt = hint(words, language);
  if (transport) return { text: String((await transport(buffer, { mime, prompt, language })) || '').trim() };
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('model', model());
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { authorization: `Bearer ${key()}` }, body: form, signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new TranscribeError(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', e.message);
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const err = data && data.error;
    throw new TranscribeError(res.status === 429 ? 'BUSY' : 'API_ERROR', err ? `${err.type || err.code}: ${err.message}` : `HTTP ${res.status}`);
  }
  return { text: String((data && data.text) || '').trim() };
}

module.exports = { transcribe, isConfigured, MAX_SECONDS, TranscribeError, setTransport(fn) { transport = fn; } };
