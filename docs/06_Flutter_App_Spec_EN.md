# Flutter App — Specification

**New app equipment_flow_app — login, roles, Admin / Accountant / Supervisor**

Navigation, screens with wireframes, widgets, services, models and UX rules.

_Equipment Flow · Doc 06 · v2.0 standalone · 2026-10-03_

---

# 1. New app `equipment_flow_app`

- Create it with `flutter create --org com.asik --platforms android,ios,web equipment_flow_app`.
- UI language is English, LTR. Font **Cairo** (bundle `assets/fonts/Cairo.ttf`; it also renders Arabic names). Colours: primary navy `#1A2A6C`, accent gold `#B8963E`. Material 3.
- State: plain `StatefulWidget` + `setState` and small `ChangeNotifier` services (no heavy framework). This keeps the code easy for Claude Code and for maintenance.
- Packages:
  - `dio`, `flutter_secure_storage`, `shared_preferences`, `intl`, `image_picker`, `file_selector`;
  - `pdf`, `printing` (view / print PDFs), `share_plus`, `path_provider`, `fl_chart`, `url_launcher`;
  - optional: `mobile_scanner` (QR scan-to-upload, phase 9b).
- Environments: `--dart-define=API_BASE_URL=https://api.example.com/api` (default `http://10.0.2.2:5000/api` for the Android emulator).

# 2. Files to create

```
lib/
├─ main.dart                         MaterialApp, theme, navigatorKey, AuthGate as home
├─ core/
│   ├─ config.dart                    API_BASE_URL from --dart-define
│   ├─ theme.dart                     colours, text theme (Cairo), chip/button styles, state colours
│   ├─ api_client.dart                ApiClient.dio (singleton): base URL, timeouts 15 s, JWT interceptor,
│   │                                 401 → logout + "Session expired", 403 PASSWORD_CHANGE_REQUIRED → change screen,
│   │                                 ApiException(status, code, message, details)
│   ├─ auth_service.dart              login, me, changePassword, logout; token in flutter_secure_storage;
│   │                                 ChangeNotifier with currentUser (id, name, role, mustChangePassword, sites)
│   ├─ file_export.dart               FileExport.save(bytes, fileName) — conditional import web / io (download on web,
│   │                                 save to Documents + share sheet on mobile)
│   └─ formatters.dart                money, hours, dates (dd/MM/yyyy), business-time "now"
├─ auth/
│   ├─ auth_gate.dart                 splash → /auth/me → route by role (§7)
│   ├─ login_screen.dart
│   └─ change_password_screen.dart    forced on first login
├─ shell/
│   ├─ app_shell.dart                 responsive: NavigationRail (≥ 1000 px) / Drawer (phone); items per role
│   └─ profile_sheet.dart             name, role, change password, logout
├─ admin/
│   ├─ users_screen.dart  user_form.dart              Admin only
│   ├─ sites_screen.dart  site_form.dart  site_supervisors_sheet.dart
│   ├─ settings_screen.dart  audit_screen.dart
├─ models/equipment/  (eq_vendor, eq_contract, eq_type, eq_machine, eq_operator, eq_rate_card, eq_deployment,
│                      eq_attendance, eq_downtime, eq_site_day, eq_timesheet, eq_scan, eq_paper_check,
│                      eq_payroll (batch, item, line, blocker), eq_live)  +  models/user.dart, site.dart
├─ services/  equipment_service.dart  admin_service.dart (users, sites, settings, audit)
├─ screens/equipment/
│   ├─ eq_live_board_screen.dart
│   ├─ eq_machines_screen.dart  eq_machine_form.dart  eq_machine_detail_screen.dart  eq_rate_card_form.dart
│   ├─ eq_vendors_screen.dart  eq_vendor_form.dart  eq_vendor_detail_screen.dart  eq_contract_form.dart
│   ├─ eq_operators_screen.dart  eq_operator_form.dart  eq_deploy_sheet.dart
│   ├─ eq_attendance_review_screen.dart
│   ├─ eq_timesheets_screen.dart  eq_reconcile_screen.dart
│   ├─ eq_payroll_screen.dart  eq_batch_detail_screen.dart  eq_fuel_adjustments_screen.dart
│   └─ supervisor/  sup_home_screen.dart  sup_equipment_screen.dart  sup_machine_action_sheet.dart
│                    sup_timesheet_screen.dart  sup_fuel_sheet.dart  sup_rejected_screen.dart
└─ widgets/
    ├─ data_table_card.dart (sortable, selectable, paginated)  searchable_picker_sheet.dart
    ├─ protected_image.dart (downloads image bytes with the JWT)  pdf_viewer_screen.dart (printing.PdfPreview)
    ├─ help_tip.dart  empty_state.dart  error_banner.dart  kpi_tile.dart  section_card.dart
    └─ equipment/  eq_state_chip.dart  eq_machine_card.dart  eq_timeline_bar.dart  eq_money_text.dart  eq_hours_text.dart
```

# 3. Design rules (apply everywhere)

| Rule | Detail |
|---|---|
| State colours | Working `#2E8B57` · On break `#5B6B8C` · Breakdown `#C0392B` · Standby `#D48A00` · Finished / Absent / Holiday `#9AA0AB` · Not arrived = outlined red. Always colour **and** text label (accessibility). |
| Workflow chips | Draft grey · Submitted blue · Approved green · Rejected red. Paper chips: Pending outline · Matched green tick · Mismatch red · Missing amber. |
| Touch targets | ≥ 48 px; primary action button full-width at the bottom of sheets. |
| Time entry | Default "now" (business time) with a one-tap time picker to change; never free text. Show `+1 day` badge for night check-out after midnight. |
| Feedback | Every action → optimistic disable + spinner on the button, then SnackBar success or `EqErrorBanner` with the server `message`; on `409` show the specific explanation (e.g. "EQ-0012 is still checked in at Tower A since 06:50"). |
| Empty / loading / error | Skeleton list while loading; `EqEmptyState` with an action; retry on error. |
| Responsiveness | Supervisor screen phone-first (single column). Admin screens: `LayoutBuilder` — ≥ 1100 px two panes (list + detail), else one. |
| Money | Only in Admin screens. `EqMoneyText(amount, currency)` → `USD 1,460.00` / `SYP 1,460,000`. |
| Numbers | Hours `9.50 h`; minutes shown as `1 h 30 m` in timelines. |
| Refresh | Pull-to-refresh on every list; live board auto-refresh every `refresh_seconds` with a "Updated 11:42" label and pause when the tab is not visible. |

# 4. Admin / Accountant screens

Navigation items in `AppShell` (the Accountant sees the same items except Users, Sites edit, Settings and Audit, and has no approve / deploy / price-edit buttons):

| Item | Screen |
|---|---|
| Live board | `EqLiveBoardScreen` (home for Admin and Accountant) |
| Attendance review (badge: Submitted count) | `EqAttendanceReviewScreen` |
| Timesheets (badge: Pending/Mismatch rows) | `EqTimesheetsScreen` |
| Payroll | `EqPayrollScreen` |
| Fuel & adjustments | `EqFuelAdjustmentsScreen` |
| Machines | `EqMachinesScreen` |
| Vendors | `EqVendorsScreen` |
| Operators | `EqOperatorsScreen` |
| Sites | `SitesScreen` (Admin edits; Accountant reads) |
| Users · Settings · Audit | Admin only |

Admin screens for platform data:

- **Users:** list, filter by role and status, create (shows the temporary password once with a "Copy" button), edit, activate / deactivate, reset password.
- **Sites:** list and form (code, name, project, location, night shift, shift start times), and a supervisors sheet (current supervisor per shift, history, Assign / Replace / End).
- **Settings:** grouped form with a `HelpTip` per key.
- **Audit:** filterable table with an old/new JSON diff viewer.

## 4.1 Live board

<div class="wf"><div class="bar"><span>Equipment Flow · Live board</span><span>Updated 11:42 ⟳</span></div>
<div class="row"><div class="kpi">On site now<b>19 / 23</b></div><div class="kpi">Working<b style="color:#2E8B57">14</b></div><div class="kpi">Breakdown<b style="color:#C0392B">2</b></div><div class="kpi">Standby<b style="color:#D48A00">1</b></div><div class="kpi">Not arrived<b>3</b></div><div class="kpi">Hours today<b>61.5</b></div><div class="kpi">Est. cost today<b>$2,460</b></div></div>
<div class="row"><span class="btn p">All sites ▾</span><span class="btn">All vendors ▾</span><span class="btn">Group: Site | Vendor</span><span class="btn">Problems only</span></div>
<div class="row"><div class="card"><b>S08 · Tower B</b> <span class="muted">· 7 deployed</span><br>
<span class="chip g">Working</span> EQ-0012 Excavator · Ahmad K. · since 07:02 (4 h 40 m)<br>
<span class="chip r">Breakdown</span> EQ-0019 Loader · since 09:15 · "hydraulic pump"<br>
<span class="chip b">On break</span> EQ-0021 Roller · 11:30<br>
<span class="chip gr">Not arrived</span> EQ-0030 Truck</div>
<div class="card"><b>S09 · Bridge</b> <span class="muted">· 5 deployed</span><br>
<span class="chip g">Working</span> EQ-0007 Crane · since 06:30<br>
<span class="chip a">Standby</span> EQ-0008 Pump · waiting concrete<br>
<span class="chip g">Working</span> EQ-0011 Excavator</div></div></div>

Behaviour: tap a machine → bottom sheet with today's timeline (`EqTimelineBar`: green working, blue breaks, red breakdown, amber standby), operator, meter, links "Open machine", "Open day board". Tap a site → drill-down `/live/sites/:id`. "Problems only" filters breakdown, not arrived, forgotten check-out, anomalies.

## 4.2 Machines

List (search, filters vendor / type / site / status / deployed) with columns: code, type, plate, vendor, current site/shift, state today, current rate (mode + price). FAB "Add machine".

**Machine detail** (two panes on wide screens): header card (photo via `protected_image.dart`, code, type, plate, vendor, status) · tabs **Overview** (current deployment with Deploy / Transfer / End buttons → `eq_deploy_sheet`), **Rate cards** (timeline list, "New rate card", lock icon on cards used by finalized payroll), **Attendance** (last 30 days), **Timesheets** (months), **Fuel & adjustments**.

**Rate card form** — grouped sections with a `HelpTip` on each option:

1. Contract & dates · 2. Billing mode (segmented Hourly / Daily / Monthly) → shows only the relevant price fields · 3. Minimum & overtime · 4. Standby / breakdown % (sliders 0–100 with numeric field) · 5. Breaks, operator, fuel policy · 6. **Test this price** panel: editable sample week (7 rows with status + hours) → calls `/rate-cards/preview` and shows the lines and total live. This panel is what makes the flexible pricing understandable to the user.

## 4.3 Vendors / Operators

Vendors list → detail with tabs: Info · Contracts (upload / view document) · Machines · Operators · Statements (shortcuts to provisional vendor statement for a chosen period). Operators list with license expiry badge (red when expired, amber < 30 days).

## 4.4 Attendance review

Filters bar (date range, site, vendor, machine, status default **Submitted**, "Anomalies only", paper status). `DataTableCard` with checkbox selection; columns: date, site/shift, machine, operator, in, out, work h, breakdown h, standby h, day status, anomaly icon, paper chip, sheet row. Bulk actions: **Approve**, **Reject (notes)**. Row tap → side panel with downtime list, meters, remarks, anomaly with "Acknowledge (note)", Edit (Admin), Correction (when locked). After bulk approve show the `skipped` list with reasons.

## 4.5 Timesheets & reconciliation

Timesheets list (month picker, site, machine, status, "needs scan", "needs check") with progress bar `matched / rows`.

<div class="wf"><div class="bar"><span>ETS-2026-10-EQ0012-S08 · Excavator EQ-0012 · Tower B · Oct 2026</span><span>Scan v3 ▾</span></div>
<div class="row"><div class="card" style="min-width:70mm;height:46mm;display:flex;align-items:center;justify-content:center;background:#eef0f4"><span class="muted">[ scanned sheet page 1/2 — pinch to zoom ]</span></div>
<div class="card"><b>Rows</b> <span class="muted">· 14 rows · 11 matched · 1 mismatch · 2 pending</span><br>
#1 Wed 01 · 07:00–17:30 · 9.50 h <span class="chip g">Matched</span><br>
#2 Thu 02 · 06:58–17:10 · 9.20 h <span class="chip g">Matched</span><br>
#3 Sat 04 · 07:02–17:31 · 9.48 h <span class="btn p">Matches paper (M)</span><span class="btn">Mismatch (X)</span><span class="btn">Edit</span><br>
#4 Sun 05 · Breakdown day <span class="chip r">Mismatch</span> <span class="muted">"paper says Standby"</span></div></div>
<div class="row"><span class="btn">Upload new scan</span><span class="btn">Print sheet</span><span class="btn p">Close month</span></div></div>

## 4.6 Payroll

<div class="wf"><div class="bar"><span>Equipment payroll</span><span>New run</span></div>
<div class="row"><span class="btn">Period: 01–31 Oct 2026</span><span class="btn">Vendor: Al-Bunyan ▾</span><span class="btn">Machine: all ▾</span><span class="btn">Site: all ▾</span><span class="btn">Currency: USD</span></div>
<div class="row"><div class="card"><b>Blockers (3)</b><br><span class="chip a">PAPER_NOT_MATCHED</span> EQ-0012 rows #3, #4 <br><span class="chip r">NOT_APPROVED</span> EQ-0019 · 2 rows · <span class="muted">Open review</span></div>
<div class="card"><b>Preview</b><br>9 machines · 1,412.5 work h · Gross $41,880.00 · Deductions $1,320.00 · <b>Net $40,560.00</b><br><span class="btn">Preview PDF</span><span class="btn p">Generate batch</span></div></div>
<div class="row"><div class="card"><b>Batches</b><br>#17 v1 · Oct 2026 · Al-Bunyan · <span class="chip b">Generated</span> · $40,560.00 · <span class="btn">Finalize</span><span class="btn">PDF ▾</span><span class="btn">Excel</span><br>#12 v2 · Sep 2026 · All vendors · <span class="chip g">Paid</span> · $118,230.00</div></div></div>

Batch detail: header (scope, version, status, stale warning with "Recalculate"), vendor groups → machine items → expandable lines and daily rows; actions Finalize · Mark paid · Void (reason) · Supersede (reason) · Versions; export menu **Summary PDF · Vendor statement PDF (choose vendor) · Machine statement PDF (choose machine) · Excel**. Shortcut on a machine or vendor page: **Statement for period…** (provisional, watermarked).

Fuel & adjustments screen: two tabs; fuel list with "Unpriced" filter and inline price entry; adjustments list with add dialog (machine, date, type, signed amount, reason).

# 5. Supervisor — Site equipment day board

Entry: the Supervisor's home `SupHomeScreen` lists today's sites/shifts from `/equipment/my-sites` as big cards (site code, name, shift, machines deployed, problems count). With only one site/shift it opens the day board directly. The last choice is remembered in `SharedPreferences` (per-user key). Drawer: Day board · Sheets & scans · Rejected rows · Profile.

<div class="wf"><div class="bar"><span>S08 Tower B · Day · Sat 03 Oct</span><span>◀ Date ▶</span></div>
<div class="row"><div class="kpi">Deployed<b>7</b></div><div class="kpi">Working<b style="color:#2E8B57">4</b></div><div class="kpi">Break<b>1</b></div><div class="kpi">Breakdown<b style="color:#C0392B">1</b></div><div class="kpi">Not arrived<b>1</b></div></div>
<div class="row"><div class="card"><b>EQ-0012 · Excavator</b> <span class="chip g">Working</span><br><span class="muted">Al-Bunyan · Ahmad K. · in 07:02 · meter 5120.4 · sheet row #3</span><br><span class="btn">Break</span><span class="btn">Breakdown</span><span class="btn">Standby</span><span class="btn p">Check-out</span></div>
<div class="card"><b>EQ-0019 · Wheel Loader</b> <span class="chip r">Breakdown since 09:15</span><br><span class="muted">"hydraulic pump" · in 06:55</span><br><span class="btn p">End breakdown</span><span class="btn">Check-out</span></div></div>
<div class="row"><div class="card"><b>EQ-0030 · Dump Truck</b> <span class="chip gr">Not arrived</span><br><span class="btn p">Check-in</span><span class="btn">Mark day ▾ (Absent · Standby · Breakdown · Holiday)</span></div>
<div class="card"><b>EQ-0021 · Roller</b> <span class="chip b">On break 11:30</span><br><span class="btn p">End break</span></div></div>
<div class="row"><span class="btn">Sheets & scans</span><span class="btn">Fuel</span><span class="btn">Rejected (2)</span><span class="btn p" style="flex:1;text-align:center">Submit day (7 rows)</span></div></div>

Rules:

- Cards sorted: problems first (breakdown, not arrived, forgotten check-out), then working, then finished.
- **One primary button per card** = the next logical action (Check-in → Check-out; during downtime → End …). Secondary actions as outlined buttons.
- **Check-in sheet**: time (now), operator (pre-selected default operator, searchable list of the vendor's operators, expired license warning), meter start (pre-filled with last meter end, editable), Save.
- **Downtime sheet**: type chips (Break · Refuel · Breakdown · Standby), start time (now), reason (required for Breakdown and Standby — quick-pick reasons: "No work front", "Waiting trucks", "Weather", "Mechanical failure", "No operator", free text).
- **Check-out sheet**: time (now, with "+1 day" if before check-in time for Night), meter end (validation ≥ start, warning if Δ differs from hours by more than tolerance), fuel received (L, optional), work description (required, quick suggestions from last 5 entries of this machine).
- **Day status**: for machines with no row — Absent / Standby / Breakdown / Holiday with remarks.
- **Submit day**: disabled with explanation while sessions are open; shows server blockers (previous week drafts) exactly like workers.
- Rejected rows: banner "2 rows rejected — fix and resubmit" → list with admin notes.
- Offline: not supported in v1; show a clear "No connection — nothing was saved" message on network errors (never fake success).

## 5.1 Sheets & scans (Supervisor)

List of this month's sheets for the site (one per machine): rows count, last scan version/date, status. Actions: **Print / Share PDF** (`/timesheets/:id/print.pdf` → `FileExport.save` or `Printing.layoutPdf`), **Upload scan** (camera multi-shot or file; `through_row_no` prefilled; progress), view scans (PDF viewer via `printing`). Optional phase 9b: "Scan QR" button (`mobile_scanner`) → resolves the sheet and opens Upload.

# 6. `equipment_service.dart` (pattern)

```dart
class EquipmentService {
  final Dio _dio = ApiClient.dio;
  static const _base = '/equipment';

  Future<T> _call<T>(Future<Response> Function() req, T Function(dynamic data) map) async {
    try {
      final r = await req();
      return map(r.data['data']);
    } on DioException catch (e) {
      final d = e.response?.data;
      if (d is Map) {
        throw ApiException(e.response?.statusCode, (d['code'] ?? 'ERROR').toString(),
            (d['message'] ?? 'Request failed').toString(), d['details'] as Map<String, dynamic>?);
      }
      throw ApiException(null, 'NETWORK', 'No connection — nothing was saved.');
    }
  }

  Future<EqSiteDay> siteDay(int siteId, String date, String shift) => _call(
      () => _dio.get('$_base/attendance/site/$siteId', queryParameters: {'date': date, 'shift': shift}),
      (d) => EqSiteDay.fromJson(d));

  Future<List<int>> timesheetPdf(int id) async {
    final r = await _dio.get('$_base/timesheets/$id/print.pdf', options: Options(responseType: ResponseType.bytes));
    return r.data as List<int>;
  }
  // ... one typed method per endpoint of document 03
}
```

Note: `ApiClient.dio` has 15 s timeouts; for PDF / Excel downloads and scan uploads pass `Options(receiveTimeout: Duration(seconds: 60), sendTimeout: Duration(seconds: 120))`.

Models: `fromJson` tolerant of `int`/`String` numbers (`num.tryParse(v.toString())`) because MySQL DECIMAL arrives as strings with `dateStrings: true`.

# 7. Login and role routing

`AuthGate`:

1. Read the token from secure storage. If there is none → `LoginScreen`.
2. Call `GET /auth/me`. If it fails with 401 → clear the token → `LoginScreen`.
3. If `must_change_password` → `ChangePasswordScreen` (it cannot be skipped).
4. Route by role:
   - **Admin** and **Accountant** → `AppShell` on the Live board;
   - **Supervisor** → `SupHomeScreen`;
   - any other value → logout with the message "Unsupported role".

`LoginScreen`:

- logo, username, password (show/hide), "Sign in";
- clear messages for `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` (shows the unlock time) and `ACCOUNT_INACTIVE`;
- no "forgot password" in v1 — the Admin resets passwords.

Logout clears secure storage and navigates to `LoginScreen` with `pushAndRemoveUntil`. The API interceptor does the same on any 401 and shows "Your session has expired. Please sign in again."

Every screen also checks the role on the client (to hide buttons), but **security is enforced by the API**: the client never decides permissions.
