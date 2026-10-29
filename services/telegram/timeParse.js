// services/telegram/timeParse.js — reads a short answer to "what are the check-in and check-out times?" in code:
//   "8 لـ 5", "من 8 ل 5", "8 الى 5", "8-5", "الدخول 8 والخروج 5", "8:30 لـ 17:00", "سبعة ونص لخمسة", "دخول 7"
// Returns { in, out } in 24h 'HH:MM' ('' when not said) or null when it is not a time answer (the AI reads it then).
const WORDS = {
  'واحد': 1, 'وحده': 1, 'وحدة': 1, 'اتنين': 2, 'تنين': 2, 'ثنتين': 2, 'تلاته': 3, 'تلاتة': 3, 'ثلاثه': 3, 'ثلاثة': 3, 'اربعه': 4, 'اربعة': 4, 'أربعة': 4,
  'خمسه': 5, 'خمسة': 5, 'سته': 6, 'ستة': 6, 'سبعه': 7, 'سبعة': 7, 'تمانيه': 8, 'تمانية': 8, 'تمنه': 8, 'تمانه': 8, 'ثمانية': 8, 'تسعه': 9, 'تسعة': 9,
  'عشره': 10, 'عشرة': 10, 'حداش': 11, 'احدعش': 11, 'اتناعش': 12, 'طنعش': 12,
};
const AR_DIGITS = (s) => String(s || '').replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));

/** One spoken / written time -> { h, m } or null. */
function one(raw) {
  let s = AR_DIGITS(raw).trim().replace(/[ً-ْ]/g, '');
  if (!s) return null;
  let h = null; let m = 0;
  const hm = /^(\d{1,2})\s*[:.٫]\s*(\d{2})/.exec(s);
  if (hm) { h = Number(hm[1]); m = Number(hm[2]); s = s.slice(hm[0].length); } else {
    const d = /^(\d{1,2})/.exec(s);
    if (d) { h = Number(d[1]); s = s.slice(d[0].length); } else {
      const w = Object.keys(WORDS).find((k) => s.startsWith(k));
      if (!w) return null;
      h = WORDS[w]; s = s.slice(w.length);
    }
    s = s.trim();
    if (/^و\s*?نص|^ونص|^و نصف/.test(s)) m = 30;
    else if (/^و\s*?ربع|^وربع/.test(s)) m = 15;
    else if (/^و\s*?(ثلث|تلت)/.test(s)) m = 20;
    else if (/^(الا|إلا)\s*ربع/.test(s)) { h -= 1; m = 45; }
    else { const plus = /^و\s*(\d{1,2})/.exec(s); if (plus && Number(plus[1]) < 60) m = Number(plus[1]); }
  }
  if (h === null || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

const pad = (n) => String(n).padStart(2, '0');

/** 24h for the shift: Day: a check-out at 1..11 is in the afternoon; Night: a check-in at 1..11 is in the evening. */
function to24(t, kind, shift, inH = null) {
  let h = t.h;
  if (shift === 'Night') {
    if (kind === 'in' && h >= 1 && h <= 11) h += 12;
  } else if (kind === 'out' && h >= 1 && h <= 11 && (inH === null || h <= inH || h < 12)) {
    if (inH === null || h + 12 > inH) h += 12;
  }
  return `${pad(h % 24)}:${pad(t.m)}`;
}

const FILLER = /(الدخول|دخول|دخلت|دخل|الخروج|خروج|طلعت|طلع|خلصت|ساعه|ساعة|الساعة|الساعه|من|لـ|الى|إلى|حتى|لعند|الصبح|المسا|المساء|الضهر|بعد|ونص|وربع|ونصف|الا|إلا|ربع|ثلث|تلت|in|out|to|am|pm)/gi;

/** Only times in it (an answer to "what times?"), no machine or other words? */
function onlyTimes(s) {
  let rest = s.replace(FILLER, ' ');
  for (const w of Object.keys(WORDS)) rest = rest.split(w).join(' ');
  rest = rest.replace(/[\d:.٫\-–،,\s]/g, '').replace(/(^|\s)[لو](\s|$)/g, '').replace(/[لو]/g, '');
  return rest.length <= 2;
}

function parseTimes(text, shift = 'Day') {
  const s = AR_DIGITS(text).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 80 || !onlyTimes(s)) return null;
  // "الدخول 8 والخروج 5" / "دخول 8 خروج 5" (either order)
  const inM = /(?:الدخول|دخول|دخلت|دخل|in)\s*:?\s*(?:الساعة\s*)?([^\s،,]+(?:\s*(?:ونص|وربع|و\s*\d{1,2}|الا ربع|:\d{2}))?)/i.exec(s);
  const outM = /(?:الخروج|خروج|طلعت|طلع|خلصت|out)\s*:?\s*(?:الساعة\s*)?([^\s،,]+(?:\s*(?:ونص|وربع|و\s*\d{1,2}|الا ربع|:\d{2}))?)/i.exec(s);
  if (inM || outM) {
    const a = inM ? one(inM[1]) : null;
    const b = outM ? one(outM[1]) : null;
    if (!a && !b) return null;
    const i = a ? to24(a, 'in', shift) : '';
    return { in: i, out: b ? to24(b, 'out', shift, a ? Number(i.slice(0, 2)) : null) : '' };
  }
  // "8 لـ 5", "من 8 ل 5", "8 الى 5", "8 - 5", "8 حتى 5"
  const range = /^(?:من\s*)?(.+?)\s*(?:لـ|ل|الى|إلى|لل|حتى|لعند|-|–|to)\s*(.+)$/i.exec(s);
  if (range) {
    const a = one(range[1]);
    const b = one(range[2]);
    if (!a || !b) return null;
    const i = to24(a, 'in', shift);
    return { in: i, out: to24(b, 'out', shift, Number(i.slice(0, 2))) };
  }
  return null;
}

module.exports = { parseTimes, one };
