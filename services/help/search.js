// services/help/search.js — keyword search over the help topics. No AI and no outside service.
// Forgiving: word forms (approving -> approve), a few synonyms (driver -> operator), prefixes and one typo.
// Every word must match somewhere; when no topic has all the words, the closest topics are returned instead.
const { plain } = require('./guide');

const STOP = new Set(('a an the to of for in on at as is are be been am was were how do does did doing i my me we our us you your '
  + 'can could would should will shall what where when why which whom it its this that these those and or but if then '
  + 'from by with into about please want wanted need needs needed get got some any there here so just also there\'s i\'m '
  + 'im dont don\'t isnt isn\'t cant can\'t not no yes way help tell show').split(/\s+/));

// generic verbs: they add to the score when they match, but a topic does not need them ("give price to diesel")
const SOFT = new Set('give put set enter make use type write see find have has let go new add'.split(' ').map((w) => w));

// irregular forms -> the form the stemmer would give the base word
const IRREGULAR = {
  paid: 'pay', sent: 'send', gave: 'give', given: 'give', came: 'come', went: 'go', done: 'do', made: 'make',
  chosen: 'choose', chose: 'choose', broke: 'break', broken: 'breakdown', ran: 'run', bought: 'buy', took: 'take',
  taken: 'take', wrote: 'write', written: 'write', forgot: 'forget', forgotten: 'forget', saw: 'see', seen: 'see',
  liters: 'litre', liter: 'litre', litres: 'litre', centre: 'center', cancelled: 'cancel', canceled: 'cancel', cancelling: 'cancel',
  canceling: 'cancel', signin: 'sign', login: 'sign', logon: 'sign', logged: 'sign', untill: 'until',
};

/** Light English stemmer: the same function runs on the topics and on the query, so both sides meet. */
function stem(word) {
  const w = String(word).toLowerCase();
  return rules(IRREGULAR[w] || w);
}

function rules(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ches|shes|xes|sses|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith('ment') && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith('ation') && w.length > 7) w = w.slice(0, -5);
  else if (w.endsWith('al') && w.length > 7) w = w.slice(0, -2);
  if (/([^aeiou])\1$/.test(w) && !/(ll|ss|ff|zz)$/.test(w) && w.length > 3) w = w.slice(0, -1); // running -> run
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1); // approve -> approv (meets approving / approved)
  if (w.endsWith('y') && w.length > 3) w = `${w.slice(0, -1)}i`; // supply -> suppli (meets supplies / supplied)
  return w;
}

function words(text) {
  return plain(text).toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9%]+/).filter(Boolean);
}

/** Query words people use -> words the guide uses. Values are base words (stemmed when used). */
const SYNONYMS = {
  driver: ['operator'], supplier: ['vendor'], owner: ['vendor'], company: ['vendor'], contractor: ['vendor'],
  salary: ['invoice', 'pay'], salaries: ['invoice', 'pay'], payroll: ['invoice', 'batch'], bill: ['invoice'], billing: ['invoice'],
  statement: ['invoice', 'statement'], cost: ['price'], rate: ['price', 'rate'], tariff: ['price'],
  diesel: ['fuel'], gasoil: ['fuel'], petrol: ['fuel'], gas: ['fuel'],
  delete: ['void', 'cancel', 'deactivate', 'remove'], remove: ['void', 'cancel', 'deactivate'], erase: ['void', 'cancel'],
  employee: ['user'], staff: ['user'], worker: ['user'], person: ['user'], account: ['user', 'account'],
  sign: ['sign', 'login'], password: ['password'], forget: ['forgot', 'reset'],
  breakdown: ['breakdown', 'broken'], idle: ['standby'], waiting: ['standby', 'waiting'], wait: ['standby', 'waiting'],
  equipment: ['machine'], truck: ['machine'], excavator: ['machine'], loader: ['machine'], crane: ['machine'], vehicle: ['machine'],
  dnr: ['delivery'], accept: ['approve'], confirm: ['approve', 'confirm'], ok: ['approve'], validate: ['approve'],
  send: ['submit', 'send'], move: ['transfer', 'move'], relocate: ['transfer'], scan: ['scan', 'upload'],
  timesheet: ['sheet', 'paper'], timesheets: ['sheet', 'paper'], signed: ['signed', 'sheet'],
  lock: ['finalize', 'lock'], close: ['close', 'finalize'], undo: ['undo', 'recall', 'reverse'],
  mistake: ['mistake', 'wrong', 'correct'], error: ['mistake', 'wrong'], wrong: ['wrong', 'mistake'], fix: ['fix', 'correct', 'edit'],
  modify: ['edit', 'change'], update: ['edit', 'change'], change: ['change', 'edit'],
  overtime: ['overtime', 'extra'], absent: ['absent', 'absence'], absence: ['absent', 'absence'],
  report: ['report', 'pdf'], print: ['print', 'pdf'], download: ['pdf', 'excel', 'export'], export: ['export', 'pdf', 'excel'],
  site: ['site'], project: ['site', 'project'], supervisor: ['supervisor'], foreman: ['supervisor'],
  refuel: ['refuel', 'refuelling'], lunch: ['lunch', 'break'], rest: ['break'],
  money: ['pay', 'amount'], amount: ['amount'], debt: ['owed', 'balance'], owe: ['owed', 'balance'], owed: ['owed', 'balance'],
  start: ['start', 'begin', 'first'], begin: ['start', 'begin'], arrive: ['arrived', 'check'], leave: ['leave', 'end'],
  finish: ['finish', 'end', 'done'], stop: ['stop', 'end', 'pause'], day: ['day'], today: ['today', 'day'],
};

const SYN = (() => {
  const m = new Map();
  for (const [k, vs] of Object.entries(SYNONYMS)) m.set(stem(k), [...new Set(vs.map(stem))]);
  return m;
})();

/** Damerau-free Levenshtein distance <= 1 (one letter added, removed or changed). */
function oneEdit(a, b) {
  if (a === b) return true;
  const la = a.length; const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0; let j = 0; let diff = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return diff + (la - i) + (lb - j) <= 1;
}

const FIELD_WEIGHT = { title: 6, keywords: 4, summary: 2, body: 1 };

/** Per topic: the stems of each field (computed once per guide version). */
function indexTopics(topics) {
  return topics.map((t) => {
    const bodyText = t.blocks.map((b) => b.text).join(' ');
    const fields = {
      title: new Set(words(t.title).map(stem)),
      keywords: new Set(words(t.keywords).map(stem)),
      summary: new Set(words(t.summary).map(stem)),
      body: new Set(words(bodyText).map(stem)),
    };
    const all = new Set([...fields.title, ...fields.keywords, ...fields.summary, ...fields.body]);
    return { topic: t, fields, all };
  });
}

/** The query as groups: each word with its synonyms; a group matches when any of its stems matches. */
function parseQuery(q) {
  const seen = new Set();
  const groups = [];
  for (const w of words(String(q || '').slice(0, 200))) {
    if (STOP.has(w)) continue;
    const s = stem(w);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    groups.push({ word: w, stem: s, alts: SYN.get(s) || [], soft: SOFT.has(w) });
    if (groups.length >= 12) break;
  }
  // only generic verbs ("add"): they are the question, so they must match
  if (groups.every((g) => g.soft)) for (const g of groups) g.soft = false;
  return groups;
}

/** How well one stem matches a set of stems: 1 exact, 0.6 prefix, 0.5 one typo, 0 none. */
function matchQuality(s, set) {
  if (set.has(s)) return 1;
  let best = 0;
  for (const t of set) {
    if (s.length >= 4 && t.length > s.length && t.startsWith(s)) best = Math.max(best, 0.6);
    else if (s.length >= 5 && t.length >= 4 && oneEdit(s, t)) best = Math.max(best, 0.5);
    if (best >= 0.6) break;
  }
  return best;
}

function scoreGroup(g, idx) {
  let best = 0;
  for (const [field, set] of Object.entries(idx.fields)) {
    const w = FIELD_WEIGHT[field];
    let q = matchQuality(g.stem, set);
    for (const a of g.alts) if (a !== g.stem && set.has(a)) q = Math.max(q, 0.7);
    if (q) best = Math.max(best, w * q);
  }
  return best;
}

/**
 * Search the topics. Returns { exact, results: [{ topic, score }] }: exact = every word matched in each result;
 * otherwise the results are the closest topics (most words matched first).
 */
function search(index, q, { screen = null, limit = 8 } = {}) {
  const groups = parseQuery(q);
  if (!groups.length) return { exact: true, results: [] };
  const hard = groups.filter((g) => !g.soft);
  const scored = [];
  for (const idx of index) {
    let score = 0; let matched = 0;
    for (const g of groups) {
      const s = scoreGroup(g, idx);
      if (s > 0) { score += s; if (!g.soft) matched++; }
    }
    if (!matched) continue;
    // every word in the title: a strong sign this is the topic
    if (hard.every((g) => matchQuality(g.stem, idx.fields.title) >= 0.6 || g.alts.some((a) => idx.fields.title.has(a)))) score += 4;
    if (screen && idx.topic.screens.includes(screen)) score += 0.5;
    scored.push({ topic: idx.topic, score, matched });
  }
  const full = scored.filter((r) => r.matched === hard.length);
  const pool = full.length ? full : scored;
  pool.sort((a, b) => (b.matched - a.matched) || (b.score - a.score));
  return {
    exact: full.length > 0,
    results: pool.slice(0, limit).map((r) => ({ topic: r.topic, score: Math.round(r.score * 10) / 10 })),
  };
}

module.exports = { stem, words, parseQuery, indexTopics, search, oneEdit };
