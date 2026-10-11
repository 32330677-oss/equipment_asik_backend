// Running statements (11 Oct 2026), read only:
//   GET /api/equipment/statements/vendor/:id/account(.pdf)   vendor statement of account (كشف حساب تراكمي)
//   GET /api/equipment/statements/machine/:id/history(.pdf)  machine billing history (كشف فوترة الآلية)
// Query: from (default: since the start), to (default: today, not in the future); vendor: estimate (default true).
'use strict';

const { pool } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const { businessToday } = require('../../utils/businessDate');
const L = require('../../services/equipment/eqLedger');

function period(query, extra = {}) {
  const today = businessToday();
  const q = validate(query, { from: v.date(), to: v.date(), ...extra });
  const to = q.to || today;
  const from = q.from || '2000-01-01';
  if (to > today) throw AppError.validation({ to: 'cannot be in the future' });
  if (from > to) throw AppError.validation({ from: 'must be on or before to' });
  return { ...q, from, to };
}

function sendPdf(res, { buffer, fileName }) {
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(buffer);
}

const vendorData = (req) => {
  const id = parseId(req.params.id);
  const q = period(req.query, { estimate: v.bool({ default: true }) });
  return L.vendorStatement(pool, id, { from: q.from, to: q.to, estimate: q.estimate });
};
const machineData = (req) => {
  const id = parseId(req.params.id);
  const q = period(req.query);
  return L.machineHistory(pool, id, { from: q.from, to: q.to });
};

exports.vendorAccount = async (req, res) => res.json({ status: 'success', data: await vendorData(req) });
exports.vendorAccountPdf = async (req, res) => sendPdf(res, await L.vendorStatementPdf(pool, await vendorData(req), req.user));
exports.machineHistory = async (req, res) => res.json({ status: 'success', data: await machineData(req) });
exports.machineHistoryPdf = async (req, res) => sendPdf(res, await L.machineHistoryPdf(pool, await machineData(req), req.user));
