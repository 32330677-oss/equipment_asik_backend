// services/telegram/matcher.js — finds WHICH machine the supervisor means, in code (not by the AI).
// The AI only extracts what he said about the machine (type words, number, vendor words, plate, code, driver);
// this file compares that with the machines of the board he is working on, the same way every time:
//   one machine fits   -> it is that machine
//   several fit        -> the bot asks which one (buttons)
//   none fits          -> the bot asks with the closest ones (buttons), never guesses
// Names in the app are often English while he says them in Arabic letters with the same sound ("الشهم" = Al-Shahem,
// "تيليهاندلر" = Telehandler): both are reduced to a consonant "skeleton" and compared.

// ------------------------------------------------------------------ skeletons
const AR = {
  'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'th', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh',
  'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': '', 'غ': 'gh', 'ف': 'f', 'ق': 'k', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'ه': 'h', 'و': '', 'ي': '', 'ى': '', 'ا': '', 'أ': '', 'إ': '', 'آ': '', 'ء': '', 'ؤ': '', 'ئ': '', 'ة': '', 'پ': 'b', 'چ': 'j', 'ڤ': 'f', 'گ': 'j',
};
// spelled Latin letters said in Arabic ("جي سي بي" = GCB)
const SPELLED = { 'جي': 'j', 'جيه': 'j', 'سي': 'k', 'بي': 'b', 'دي': 'd', 'تي': 't', 'اي': '', 'ايه': '', 'ام': 'm', 'ان': 'n', 'اكس': 'ks', 'اف': 'f', 'ار': 'r', 'كي': 'k', 'في': 'f' };

function stripArabic(s) {
  return String(s || '').replace(/[ً-ْٰـ]/g, '');
}

/** The consonant skeleton of ONE word, Arabic or Latin. */
function skeleton(word) {
  let w = stripArabic(word).toLowerCase().trim();
  if (!w) return '';
  if (/[؀-ۿ]/.test(w)) {
    if (SPELLED[w] !== undefined) return SPELLED[w];
    w = w.replace(/^(وال|بال|لل|فال|ال)(?=..)/, '');
    let out = '';
    for (const ch of w) out += AR[ch] !== undefined ? AR[ch] : (/[a-z0-9]/.test(ch) ? ch : '');
    return out.replace(/(.)\1+/g, '$1');
  }
  w = w.replace(/^(al|el)[-\s]?(?=...)/, '');
  w = w.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c/g, 'k').replace(/q/g, 'k').replace(/p/g, 'b').replace(/v/g, 'f')
    .replace(/g/g, 'j').replace(/x/g, 'ks').replace(/[^a-z0-9]/g, '');
  w = w.replace(/[aeiouyw]/g, '');
  return w.replace(/(.)\1+/g, '$1');
}

/** Words of a name, each as a skeleton (empty ones dropped). Spelled letters said one by one ("جي سي بي") are joined. */
function skeletons(text) {
  const words = String(text || '').split(/[\s\-_/.,،·()]+/).filter(Boolean);
  const out = [];
  let run = '';
  for (const w of words) {
    const isSpelled = SPELLED[stripArabic(w)] !== undefined;
    const sk = skeleton(w);
    if (isSpelled) { run += sk; continue; }
    if (run) { out.push(run); run = ''; }
    if (sk) out.push(sk);
  }
  if (run) out.push(run);
  return out;
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Do two word skeletons sound like the same word? */
function sameWord(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.startsWith(s)) return true;
  if (s.length >= 3 && lev(a, b) <= (l.length >= 6 ? 2 : 1)) return true;
  return false;
}

/** Share of the said words found in the name (0..1). */
function nameScore(said, name) {
  const a = skeletons(said).filter((x) => x.length >= 2);
  if (!a.length) return 0;
  const b = skeletons(name);
  const joined = b.join('');
  let hit = 0;
  for (const w of a) if (b.some((x) => sameWord(w, x)) || (w.length >= 4 && joined.includes(w))) hit += 1;
  return hit / a.length;
}

// ------------------------------------------------------------------ types
// Arabic words people use for a type -> one canonical word (compared with the type names of the app).
const TYPE_SYNONYMS = {
  excavator: ['حفاره', 'حفارة', 'بوكلين', 'excavator', 'digger'],
  backhoe: ['باكر', 'بكر', 'باكهو', 'backhoe'],
  'mini excavator': ['حفاره صغيره', 'حفارة صغيرة', 'ميني', 'mini'],
  loader: ['لودر', 'تركس', 'شيول', 'loader'],
  'skid steer': ['بوبكات', 'bobcat', 'skid'],
  telehandler: ['تيليهاندلر', 'تلي هاندلر', 'تليهاندلر', 'تلسكوبي', 'تلسكوبيه', 'رافعه تلسكوبيه', 'telehandler'],
  crane: ['كرين', 'رافعه', 'رافعة', 'crane'],
  truck: ['قلاب', 'شاحنه', 'شاحنة', 'تريلا', 'truck', 'tipper'],
  'pick-up': ['بيك اب', 'بيكاب', 'بيك أب', 'بكب', 'pickup', 'pick-up', 'pick up'],
  roller: ['مدحله', 'مدحلة', 'رصاصه', 'رصاصة', 'roller', 'compactor'],
  grader: ['جريدر', 'كريدر', 'grader'],
  bulldozer: ['بلدوزر', 'دوزر', 'bulldozer', 'dozer'],
  'water tanker': ['صهريج', 'صهريج مياه', 'سيترن', 'tanker'],
  generator: ['مولده', 'مولدة', 'generator'],
  compressor: ['كومبرسه', 'كمبرسه', 'compressor'],
};
const norm = (s) => stripArabic(s).replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase().replace(/\s+/g, ' ').trim();

function canonicalTypes(text) {
  const t = norm(text);
  const hits = new Map(); // canon -> the longest word of it found
  for (const [canon, words] of Object.entries(TYPE_SYNONYMS)) {
    for (const w of words) {
      const x = norm(w);
      if (t === x || ` ${t} `.includes(` ${x} `) || (x.length >= 5 && t.includes(x))) {
        if (!hits.has(canon) || x.length > hits.get(canon).length) hits.set(canon, x);
      }
    }
  }
  // "رافعة تلسكوبية" is a telehandler, not also a crane: a word inside a longer one found is dropped
  const out = new Set();
  for (const [canon, x] of hits) {
    if (![...hits].some(([c, y]) => c !== canon && y.length > x.length && y.includes(x))) out.add(canon);
  }
  return out;
}

/** How well what he said about the type fits this machine's type (0 = not at all; more = more specific). */
function typeScore(said, m) {
  if (!said) return 1;
  const names = [m.type_name, m.type_name_ar].filter(Boolean);
  const want = canonicalTypes(said);
  let best = 0;
  for (const n of names) {
    const have = canonicalTypes(n);
    const common = [...want].filter((c) => have.has(c)).length;
    if (common) best = Math.max(best, common + 1);
    if (nameScore(said, n) >= 0.6 || nameScore(n, said) >= 0.6) best = Math.max(best, 1.5);
  }
  return best;
}
const typeFits = (said, m) => typeScore(said, m) > 0;

// ------------------------------------------------------------------ resolve
/**
 * resolve(mention, machines, { aliases }) -> { keys, sure, reason }
 *   mention: { said, type, number, vendor, plate, code, driver }
 *   machines: [{ key, equipment_id, code, plate, type_name, type_name_ar, type_seq, vendor_name, operator, ... }]
 *   keys: machine keys that fit (sorted best first); sure = exactly one machine fits on clear evidence
 */
function resolve(mention, machines, { aliases = [] } = {}) {
  const said = String(mention.said || '').trim();
  const pool = machines.slice();
  if (!pool.length) return { keys: [], sure: false, reason: 'no_machines' };

  // 1. his own name for a machine (learned) or the code / plate he gave: exact evidence
  const saidNorm = norm(said).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const alias = aliases.find((a) => a.alias_text === saidNorm);
  if (alias) {
    const hit = pool.filter((m) => m.equipment_id === alias.equipment_id);
    if (hit.length) return { keys: hit.map((m) => m.key), sure: hit.length === 1, reason: 'alias' };
  }
  const code = String(mention.code || '').trim().toUpperCase();
  if (code) {
    const hit = pool.filter((m) => String(m.code || '').toUpperCase() === code);
    if (hit.length && hit.every((m) => typeFits(mention.type, m))) return { keys: hit.map((m) => m.key), sure: hit.length === 1, reason: 'code' };
  }
  const plate = String(mention.plate || '').replace(/\D/g, '');
  if (plate.length >= 3) {
    const hit = pool.filter((m) => String(m.plate || '').replace(/\D/g, '').endsWith(plate));
    if (hit.length) return { keys: hit.map((m) => m.key), sure: hit.length === 1, reason: 'plate' };
  }

  // 2. type, number, vendor, driver
  let c = pool;
  let weak = false;
  if (mention.type) {
    const scored = c.map((m) => ({ m, s: typeScore(mention.type, m) })).filter((x) => x.s > 0);
    if (scored.length) {
      const best = Math.max(...scored.map((x) => x.s));
      c = scored.filter((x) => x.s === best).map((x) => x.m); // "حفارة صغيرة" prefers the Mini Excavator
    } else weak = true;
  }
  const num = Number(mention.number);
  if (Number.isInteger(num) && num > 0) {
    const n = c.filter((m) => Number(m.type_seq) === num);
    if (n.length) c = n; else weak = true;
  }
  if (mention.vendor) {
    const scored = c.map((m) => ({ m, s: nameScore(mention.vendor, m.vendor_name) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
    if (scored.length) {
      const best = scored[0].s;
      c = scored.filter((x) => x.s >= best - 0.01).map((x) => x.m);
    } else weak = true;
  }
  if (mention.driver) {
    const d = c.filter((m) => m.operator && nameScore(mention.driver, m.operator) >= 0.5);
    if (d.length) c = d;
  }
  // nothing said at all that narrows it down
  if (!mention.type && !(num > 0) && !mention.vendor && !mention.driver) weak = true;
  if (c.length === pool.length && pool.length > 1) weak = true;
  return { keys: c.map((m) => m.key), sure: c.length === 1 && !weak, reason: weak ? 'weak' : 'match' };
}

/** The closest machines for a "which one?" question when nothing fits well (type first, then vendor). */
function closest(mention, machines, n = 4) {
  return machines
    .map((m) => ({ m, s: (typeFits(mention.type, m) ? 2 : 0) + (mention.vendor ? nameScore(mention.vendor, m.vendor_name) : 0) + (Number(mention.number) === Number(m.type_seq) ? 0.5 : 0) }))
    .sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.m.key);
}

/** Which board (site + shift) did he name? Returns the boards that fit. */
const SITE_WORDS = [[/تي\s*(تو|2|٢)|^t\s*2$/i, 't2'], [/مطار/, 'airport'], [/جسور|بريدج|بريدجز|الجسر/, 'bridges']];
function boardsFor(site, shift, boards) {
  let b = boards.slice();
  if (site) {
    let s = String(site).trim();
    for (const [re, word] of SITE_WORDS) if (re.test(s)) s = word;
    const hit = b.filter((x) => {
      const code = String(x.site_code || '').replace(/^s-?/i, '');
      return nameScore(s, `${x.site_code} ${code} ${x.site_name || ''}`) >= 0.5 || norm(x.site_code).includes(norm(s).replace(/^s-?/, '')) || norm(s).includes(norm(code));
    });
    if (hit.length) b = hit;
  }
  if (shift) b = b.filter((x) => x.shift === shift);
  return b;
}

module.exports = { resolve, closest, boardsFor, skeleton, nameScore, typeFits, canonicalTypes };
