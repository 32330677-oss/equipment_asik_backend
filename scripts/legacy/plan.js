// scripts/legacy/plan.js — PURE planner of the legacy import (no database, no network).
// Input: legacy_data.json (day records from the accountant's Excel), legacy_mapping.json (decisions) and the live state
// read from the database. Output: the full plan + the list of problems. Used by --dry-run, --run and --verify.
'use strict';

const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100; // money with 2 decimals, half up
const cents = (x) => Math.round((Number(x) + Number.EPSILON) * 100);

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const monthOf = (d) => String(d).slice(0, 7);
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const hhmm = (t) => String(t || '').slice(0, 5);
function addMinutesWall(dateTime, minutes) {
  // 'YYYY-MM-DD HH:mm' + minutes, wall clock (no time zone)
  const d = new Date(`${dateTime.replace(' ', 'T')}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
const wallMs = (v) => Date.parse(`${String(v).slice(0, 16).replace(' ', 'T')}:00Z`);
const day = (v) => (v ? String(v).slice(0, 10) : null);

/**
 * live = { sites, types, vendors, contracts, machines, rateCards, deployments, attendance, settings }
 * (attendance: rows of the import window +/- 1 day only, for the overlap checks)
 */
function buildPlan(data, mapping, live) {
  const problems = [];
  const warn = [];
  const P = (msg) => problems.push(msg);
  const goLive = data.window.go_live;
  const lastLegacy = addDays(goLive, -1);

  // ---------------------------------------------------------------- sites
  const sites = {};
  for (const [key, code] of Object.entries(mapping.sites)) {
    const s = live.sites.find((x) => x.site_code === code);
    if (!s) { P(`Site ${code} (${key}) not found in the database.`); continue; }
    if (s.status !== 'Active') P(`Site ${code} is not Active.`);
    sites[key] = {
      site_id: s.site_id, site_code: s.site_code, has_night: Number(s.has_night_shift) === 1,
      start: { Day: hhmm(s.day_shift_start) || mapping.shift_start.Day, Night: hhmm(s.night_shift_start) || mapping.shift_start.Night },
    };
  }

  // ---------------------------------------------------------------- types
  const typeByName = new Map(live.types.map((t) => [t.type_name.toLowerCase(), t]));
  const types = {};
  for (const [excel, name] of Object.entries(mapping.types)) {
    const t = typeByName.get(name.toLowerCase());
    types[excel] = { name, type_id: t ? t.type_id : null, create: !t };
    if (!t && !mapping.new_types.includes(name)) P(`Type "${name}" does not exist and is not in new_types.`);
  }

  // ---------------------------------------------------------------- day records
  const days = data.days.map((d) => ({ ...d, machineKey: `${d.vendor}|${d.machine}` }));
  for (const d of days) {
    if (d.date > lastLegacy || d.date < data.window.from) P(`${d.src}: date ${d.date} outside the import window.`);
    if (!mapping.vendors[d.vendor]) P(`${d.src}: vendor "${d.vendor}" is not in the mapping.`);
    if (!mapping.types[d.type]) P(`${d.src}: machine type "${d.type}" is not in the mapping.`);
    if (!sites[d.site]) P(`${d.src}: site ${d.site} unknown.`);
    else if (d.shift === 'Night' && !sites[d.site].has_night) P(`${d.src}: ${d.site} has no night shift.`);
  }

  // ---------------------------------------------------------------- vendors + contracts
  const vendors = {};
  for (const vKey of [...new Set(days.map((d) => d.vendor))].sort()) {
    const m = mapping.vendors[vKey]; if (!m) continue;
    const vDays = days.filter((d) => d.vendor === vKey).map((d) => d.date).sort();
    const first = vDays[0]; const last = vDays[vDays.length - 1];
    const v = { key: vKey, currency: m.currency, first_day: first, last_day: last, live: Boolean(m.live_name) };
    if (m.live_name) {
      const lv = live.vendors.find((x) => x.vendor_name === m.live_name);
      if (!lv) { P(`Live vendor "${m.live_name}" (${vKey}) not found.`); continue; }
      v.vendor_id = lv.vendor_id; v.name = lv.vendor_name; v.status = lv.status;
      if (lv.status !== 'Active') P(`Live vendor "${lv.vendor_name}" is ${lv.status}.`);
      const cs = live.contracts.filter((c) => c.vendor_id === lv.vendor_id && c.status === 'Active');
      if (cs.length !== 1) { P(`Vendor "${lv.vendor_name}" has ${cs.length} Active contracts (1 expected).`); continue; }
      const c = cs[0];
      if (c.currency !== m.currency) P(`Vendor "${lv.vendor_name}": contract currency ${c.currency}, mapping says ${m.currency}.`);
      if (c.end_date && day(c.end_date) < lastLegacy) P(`Vendor "${lv.vendor_name}": contract ends ${day(c.end_date)}.`);
      v.contract = { vendor_contract_id: c.vendor_contract_id, contract_number: c.contract_number, start_date: day(c.start_date),
        action: day(c.start_date) > first ? 'move_start' : 'keep', new_start: first };
    } else {
      // a vendor created by an earlier (interrupted) run is found by its name
      const ex = live.vendors.find((x) => x.vendor_name === m.new_name);
      v.name = m.new_name; v.vendor_id = ex ? ex.vendor_id : null; v.status = ex ? ex.status : null;
      if (live.vendors.some((x) => x.vendor_name.toLowerCase() === m.new_name.toLowerCase() && x.vendor_name !== m.new_name)) {
        P(`A vendor named like "${m.new_name}" already exists with another spelling: check before running.`);
      }
      const c = ex ? live.contracts.find((x) => x.vendor_id === ex.vendor_id && x.contract_number === `LEGACY-${vKey}`.slice(0, 100)) : null;
      v.contract = { vendor_contract_id: c ? c.vendor_contract_id : null, contract_number: `LEGACY-${vKey}`.slice(0, 100),
        action: c ? (day(c.start_date) > first ? 'move_start' : 'keep') : 'create', new_start: first, start_date: c ? day(c.start_date) : null };
      if (c && c.currency !== m.currency) P(`Vendor "${m.new_name}": contract currency ${c.currency}, mapping says ${m.currency}.`);
    }
    vendors[vKey] = v;
  }

  // ---------------------------------------------------------------- machines (number = system type_seq)
  const machines = {};
  const keys = [...new Set(days.map((d) => d.machineKey))];
  const sortKey = (k) => { const d = days.find((x) => x.machineKey === k); return `${d.vendor}|${d.type}|${String(d.number).padStart(3, '0')}`; };
  keys.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  for (const k of keys) {
    const ds = days.filter((d) => d.machineKey === k);
    const d0 = ds[0]; const v = vendors[d0.vendor]; const t = types[d0.type];
    if (!v || !t) continue;
    const dates = ds.map((d) => d.date).sort();
    const m = { key: k, vendor: d0.vendor, excel_name: d0.machine, type: t.name, number: d0.number, label: `${t.name} #${d0.number}`,
      first_day: dates[0], last_day: dates[dates.length - 1], equipment_id: null, live: false };
    const lm = v.vendor_id && t.type_id ? live.machines.find((x) => x.vendor_id === v.vendor_id && x.type_id === t.type_id && Number(x.type_seq) === d0.number) : null;
    if (lm) {
      m.equipment_id = lm.equipment_id; m.equipment_code = lm.equipment_code; m.status = lm.status;
      m.live = !String(lm.notes || '').startsWith('Legacy import');
      if (lm.status !== 'Active' && m.live) P(`${k}: live machine ${lm.equipment_code} is ${lm.status}.`);
    }
    machines[k] = m;
  }
  // creation order must give the same numbers: per vendor + type, every number below n must exist (live or created first)
  const groups = {};
  for (const m of Object.values(machines)) (groups[`${m.vendor}|${m.type}`] = groups[`${m.vendor}|${m.type}`] || []).push(m);
  for (const [g, list] of Object.entries(groups)) {
    const v = vendors[list[0].vendor]; const t = Object.values(types).find((x) => x.name === list[0].type);
    const existing = v.vendor_id && t.type_id ? live.machines.filter((x) => x.vendor_id === v.vendor_id && x.type_id === t.type_id) : [];
    const maxSeq = existing.reduce((a, x) => Math.max(a, Number(x.type_seq || 0)), 0);
    let next = maxSeq + 1;
    for (const m of list.sort((a, b) => a.number - b.number)) {
      if (m.equipment_id) continue;
      if (m.number !== next) P(`${m.key}: would be created as "${m.type} #${next}" but the Excel number is ${m.number} (${g} has ${existing.length} machine(s) already).`);
      m.expected_seq = next; next += 1;
    }
  }

  // ---------------------------------------------------------------- rate cards (one card per exact rate run)
  const cards = [];
  const daily = mapping.daily_machines || {};
  for (const m of Object.values(machines)) {
    const ds = days.filter((d) => d.machineKey === m.key);
    const byDate = new Map();
    for (const d of ds) {
      const was = byDate.get(d.date);
      if (was !== undefined && Math.abs(was - d.rate) > 1e-9) P(`${m.key} ${d.date}: two different rates the same day (${was} / ${d.rate}).`);
      byDate.set(d.date, d.rate);
    }
    const dates = [...byDate.keys()].sort();
    const runs = [];
    for (const dt of dates) {
      const rate = byDate.get(dt);
      const last = runs[runs.length - 1];
      if (last && Math.abs(last.rate - rate) < 1e-9) last.days.push(dt); else runs.push({ rate, days: [dt] });
    }
    const vend = vendors[m.vendor];
    const endOfLast = m.live ? lastLegacy : m.last_day;
    runs.forEach((run, i) => {
      const from = run.days[0];
      const to = i < runs.length - 1 ? addDays(runs[i + 1].days[0], -1) : endOfLast;
      const dm = daily[m.key];
      const card = { machineKey: m.key, idx: i, from, to, rate_exact: run.rate, currency: vend.currency };
      if (dm) Object.assign(card, { billing_mode: 'Daily', daily_rate: r2(run.rate), daily_partial_rule: dm.daily_partial_rule, standard_hours_per_day: dm.hours_per_day });
      else Object.assign(card, { billing_mode: 'Hourly', hourly_rate: r2(run.rate) });
      const sys = card.billing_mode === 'Daily' ? card.daily_rate : card.hourly_rate;
      if (!(sys > 0)) P(`${m.key} card from ${from}: rate ${run.rate} rounds to 0.`);
      card.rounded = Math.abs(sys - run.rate) > 1e-9;
      cards.push(card);
    });
    // live cards of the machine must not overlap the legacy ones
    if (m.equipment_id) {
      for (const lc of live.rateCards.filter((x) => x.equipment_id === m.equipment_id)) {
        const lf = day(lc.effective_from); const lt = lc.effective_to ? day(lc.effective_to) : '9999-12-31';
        const mine = cards.filter((c) => c.machineKey === m.key);
        const same = mine.find((c) => c.from === lf);
        if (same && String(lc.notes || '').startsWith('Legacy import')) { same.existing_id = lc.rate_card_id; continue; }
        for (const c of mine) if (lf <= c.to && lt >= c.from) P(`${m.key}: live rate card #${lc.rate_card_id} (${lf} to ${lt}) overlaps the legacy card ${c.from} to ${c.to}.`);
      }
    }
  }

  // ---------------------------------------------------------------- deployments (runs of the same site, per shift)
  const deployments = [];
  for (const m of Object.values(machines)) {
    for (const shift of ['Day', 'Night']) {
      const ds = days.filter((d) => d.machineKey === m.key && d.shift === shift).sort((a, b) => a.date.localeCompare(b.date));
      const runs = [];
      for (const d of ds) {
        const last = runs[runs.length - 1];
        if (last && last.site === d.site) last.to = d.date; else runs.push({ machineKey: m.key, site: d.site, shift, from: d.date, to: d.date });
      }
      for (const r of runs) {
        if (m.equipment_id) {
          const lds = live.deployments.filter((x) => x.equipment_id === m.equipment_id && x.shift_type === shift && (!x.unassigned_date || day(x.unassigned_date) >= day(x.assigned_date)));
          const same = lds.find((x) => sites[r.site] && x.site_id === sites[r.site].site_id && day(x.assigned_date) === r.from && day(x.unassigned_date) === r.to);
          if (same) { r.existing_id = same.eq_assignment_id; deployments.push(r); continue; }
          for (const x of lds) {
            const f = day(x.assigned_date); const t = x.unassigned_date ? day(x.unassigned_date) : '9999-12-31';
            if (f <= r.to && t >= r.from) P(`${m.key} ${shift}: live deployment #${x.eq_assignment_id} (${f} to ${t}) overlaps the legacy deployment ${r.from} to ${r.to}.`);
          }
        }
        deployments.push(r);
      }
    }
  }

  // ---------------------------------------------------------------- attendance rows
  const longH = Number((live.settings || {}).eq_long_session_review_hours || 16);
  const attendance = [];
  for (const d of days) {
    const s = sites[d.site]; if (!s) continue;
    const dm = daily[d.machineKey];
    const minutes = dm ? Math.round(dm.hours_per_day * 60) : Math.round(d.hours * 60);
    if (minutes <= 0) { P(`${d.src} ${d.date}: ${d.hours} h gives 0 minutes.`); continue; }
    if (minutes > 24 * 60) P(`${d.src} ${d.date}: ${d.hours} h is more than 24 h.`);
    const checkIn = `${d.date} ${s.start[d.shift]}`;
    const checkOut = addMinutesWall(checkIn, minutes);
    attendance.push({ date: d.date, machineKey: d.machineKey, vendor: d.vendor, site: d.site, shift: d.shift, check_in: checkIn, check_out: checkOut,
      minutes, hours: d.hours, rate_exact: d.rate, src: d.src, long_session: minutes > longH * 60 });
  }
  // time overlaps per machine (legacy rows + live rows of the window edges)
  const byMachine = new Map();
  for (const a of attendance) (byMachine.get(a.machineKey) || byMachine.set(a.machineKey, []).get(a.machineKey)).push({ from: a.check_in, to: a.check_out, what: `${a.date} ${a.shift} ${a.site}` });
  for (const m of Object.values(machines)) {
    if (!m.equipment_id) continue;
    const list = byMachine.get(m.key) || [];
    for (const r of live.attendance.filter((x) => x.equipment_id === m.equipment_id && x.check_in_time && x.status !== 'Cancelled')) {
      const legacy = list.find((x) => x.from === String(r.check_in_time).slice(0, 16));
      if (legacy) continue; // a row of an earlier run: checked in the run itself
      list.push({ from: String(r.check_in_time).slice(0, 16), to: String(r.check_out_time || '9999-12-31 23:59').slice(0, 16), what: `live row #${r.eq_attendance_id}` });
    }
  }
  for (const [k, list] of byMachine) {
    list.sort((a, b) => wallMs(a.from) - wallMs(b.from));
    for (let i = 1; i < list.length; i += 1) {
      if (wallMs(list[i].from) < wallMs(list[i - 1].to)) P(`${k}: times overlap: ${list[i - 1].what} (${list[i - 1].from}-${list[i - 1].to}) and ${list[i].what} (${list[i].from}).`);
    }
  }
  // every row inside a deployment and a card
  for (const a of attendance) {
    if (!deployments.some((r) => r.machineKey === a.machineKey && r.site === a.site && r.shift === a.shift && r.from <= a.date && r.to >= a.date)) P(`${a.src} ${a.date}: no deployment covers it.`);
    if (!cards.some((c) => c.machineKey === a.machineKey && c.from <= a.date && c.to >= a.date)) P(`${a.src} ${a.date}: no rate card covers it.`);
  }

  // ---------------------------------------------------------------- targets (what the accountant billed) per invoice item
  // invoice = vendor x month; item = machine x site x rate card (the backend groups like this for Hourly / Daily cards)
  const targets = new Map();
  for (const a of attendance) {
    const c = cards.find((x) => x.machineKey === a.machineKey && x.from <= a.date && x.to >= a.date);
    if (!c) continue;
    const key = `${monthOf(a.date)}|${a.machineKey}|${a.site}|${c.idx}`;
    const t = targets.get(key) || { key, month: monthOf(a.date), vendor: a.vendor, machineKey: a.machineKey, site: a.site, cardIdx: c.idx, card: c,
      amount_exact: 0, hours: 0, minutes: 0, days: 0, last_date: a.date, rows: [] };
    const dm = daily[a.machineKey];
    t.amount_exact += dm ? a.rate_exact : a.hours * a.rate_exact; // daily: one day per record
    t.hours += a.hours; t.minutes += a.minutes; t.days += 1;
    if (a.date > t.last_date) t.last_date = a.date;
    t.rows.push(a);
    targets.set(key, t);
  }
  for (const t of targets.values()) t.target_cents = cents(t.amount_exact);

  // ---------------------------------------------------------------- invoices (vendor x month)
  const invoices = [];
  for (const v of Object.values(vendors)) {
    const months = [...new Set(attendance.filter((a) => a.vendor === v.key).map((a) => monthOf(a.date)))].sort();
    for (const mo of months) invoices.push({ vendor: v.key, month: mo, start_date: `${mo}-01`, end_date: monthEnd(mo) });
  }
  // invoices already covering the window (a vendor x month with an active batch is skipped / checked by the run)
  for (const inv of invoices) {
    const v = vendors[inv.vendor];
    const b = v.vendor_id ? (live.batches || []).find((x) => x.scope_vendor_id === v.vendor_id && day(x.start_date) === inv.start_date && day(x.end_date) === inv.end_date && ['Generated', 'HandedOver', 'Returned'].includes(x.status)) : null;
    if (b) inv.existing = { eq_batch_id: b.eq_batch_id, is_finalized: Number(b.is_finalized) === 1, status: b.status };
    const other = v.vendor_id ? (live.coverage || []).filter((x) => x.vendor_id === v.vendor_id && day(x.start_date) <= inv.end_date && day(x.end_date) >= inv.start_date
      && (!b || x.eq_batch_id !== b.eq_batch_id)) : [];
    if (other.length) P(`${inv.vendor} ${inv.month}: another active invoice (#${other[0].eq_batch_id}) already covers part of the month.`);
  }

  // ---------------------------------------------------------------- deactivation at the end (decision 21 Oct 2026)
  const deactivate = {
    machines: Object.values(machines).filter((m) => !m.live).map((m) => m.key),
    vendors: Object.values(vendors).filter((v) => !v.live).map((v) => v.key),
  };

  // rounding warnings (shown, not blocking)
  for (const c of cards.filter((x) => x.rounded)) warn.push(`${c.machineKey} from ${c.from}: accountant rate ${c.rate_exact} -> system ${c.billing_mode === 'Daily' ? c.daily_rate : c.hourly_rate} (difference settled by an adjustment line).`);

  return {
    window: data.window, sites, types, vendors, machines, cards, deployments, attendance,
    targets: [...targets.values()], invoices, deactivate, problems, warnings: warn,
    counts: {
      vendors: Object.keys(vendors).length, vendors_new: Object.values(vendors).filter((v) => !v.live).length,
      machines: Object.keys(machines).length, machines_live: Object.values(machines).filter((m) => m.live).length,
      types_new: Object.values(types).filter((t) => t.create).length, cards: cards.length, deployments: deployments.length,
      attendance: attendance.length, long_sessions: attendance.filter((a) => a.long_session).length, invoices: invoices.length,
    },
  };
}

/**
 * What the system will bill for one target item, with the backend's own billing engine (dry run prediction).
 * engine = require('services/equipment/equipmentBillingEngine').
 */
function predictItem(engine, t) {
  const c = t.card;
  const rate = {
    billing_mode: c.billing_mode, hourly_rate: c.hourly_rate ?? null, daily_rate: c.daily_rate ?? null, monthly_rate: null,
    standard_hours_per_day: c.standard_hours_per_day || 8, min_billable_hours_per_day: null, overtime_enabled: false,
    overtime_threshold_hours: null, overtime_rate: null, overtime_multiplier: 1, standby_billable_pct: 50, breakdown_billable_pct: 0,
    break_policy: 'Deduct', daily_partial_rule: c.daily_partial_rule || 'ProRata', half_day_threshold_hours: null,
    monthly_working_days: 26, monthly_divisor: 'MonthDays', operator_included: true, operator_daily_rate: null, second_shift_pct: 0, fuel_policy: 'VendorSupplies',
  };
  const rows = t.rows.map((a, i) => ({ eq_attendance_id: i + 1, record_date: a.date, shift_type: a.shift, check_in_time: a.check_in, check_out_time: a.check_out,
    day_status: 'Working', gross_minutes: a.minutes, break_minutes: 0, breakdown_minutes: 0, standby_minutes: 0, standby_credit_minutes: null }));
  const res = engine.billItem(rows, rate, {}, {});
  return res.net_cents;
}

module.exports = { buildPlan, predictItem, addDays, monthEnd, r2, cents };
