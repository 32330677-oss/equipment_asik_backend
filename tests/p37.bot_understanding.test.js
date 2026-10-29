// P37 — how the bot understands words, without a database or an AI (29 Oct 2026): finding the machine from what was
// said (real names of the sites, English names said in Arabic letters), short time answers, dates in words.
const { test } = require('node:test');
const assert = require('node:assert');
const matcher = require('../services/telegram/matcher');
const { parseTimes } = require('../services/telegram/timeParse');
const { guessDate } = require('../services/telegram/bot');

const mk = (key, type, seq, vendor, ar = null) => ({ key, equipment_id: key, code: `EQ-${key}`, type_name: ar ? null : type, type_name_ar: ar, type_seq: seq, vendor_name: vendor });
// the machines of S-BRIDGES and S-T2 (28 Oct 2026)
const MS = [
  mk(1, 'Pick-up', 1, 'Mohammad Alsagheer'), mk(2, 'Bobcat', 1, 'Ahmad Monsi Al-Thani'), mk(3, 'Telehandler', 1, 'Abo Fahed Akeel'),
  mk(4, null, 1, 'Al-Deeb', 'تركس'), mk(5, 'Bobcat', 1, 'Al-Deeb'), mk(6, null, 1, 'Al-Deeb', 'مدحلة'), mk(7, null, 1, 'Al-Deeb', 'رافعة متحركة'),
  mk(8, null, 1, 'Al-Shahem', 'تركس'), mk(9, 'GCB', 1, 'Al-Shahem'), mk(10, 'Mini Excavator', 1, 'Al-Shahem'), mk(11, 'Bobcat', 1, 'Al-Hamshari'),
  mk(12, 'Bobcat', 2, 'Al-Hamshari'), mk(13, null, 1, 'Bilal Abed-Alnabi', 'صهريج مياه'), mk(14, null, 1, 'Fayez Moussa-Abo Omran', 'جريدر'),
  mk(15, 'Bobcat', 3, 'Al-Deeb'), mk(16, null, 1, 'Al-Shahem', 'حفارة'), mk(17, 'GCB', 2, 'Al-Shahem'),
];
const sure = (m) => { const r = matcher.resolve(m, MS); return r.sure ? r.keys[0] : null; };
const asks = (m) => { const r = matcher.resolve(m, MS); return r.sure ? null : r.keys.slice().sort((a, b) => a - b); };

test('a machine named by type + number + vendor (said in Arabic) is found, only that one', () => {
  assert.strictEqual(sure({ type: 'بوبكات', number: 1, vendor: 'أحمد منسي الثاني' }), 2);
  assert.strictEqual(sure({ type: 'بوبكات', number: 2, vendor: 'الحمشري' }), 12);
  assert.strictEqual(sure({ type: 'تركس', number: 1, vendor: 'الشهم' }), 8);
  assert.strictEqual(sure({ type: 'التركس', vendor: 'الديب' }), 4);
  assert.strictEqual(sure({ type: 'تيليهاندلر' }), 3);
  assert.strictEqual(sure({ type: 'جي سي بي', number: 2 }), 17);
  assert.strictEqual(sure({ type: 'حفارة صغيرة', vendor: 'الشهم' }), 10);
  assert.strictEqual(sure({ type: 'بيكاب' }), 1);
  assert.strictEqual(sure({ type: 'صهريج', vendor: 'بلال' }), 13);
  assert.strictEqual(sure({ type: 'جريدر', vendor: 'فايز موسى' }), 14);
  assert.strictEqual(sure({ vendor: 'أبو فهد' }), 3);
  assert.strictEqual(sure({ type: 'Bobcat', number: 3 }), 15);
  assert.strictEqual(sure({ type: 'رافعة' }), 7, 'the mobile crane; the telehandler is a «رافعة تلسكوبية»');
  assert.strictEqual(sure({ type: 'رافعة تلسكوبية' }), 3);
});

test('when the words fit several machines the bot asks (never guesses)', () => {
  assert.deepStrictEqual(asks({ type: 'بوبكات', number: 1 }), [2, 5, 11]);
  assert.deepStrictEqual(asks({ type: 'بوبكات', vendor: 'الديب' }), [5, 15]);
  assert.deepStrictEqual(asks({ type: 'حفارة', vendor: 'الشهم' }), [10, 16]);
});

test('a code from the AI is used only when it fits the type said', () => {
  assert.strictEqual(sure({ type: 'بوبكات', code: 'EQ-2' }), 2);
  assert.notStrictEqual(sure({ type: 'جريدر', code: 'EQ-2' }), 2, 'a code of a Bobcat for "grader" is refused');
});

test('sites said in words', () => {
  const B = [{ site_code: 'S-BRIDGES', site_name: 'Bridges', shift: 'Day' }, { site_code: 'S-T2', site_name: 'T2-Damascus International Airport', shift: 'Day' }, { site_code: 'S-T2', site_name: 'T2-Damascus International Airport', shift: 'Night' }];
  const codes = (s, sh = '') => matcher.boardsFor(s, sh, B).map((b) => `${b.site_code}/${b.shift}`);
  assert.deepStrictEqual(codes('bridges'), ['S-BRIDGES/Day']);
  assert.deepStrictEqual(codes('الجسور'), ['S-BRIDGES/Day']);
  assert.deepStrictEqual(codes('تي تو'), ['S-T2/Day', 'S-T2/Night']);
  assert.deepStrictEqual(codes('المطار', 'Night'), ['S-T2/Night']);
});

test('short time answers read by the code', () => {
  assert.deepStrictEqual(parseTimes('8 لـ 5'), { in: '08:00', out: '17:00' });
  assert.deepStrictEqual(parseTimes('ساعة الدخول 8، ساعة الخروج 5'), { in: '08:00', out: '17:00' });
  assert.deepStrictEqual(parseTimes('سبعة ونص لخمسة'), { in: '07:30', out: '17:00' });
  assert.deepStrictEqual(parseTimes('دخول 7'), { in: '07:00', out: '' });
  assert.deepStrictEqual(parseTimes('7 لـ 5', 'Night'), { in: '19:00', out: '05:00' });
  assert.strictEqual(parseTimes('الحفارة 2 دخلت 7'), null, 'a new message, not an answer');
  assert.strictEqual(parseTimes('اي تمام'), null);
});

test('dates said in words', () => {
  const T = '2026-10-29';
  assert.strictEqual(guessDate('بدي دخّل حضور لتاريخ 28 أكتوبر', T, '12:00'), '2026-10-28');
  assert.strictEqual(guessDate('28 تشرين الأول', T, '12:00'), '2026-10-28');
  assert.strictEqual(guessDate('سجل ليوم 28/10', T, '12:00'), '2026-10-28');
  assert.strictEqual(guessDate('مبارح', T, '12:00'), '2026-10-28');
  assert.strictEqual(guessDate('يوم 15', T, '12:00'), '2026-10-15');
  assert.strictEqual(guessDate('الحفارة 1 طلعت 5', T, '12:00'), null);
});
