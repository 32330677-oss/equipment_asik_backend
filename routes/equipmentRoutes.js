// routes/equipmentRoutes.js — everything under /api/equipment (document 03 §5).
// Specific paths are declared before parameterised ones.
const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { uploadLimiter } = require('../middleware/rateLimits');

const A = requireRole('Admin');
const AC = requireRole('Admin', 'Accountant');
const ACS = requireRole('Admin', 'Accountant', 'Supervisor');

const vendor = require('../controllers/equipment/vendorController');
const fleet = require('../controllers/equipment/fleetController');
const rate = require('../controllers/equipment/rateCardController');
const dep = require('../controllers/equipment/deploymentController');
const att = require('../controllers/equipment/eqAttendanceController');
const review = require('../controllers/equipment/eqReviewController');
const fuel = require('../controllers/equipment/eqFuelAdjustmentController');
const ts = require('../controllers/equipment/timesheetController');
const pay = require('../controllers/equipment/eqPayrollController');
const monthlyTerms = require('../controllers/equipment/monthlyTermsController');
const liveC = require('../controllers/equipment/eqLiveController');
const clientRep = require('../controllers/equipment/clientReportController');
const AS = requireRole('Admin', 'Supervisor');
const fd = require('../controllers/equipment/eqFuelDiffController');
const dnr = require('../controllers/equipment/dnrController');
const fin = require('../controllers/equipment/eqFinanceController');
const ledger = require('../controllers/equipment/ledgerController');

router.use(requireAuth);

// 5.1 vendors & contracts
router.get('/vendors', ACS, vendor.list);
router.post('/vendors', AC, vendor.create);
router.get('/vendors/:id', AC, vendor.get);
router.put('/vendors/:id', AC, vendor.update);
router.patch('/vendors/:id/status', AC, vendor.setStatus);
router.get('/vendors/:id/contracts', AC, vendor.listContracts);
router.post('/vendors/:id/contracts', A, vendor.createContract);
router.put('/contracts/:id', A, vendor.updateContract);
router.post('/contracts/:id/document', A, uploadLimiter, vendor.uploadDocument);
router.get('/contracts/:id/document', AC, vendor.downloadDocument);
router.get('/contracts/:id/documents', AC, vendor.listDocuments);

// 5.2 types, machines, operators
router.get('/types', ACS, fleet.listTypes);
router.post('/types', AC, fleet.createType);
router.put('/types/:id', AC, fleet.updateType);
router.get('/machines', AC, fleet.listMachines);
router.post('/machines', AC, fleet.createMachine);
router.get('/machines/:id', AC, fleet.getMachine);
router.put('/machines/:id', AC, fleet.updateMachine);
router.patch('/machines/:id/status', AC, fleet.setMachineStatus);
router.post('/machines/:id/photo', AC, uploadLimiter, fleet.uploadMachinePhoto);
router.get('/machines/:id/photo', ACS, fleet.downloadMachinePhoto);
router.get('/operators', ACS, fleet.listOperators);
router.post('/operators', A, fleet.createOperator);
router.put('/operators/:id', A, fleet.updateOperator);
router.patch('/operators/:id/status', A, fleet.setOperatorStatus);
router.post('/operators/:id/photo', A, uploadLimiter, fleet.uploadOperatorPhoto);
router.get('/operators/:id/photo', ACS, fleet.downloadOperatorPhoto);

// 5.3 rate cards
router.post('/rate-cards/preview', AC, rate.preview);
router.get('/machines/:id/rate-cards', AC, rate.list);
router.post('/machines/:id/rate-cards', AC, rate.create);
router.put('/rate-cards/:id', AC, rate.update);
router.post('/rate-cards/:id/revise', AC, rate.revise);
router.post('/rate-cards/:id/close', AC, rate.close);

// 5.3b DNR (Delivery Note Registry): per-unit prices of an existing vendor + delivery notes (Admin and Accountant)
router.get('/dnr-rates', AC, dnr.listRates);
router.post('/dnr-rates', AC, dnr.createRates);
router.put('/dnr-rates/:id', AC, dnr.updateRate);
router.patch('/dnr-rates/:id/close', AC, dnr.closeRate);
router.patch('/dnr-rates/:id/cancel', AC, dnr.cancelRate);
router.get('/machines/:id/dnr-rates', AC, dnr.listMachineRates);
router.get('/delivery-notes', AC, dnr.listNotes);
router.post('/delivery-notes', AC, dnr.createNote);
router.get('/delivery-notes/:id', AC, dnr.getNote);
router.patch('/delivery-notes/:id/cancel', AC, dnr.cancelNote);
router.patch('/delivery-notes/:id', AC, dnr.updateNote);

// 5.4 deployments
router.get('/deployments', AC, dep.list);
router.post('/deployments', AC, dep.create);
router.patch('/deployments/:id/end', AC, dep.end);
router.patch('/deployments/:id/start', AC, dep.changeStart);
router.post('/deployments/:id/transfer', AC, dep.transfer);
router.patch('/deployments/:id', AC, dep.update);

// 5.5 supervisor recording
router.get('/my-sites', AS, att.mySites);
router.get('/attendance/site/:siteId', AS, att.siteDay);
router.get('/attendance/rejected', AS, att.rejected);
router.get('/attendance/change-requests', AS, review.listChangeRequests);
router.patch('/attendance/change-requests/:id/withdraw', AS, review.withdrawChangeRequest);
router.post('/attendance/check-in', AS, att.checkIn);
router.post('/attendance/day-status', AS, att.dayStatus);
router.post('/attendance/submit', AS, att.submit);
router.post('/attendance/:id/downtime/start', AS, att.downtimeStart);
router.post('/attendance/:id/downtime/:downtimeId/end', AS, att.downtimeEnd);
router.patch('/attendance/:id/downtime/:downtimeId', AS, att.downtimeUpdate);
router.delete('/attendance/:id/downtime/:downtimeId', AS, att.downtimeDelete);
router.post('/attendance/:id/check-out', AS, att.checkOut);
router.post('/attendance/recall', AS, att.recallDay);
router.patch('/attendance/:id/resubmit', AS, att.resubmit);
router.patch('/attendance/:id/recall', AS, att.recall);
router.patch('/attendance/:id/cancel', AS, att.cancel);
router.post('/attendance/:id/change-requests', AS, review.createChangeRequest);
router.patch('/attendance/:id', AS, att.edit);
router.delete('/attendance/:id', AS, att.remove);

// 5.6 admin review & corrections
router.get('/admin/attendance', AC, review.list);
router.post('/admin/attendance/approve', A, review.approve);
router.post('/admin/attendance/reject', A, review.reject);
router.get('/admin/attendance/:id', AC, review.get);
router.post('/admin/attendance/:id/ack-anomaly', A, review.ackAnomaly);
router.patch('/admin/attendance/:id/standby-credit', AC, review.standbyCredit);
router.patch('/admin/attendance/:id/cancel', AC, review.voidRow);
// not financially committed: the office (Admin or Accountant) corrects the row directly, with a reason once Approved
router.patch('/admin/attendance/:id', AC, review.adminEdit);
router.get('/admin/change-requests', AC, review.listChangeRequests);
router.patch('/admin/change-requests/:id/approve', AC, review.approveChangeRequest);
router.patch('/admin/change-requests/:id/reject', AC, review.rejectChangeRequest);

// 5.7 fuel & adjustments
router.get('/fuel-issues', AC, fuel.listFuel);
router.post('/fuel-issues', ACS, fuel.createFuel);
router.patch('/fuel-issues/:id/cancel', AC, fuel.cancelFuel);
router.post('/fuel-issues/:id/receipt', ACS, uploadLimiter, fuel.uploadReceipt);
router.get('/fuel-issues/:id/receipt', AC, fuel.downloadReceipt);
router.get('/fuel-issues/:id/receipts', AC, fuel.listReceipts);
router.patch('/fuel-issues/:id', AC, fuel.updateFuel);
router.get('/adjustments', AC, fuel.listAdjustments);
router.post('/adjustments', AC, fuel.createAdjustment);
router.patch('/adjustments/:id/cancel', AC, fuel.cancelAdjustment);

// 5.7b fuel price difference (national price list + machine terms)
router.get('/fuel-prices', AC, fd.listPrices);
router.post('/fuel-prices', AC, fd.createPrice);
router.delete('/fuel-prices/:id', AC, fd.deletePrice);
router.get('/machines/:id/fuel-terms', AC, fd.listTerms);
router.post('/machines/:id/fuel-terms', AC, fd.createTerms);
router.patch('/fuel-terms/:id/end', AC, fd.endTerms);
router.patch('/fuel-terms/:id/start', AC, fd.changeTermsStart);

// 5.8 paper timesheets
router.get('/timesheets', ACS, ts.list);
router.post('/timesheets', ACS, ts.getOrCreate);
router.get('/timesheets/resolve', ACS, ts.resolve);
router.get('/timesheets/:id', ACS, ts.get);
router.get('/timesheets/:id/print.pdf', ACS, ts.print);
router.post('/timesheets/:id/scans', AC, uploadLimiter, ts.uploadScan); // the accountant uploads the signed sheet (not the supervisor)
router.get('/timesheets/:id/scans', ACS, ts.listScans);
router.get('/timesheets/:id/scans/:scanId/file', ACS, ts.scanFile);
router.post('/timesheets/:id/paper-checks', AC, ts.paperChecks);
router.patch('/timesheets/:id/close', AC, ts.close);
router.patch('/timesheets/:id/reopen', A, ts.reopen);

// 5.9 invoices (13-14 Oct 2026): draft -> issued (same numbers while in the office) -> handed over -> withdrawn -> re-issued
router.post('/payroll/preview', AC, pay.preview);
router.get('/payroll/blockers', AC, pay.blockers);
router.get('/payroll/coverage', AC, pay.coverage); // per machine of a vendor: ready / invoices already covering the period / blockers
router.get('/payroll/monthly-terms', AC, monthlyTerms.list); // terms of the month of monthly machines
router.put('/payroll/monthly-terms', AC, monthlyTerms.put);
router.post('/payroll/generate', AC, pay.generate);
router.get('/payroll/register', AC, pay.register); // invoices per vendor with their machine invoices and notes
router.get('/payroll/batches', AC, pay.list);
router.get('/payroll/batches/:id', AC, pay.get);
router.get('/payroll/batches/:id/rows', AC, pay.rows);
router.get('/payroll/batches/:id/versions', AC, pay.versions);
router.get('/payroll/batches/:id/export.pdf', AC, pay.exportPdf);
router.get('/payroll/batches/:id/export.xlsx', AC, pay.exportXlsx);
router.get('/payroll/batches/:id/certificate.xlsx', AC, pay.certificateXlsx); // vendor invoice + payment certificate per machine (Excel)
router.patch('/payroll/batches/:id/finalize', AC, pay.finalize); // issue: official numbers
router.post('/payroll/batches/:id/refresh', AC, pay.refresh); // issued: brought up to date, same numbers
router.post('/payroll/batches/:id/reissue', A, pay.reissue); // withdrawn from finance: new numbers
router.get('/payroll/batches/:id/review-summary', AC, pay.reviewSummary);
router.patch('/payroll/batches/:id/void', AC, pay.void); // draft: delete; issued / withdrawn: Admin cancels
router.post('/payroll/batches/:id/supersede', AC, pay.supersede); // draft: recalculate
router.patch('/payroll/batches/:id/offsets', AC, pay.setOffsets); // Admin: extra hours cover missing hours (monthly, 12 Oct 2026)
router.post('/payroll/batches/:id/withdraw', A, fin.withdrawBatch); // back from finance (signed acknowledgement)
router.get('/payroll/handovers', AC, fin.listHandovers);
router.post('/payroll/handovers', A, fin.handOver);
router.get('/payroll/handovers/:id', AC, fin.getHandover);
router.get('/payroll/handovers/:id/pdf', AC, fin.handoverPdf);
router.get('/payroll/withdrawals/:id/pdf', AC, fin.withdrawalPdf);
router.get('/payroll/notes', AC, fin.listNotes); // debit / credit notes
router.post('/payroll/notes', AC, fin.createNote);
router.get('/payroll/notes/:id', AC, fin.getNote);
router.put('/payroll/notes/:id', AC, fin.updateNote);
router.patch('/payroll/notes/:id/issue', A, fin.issueNote);
router.patch('/payroll/notes/:id/cancel', AC, fin.cancelNote);
router.post('/payroll/notes/:id/withdraw', A, fin.withdrawNote);
router.get('/payroll/notes/:id/pdf', AC, fin.notePdf);
// running statements (11 Oct 2026): vendor statement of account, machine billing history
router.get('/statements/vendor/:id/account', AC, ledger.vendorAccount);
router.get('/statements/vendor/:id/account.pdf', AC, ledger.vendorAccountPdf);
router.get('/statements/machine/:id/history', AC, ledger.machineHistory);
router.get('/statements/machine/:id/history.pdf', AC, ledger.machineHistoryPdf);
router.get('/statements/machine/:id.pdf', AC, pay.provisionalMachine);
router.get('/statements/vendor/:id.pdf', AC, pay.provisionalVendor);

// 5.10 live board & reports
router.get('/live', ACS, liveC.live);
router.get('/live/sites/:siteId', ACS, liveC.liveSite);
router.get('/reports/daily.pdf', ACS, liveC.dailyPdf);
router.get('/reports/client-daily.pdf', ACS, clientRep.clientDailyPdf);
router.get('/reports/utilization', AC, liveC.utilization);

module.exports = router;
