# Known failing tests (marked `todo`)

When CI was added (28 Oct 2026) these 16 tests already failed on `main`. No application code was changed to add CI.
They are marked `KNOWN_FAILING` (a node:test `todo`): they still run and print their error, but do not fail the build,
so CI can protect new work. Each one must be looked at and fixed in its own PR, then the `KNOWN_FAILING` mark removed.
If a fix needs a change to invoice / payroll logic (not only to the test), it is agreed with the owner first.

| File | Test (line) | Error in CI | First look |
| --- | --- | --- | --- |
| p10.lock_policy | 35 issued, still in the office... | `NOTHING_TO_PAY`, expected `PERIOD_OVERLAP` | generate finds nothing in the period: test data / dates vs current rules |
| p10.lock_policy | 66 handed over: deployments... refused | `ATTENDANCE_AFTER_END`, expected `INVOICE_LOCKED` | follows from line 35 (no handed-over invoice) |
| p10.lock_policy | 96 a debit note settles a difference... | `ref_batch_id must be an issued invoice of this vendor` | follows from line 35 |
| p10.lock_policy | 137 the Admin edits an Approved row... | `undefined`, expected `INVOICE_LOCKED` | follows from line 35 |
| p18.vendor_type | 30 payment voucher of an individual... | `statements.voucherPdf is not a function` | the voucher PDF no longer exists in the code (no route uses it): the test is stale |
| p23.free_edits | 58 Recalculate (new version) of a draft... | `undefined !== []` | a field of the answer changed name or was removed |
| p26.billing_units | 104 handed over to finance: the whole period... | `NOTHING_TO_PAY`, expected `PERIOD_OVERLAP` | same pattern as p10 line 35 |
| p26.billing_units | 175 the backfill fills the monthly days... | `PERIOD_OVERLAP`, expected `NOTHING_TO_PAY` | follows from line 104 |
| p27.ledger | 53, 76, 89, 95, 121 (whole file) | setup: `FUTURE_TIME check_out_time cannot be in the future` | the file freezes the clock at 20 Nov 12:00 and checks a machine out at 15:00 that same day |
| p29.monthly_offset | 94 a rate card is edited under a draft... | `false !== true` (draft not marked stale) | rate card edit under a draft |
| p29.monthly_offset | 102 PDF: the office chooses what the vendor sees | generate -> `NOTHING_TO_PAY` | follows from line 94 or test data |
| p29.monthly_offset | 115 two invoices in one month... | generate -> `NOTHING_TO_PAY` | same |
