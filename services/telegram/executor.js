// services/telegram/executor.js — runs the confirmed steps through the app's own routes, machine by machine, and
// reports what was saved and, for anything refused, the reason the app gave. Nothing here decides a rule.
const loopback = require('./loopback');

const ROUTE = {
  check_in: () => ['POST', '/api/equipment/attendance/check-in'],
  check_out: (id) => ['POST', `/api/equipment/attendance/${id}/check-out`],
  day_status: () => ['POST', '/api/equipment/attendance/day-status'],
  downtime: (id) => ['POST', `/api/equipment/attendance/${id}/downtime/start`],
  edit: (id) => ['PATCH', `/api/equipment/attendance/${id}`],
};

/** run(userId, steps) -> { done: [n], failed: [{ n, code, message }], late: boolean } */
async function run(userId, steps) {
  const newRow = new Map(); // n -> row created by a check-in in this run
  const failedN = new Set();
  const done = new Set();
  const failed = [];
  let late = false;
  for (const s of steps) {
    if (failedN.has(s.n)) continue; // one refused step stops the rest for that machine (never half a day)
    const id = s.useNewRow ? newRow.get(s.n) : s.rowId;
    if ((s.kind === 'check_out' || s.kind === 'downtime' || s.kind === 'edit') && !id) {
      failedN.add(s.n);
      failed.push({ n: s.n, code: 'NO_ROW', message: 'no session to add to' });
      continue;
    }
    const [method, path] = ROUTE[s.kind](id);
    const r = await loopback.call(userId, method, path, { body: s.body });
    if (!r.ok) {
      failedN.add(s.n);
      done.delete(s.n);
      failed.push({ n: s.n, code: r.code || String(r.status), message: r.message || '', details: r.details || null });
      continue;
    }
    if (s.kind === 'check_in' && r.data && r.data.eq_attendance_id) newRow.set(s.n, r.data.eq_attendance_id);
    if ((r.warnings || []).some((w) => w && w.code === 'LATE_ENTRY')) late = true;
    done.add(s.n);
  }
  return { done: [...done].filter((n) => !failedN.has(n)), failed, late };
}

module.exports = { run };
