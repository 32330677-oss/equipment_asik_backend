# Equipment Flow — Help Center

<!--
HOW TO EDIT THIS FILE
The app reads this file from the server every time someone opens Help & Assistant (the server re-reads it when it
changes, no restart needed). Edit it, save it on the server, and every user sees the new text. No app update.

Screens (one line each):   @screen <id> | <title in the app> | <roles that have the screen>
Topics: every topic starts with "## <title>", then lines "key: value", then a blank line, then the text.
  id:        unique, lowercase-with-dashes (used in links; do not change it once people use it)
  roles:     who sees the topic: Admin, Accountant, Supervisor (comma separated)
  screens:   screens the topic is about ("On this page" in the Help Center)
  open:      the screen the "Open ..." button goes to (must be one of the screens above)
  popular:   roles that see it under "Popular topics"
  keywords:  other words people type for this (the search already understands approve/approving/approved)
  related:   ids of other topics shown at the bottom
Text: the first paragraph is the summary. "1. ..." lines are numbered steps. "- ..." lines are bullets.
"Tip: ..." and "Note: ..." lines are shown in a box. Put button and screen names in **bold**.
-->

@screen live-board | Live board | Admin, Accountant
@screen attendance-review | Attendance review | Admin, Accountant
@screen paper-sheets | Paper sheets | Admin, Accountant
@screen client-report | Daily report (client) | Admin, Accountant
@screen invoices | Invoice | Admin, Accountant
@screen fuel-adjustments | Fuel & adjustments | Admin, Accountant
@screen delivery-notes | Delivery notes (DNR) | Admin, Accountant
@screen machines | Machines | Admin, Accountant
@screen vendors | Vendors | Admin, Accountant
@screen sites | Sites | Admin, Accountant
@screen users | Users | Admin
@screen settings | Settings | Admin
@screen audit-log | Audit log | Admin
@screen my-sites | My sites | Supervisor
@screen day-board | Day board | Supervisor
@screen rejected-rows | Rejected rows | Supervisor

## Sign in for the first time
id: first-sign-in
roles: Admin, Accountant, Supervisor
keywords: login log in sign in first time temporary password new account start
related: change-password

Your account starts with a temporary password from the Admin. You change it the first time you sign in.

1. Open the app and type your **Username** and the temporary password.
2. The app asks for a new password straight away. Type it twice and save.
3. You land on your home screen: **My sites** for a supervisor, the **Live board** for the office.

Note: After an update that changes passwords, everyone signs in again once.

## Change your password
id: change-password
roles: Admin, Accountant, Supervisor
popular: Supervisor
keywords: password change new password forgot reset my password security
related: first-sign-in, reset-password

You can change your own password at any time. Every other session of your account is signed out.

1. Office: tap your name or avatar at the top right, then **Change password**.
2. Supervisor: open the menu (☰) at the top left, then **Change password**.
3. Type the current password, then the new one twice, and save.

Tip: Forgot your password? Ask the Admin to use **Reset password** on your account.

## Who does what
id: who-does-what
roles: Admin, Accountant
keywords: roles permissions rights allowed role admin accountant supervisor responsibilities
related: first-setup-order, create-user

The supervisor records on the phone, the accountant prepares prices and invoices, the Admin approves and closes.

- **Admin**: users, sites, supervisors, settings, vendor contracts; approves or rejects attendance; reopens closed sheets; decides extra hours on monthly machines; approves the accountant's requests.
- **Accountant**: vendors, machines, rate cards, deployments, fuel, adjustments, paper sheets, invoice batches.
- **Supervisor**: records the machines of his own sites only. He never sees a price or an amount.
- By default only the Admin may **Finalize** and **Mark paid** (setting "Only Admin can finalize / mark paid").

## First-time setup, in order
id: first-setup-order
roles: Admin, Accountant
popular: Admin
keywords: setup set up start begin configure first time order onboarding new system
related: create-user, create-site, assign-supervisor, add-vendor, add-contract, add-machine, create-rate-card, deploy-machine

Do it once, in this order: every step needs the one before.

1. Admin: create the accountant and the supervisors in **Users**.
2. Admin: create the construction sites in **Sites**, with the short code and the night shift if any.
3. Admin: assign a supervisor to every site and shift from a date.
4. Admin: check **Settings** (weekly day off, default currency).
5. Accountant: add the **Vendors**. Admin: add a **Contract** for each vendor (it gives the currency).
6. Accountant: add the **Machines**, then a rate card for each one.
7. Accountant: deploy each machine on a site and shift. Without a deployment the supervisor does not see the machine.

## Create a user
id: create-user
roles: Admin
screens: users
open: users
popular: Admin
keywords: add user new user account employee staff create account supervisor accountant
related: reset-password, deactivate-user, assign-supervisor

Every person gets their own account and role.

1. Open **Users** and tap **New user**.
2. Fill **Username**, **Full name** and choose the **Role** (Admin, Accountant or Supervisor).
3. Tap **Create**. The app shows a **Temporary password**: tap **Copy** and give it to the person.
4. A supervisor also needs to be assigned to a site: see "Assign a supervisor to a site".

## Reset a user's password
id: reset-password
roles: Admin
screens: users
open: users
keywords: forgot password locked out unlock reset password new temporary password
related: create-user, change-password

Use it when someone forgot their password or the account is locked.

1. Open **Users** and find the person.
2. Tap **Reset password**, then **Reset** to confirm.
3. Copy the new **Temporary password** and give it to the person. The account is also unlocked.

## Deactivate or reactivate a user
id: deactivate-user
roles: Admin
screens: users
open: users
keywords: disable block remove delete user left the company deactivate activate account
related: create-user

A deactivated account can no longer sign in, at once. Its history stays.

1. Open **Users** and find the person.
2. Tap **Deactivate**, write why (kept in the audit log) and confirm.
3. To let them back in, tap **Activate**.

## Create a construction site
id: create-site
roles: Admin
screens: sites
open: sites
keywords: add site new site project location construction site night shift code
related: assign-supervisor, deploy-machine

A site is where machines are deployed and supervisors record. Only the Admin creates sites.

1. Open **Sites** and tap **New site**.
2. Fill **Code** (short, e.g. S08) and **Site name**. Location and project are optional.
3. Tick **Site has a night shift** if machines also work at night, and set when the day starts.
4. Tap **Save**. Then assign its supervisors.

Tip: A finished site is closed with **Mark completed**; **Suspend** stops it for a while.

## Assign a supervisor to a site
id: assign-supervisor
roles: Admin, Accountant
screens: sites
open: sites
popular: Admin
keywords: supervisor assign site responsible change supervisor replace supervisor shift
related: create-user, supervisor-cannot-see-machine

A site and shift has one supervisor at a time, from a date. Only the Admin can change it.

1. Open **Sites** and open the site.
2. Under **Supervisors** tap **Assign**, choose the **Shift** (Day or Night), the **Supervisor** and the first day.
3. To hand the site to another supervisor, tap **Replace from a date**: the old one ends the day before.
4. To stop an assignment, tap **End** on its line.

Note: Create the person with the Supervisor role in **Users** first.

## Change a setting
id: change-setting
roles: Admin
screens: settings
open: settings
keywords: settings configuration weekly day off friday currency tolerance finalize admin only option
related: who-does-what, audit-log

Settings change how the whole system works. Settings that change amounts or permissions ask for a reason.

1. Open **Settings**.
2. Tap the setting, type the new **Value**.
3. If asked, write the **Reason** (kept in the audit log) and save.

- **Weekly day off (monthly machines)**: usually Friday.
- **Only Admin can finalize / mark paid**: on by default.
- **Hours to undo "Finalize"**: how long a finalized batch can go back to a draft.

## See who changed what (audit log)
id: audit-log
roles: Admin
screens: audit-log
open: audit-log
keywords: audit history log who changed changes trace track before after
related: change-setting

Every change is recorded with who, when, the values before and after, and the reason.

1. Open **Audit log**.
2. Filter by **Table** or user, then open a line to see **Before** and **After**.

## Add a vendor
id: add-vendor
roles: Admin, Accountant
screens: vendors
open: vendors
keywords: vendor supplier company rental company new vendor create add owner
related: add-contract, add-machine, opening-balance

A vendor is the company (or person) that rents machines to us.

1. Open **Vendors** and tap **New vendor**.
2. Choose **Company** or **Individual (person)** and fill the name, contact and phone. A company's **Tax number** is printed on vouchers.
3. Save. Then the Admin adds a contract: without one you cannot create rate cards.

## Add a vendor contract
id: add-contract
roles: Admin, Accountant
screens: vendors
open: vendors
keywords: contract agreement currency vendor contract upload signed contract document
related: add-vendor, create-rate-card

The contract gives the vendor's currency. Only the Admin creates or changes it.

1. Open **Vendors** and open the vendor.
2. Under **Contracts** tap **New contract**: **Contract number**, start date, **Currency**.
3. Save, then **Upload document** to attach the signed contract (PDF or photo).

Note: Uploading again does not delete the old file: it becomes a new version and asks for a reason.

## Record an opening balance (money owed from before the system)
id: opening-balance
roles: Admin, Accountant
screens: vendors
open: vendors
keywords: opening balance old debt previous balance owed before system old invoice carried
related: create-invoice-batch, vendor-statement

Money we already owed a vendor before using the system. It is added to the vendor's next invoice batch.

1. Open **Vendors** and open the vendor.
2. Under **Opening balances (before the system)** tap **Add opening balance**.
3. Fill the **Balance date**, the amount still owed and the old invoice number, then save.

## Add a machine
id: add-machine
roles: Admin, Accountant
screens: machines
open: machines
popular: Accountant
keywords: machine equipment excavator loader crane truck new machine add plate fleet
related: create-rate-card, deploy-machine, add-vendor

Every rented machine is added once, with its vendor and type.

1. Open **Machines** and tap **New machine**.
2. Choose the **Vendor** and the **Type** (excavator, loader, crane...). Fill the plate number and model.
3. Save. Then give it a rate card and deploy it on a site.

Tip: A missing type? Add it with **New machine type**.

## Create a rate card (the machine's price)
id: create-rate-card
roles: Admin, Accountant
screens: machines
open: machines
popular: Accountant
keywords: rate card price pricing hourly daily monthly cost rent price per hour per day per month overtime
related: change-price-from-date, test-price, monthly-machine-rules

A rate card says how a machine is paid, from a date: per hour, per day or per month.

1. Open **Machines** and open the machine.
2. Under **Rate cards** tap **New rate card** and choose the **Vendor contract**.
3. Choose **Hourly**, **Daily** or **Monthly** and fill the price.
4. Hourly or daily: hours per day, minimum, overtime, and how standby and breakdown are paid.
5. Monthly: price per month and working hours per day at the site.
6. Set **Effective from** and tap **Save**.

Tip: Use **Test this price** before saving to see the result on sample days.

## Change a machine's price from a date
id: change-price-from-date
roles: Admin, Accountant
screens: machines
open: machines
keywords: change price new price increase decrease rate change from date revise rate card
related: create-rate-card, test-price

Never edit a card that was already paid: change it from a date instead.

1. Open **Machines**, open the machine, find the current card under **Rate cards**.
2. Tap **Change from a date**, set the date the new price starts, and the new values.
3. Write the reason and save. The old card ends the day before; old invoices keep their prices.

- **Close on a date**: the machine stops being paid by this card.
- A card used by a draft batch cannot change: void the draft first.

## Test a price before saving
id: test-price
roles: Admin, Accountant
screens: machines
open: machines
keywords: test simulate try calculate example sample days check price
related: create-rate-card

Try a rate card on sample days before saving it. Nothing is saved.

1. In the rate card form, tap **Test this price**.
2. Add sample days with their hours (work, breaks, standby, breakdown).
3. Tap **Calculate** to see what would be paid. Nothing is saved.

## Deploy a machine on a site
id: deploy-machine
roles: Admin, Accountant
screens: machines
open: machines
popular: Accountant
keywords: deploy deployment send machine to site assign machine site shift start working place
related: transfer-machine, end-deployment, supervisor-cannot-see-machine

The supervisor sees a machine only when it is deployed on his site and shift.

1. Open **Machines** and open the machine.
2. Under **Deployments** tap **Deploy**.
3. Choose the **Site**, the **Shift** and the **First day**, then save.

Note: The app warns you if the machine has no rate card on the first day.

## Move a machine to another site
id: transfer-machine
roles: Admin, Accountant
screens: machines
open: machines
keywords: transfer move relocate machine another site change site
related: deploy-machine, end-deployment

Move a deployed machine to another site from a date, in one step.

1. Open **Machines**, open the machine, go to **Deployments**.
2. Tap **Transfer**, choose the **Target site** and the **First day at the new site**.
3. Save. The old deployment ends the day before.

## End a deployment (machine leaves the site)
id: end-deployment
roles: Admin, Accountant
screens: machines
open: machines
keywords: end deployment release return machine vendor stop leave site demobilize
related: deploy-machine, transfer-machine

When a machine leaves a site, end its deployment so the supervisor stops seeing it.

1. Open **Machines**, open the machine, go to **Deployments**.
2. Tap **End deployment** and set the **Last day on the site**.
3. To take the machine out completely, change its **Machine status** (e.g. Returned to the vendor).

## Set up the fuel price difference
id: fuel-difference-setup
roles: Admin, Accountant
screens: fuel-adjustments, machines
open: fuel-adjustments
keywords: fuel price difference official price national price diesel base price litres per hour fuel terms
related: price-fuel, record-fuel-issue

When the contract says we pay the difference between the official fuel price and a base price.

1. In **Fuel & adjustments** → **Fuel prices**, tap **Add price** and enter the official price per litre from its date.
2. In **Machines**, open the machine, under **Fuel price difference** tap **New terms**.
3. Enter the **Base fuel price per litre**, the **Consumption (litres per working hour)** and the first day.

Note: A missing official price for a date blocks the invoice of that period.

## Delivery notes (DNR): per-unit prices and notes
id: delivery-notes
roles: Admin, Accountant
screens: delivery-notes, machines
open: delivery-notes
keywords: dnr delivery note trip ton cubic metre per unit load truck notes
related: create-rate-card

Some machines are paid per unit (trip, ton, cubic metre) from delivery notes.

1. Set the prices: **Machines** → open the machine → **DNR prices (per unit)** → **New DNR price**.
2. Record each note: **Delivery notes (DNR)** → **New delivery note**: machine, site, **Price item**, **Quantity**, number.
3. The notes are billed in the next invoice batch of the period.

Tip: A wrong note is fixed with **Correct** or **Cancel the note** (it is kept but never paid).

## A supervisor cannot see a machine
id: supervisor-cannot-see-machine
roles: Admin, Accountant, Supervisor
screens: day-board, machines, sites
open: machines
keywords: missing machine not showing cannot see machine not on board not deployed where is
related: deploy-machine, assign-supervisor

Almost always one of these:

- The machine is not deployed on this site and shift on this date (**Machines** → **Deployments**).
- The supervisor is not assigned to this site and shift on this date (**Sites** → **Supervisors**).
- The date is before the deployment or the assignment started.

Supervisor: you cannot fix this yourself. Tell the office which machine and which site.

## Open a site and record the day
id: open-site-day
roles: Supervisor, Admin
screens: my-sites, day-board
open: my-sites
popular: Supervisor
keywords: my sites today record day board start site open site shift machines list
related: check-in, submit-day, record-past-day

The supervisor records each machine of his site on the Day board, then sends the day to the office.

1. On **My sites**, tap the site and shift (day or night).
2. The **Day board** lists every machine deployed there with its state: not arrived, working, on break, breakdown, finished.
3. Use the big button on each machine: **Check in**, **Check out**, **Resume work**...
4. At the end of the day tap **Submit day**.

## Check a machine in
id: check-in
roles: Supervisor, Admin
screens: day-board
open: my-sites
popular: Supervisor
keywords: check in start work arrived machine started begin meter start time
related: check-out, record-pause, did-not-work

Record when a machine starts working.

1. On the **Day board**, find the machine (search by code, plate, type or vendor).
2. Tap **Check in**.
3. Set the start time and, if the machine has one, the **Meter start**. Save.

Note: You cannot set a time in the future (5 minutes are allowed).

## Record a break, refuelling, breakdown or standby
id: record-pause
roles: Supervisor, Admin
screens: day-board
open: my-sites
popular: Supervisor
keywords: pause break lunch refuel refuelling breakdown broken standby waiting stopped downtime idle
related: check-in, check-out, did-not-work

While the machine is working, record every stop from one time to another.

1. Tap **Pause** on the machine and choose:
   - **Break** or **Refuelling**: a normal stop.
   - **Breakdown**: the machine is broken (the vendor's fault). Give the reason.
   - **Standby (no work)**: ready, but we gave it no work (our fault). Give the reason.
2. When it works again, tap **Resume work**.
3. Forgot one? After the check-out use **Edit** → **Add a breakdown**, **Add a standby period** or **Add a refuelling stop**.

## Check a machine out
id: check-out
roles: Supervisor, Admin
screens: day-board
open: my-sites
popular: Supervisor
keywords: check out finish end work stop machine done meter end end time
related: check-in, submit-day, record-pause

Record when a machine stops working for the day.

1. On the **Day board**, tap **Check out** on the machine.
2. Set the **End time**, the **Meter end** if any, and the **Work done** today.
3. Save. Any pause still open is closed by itself.

Tip: Lunch forgotten? Tap **Add lunch / break** on the finished machine. Wrong time? **Edit** → **Edit times**.

## The machine did not work today
id: did-not-work
roles: Supervisor, Admin
screens: day-board
open: my-sites
popular: Supervisor
keywords: did not work absent holiday standby breakdown whole day no show not come day status off
related: record-pause, check-in

Give the whole day one status instead of times.

1. Tap **Did not work** on the machine (or **Edit** → **Did not work** after a check-in).
2. Choose:
   - **Standby**: on site and ready, but no work was given.
   - **Breakdown**: broken the whole day.
   - **Absent**: the machine did not come.
   - **Holiday**: official day off.
3. Standby and Breakdown need a reason. Save.

Tip: It came after all? Tap **It came after all** and check it in.

## Fill the day from the paper sheet
id: fill-from-paper
roles: Supervisor, Admin
screens: day-board
open: my-sites
keywords: paper sheet fill many machines at once bulk entry usual hours copy yesterday same as yesterday
related: submit-day, record-past-day

Record many machines at once from the paper sheet.

1. On the **Day board**, tap **Fill from the paper sheet** (or menu ⋮ → **Fill from the paper sheet**).
2. Set the **Usual hours of the day** once: it is applied to every machine you do not change by hand.
3. Change the machines that are different, mark the others **Skip**.
4. Tap **Save all**.

## Submit the day
id: submit-day
roles: Supervisor, Admin
screens: day-board
open: my-sites
popular: Supervisor
keywords: submit send day finish day send to office end of day
related: check-out, recall-row, fix-rejected-rows

At the end of the day, send all the rows to the office.

1. Make sure every machine is checked out or has a day status.
2. Tap **Submit day**.

It is refused when:

- a machine is still checked in without a check-out;
- last week still has days that were not submitted (the week starts on Saturday).

## Recall a row you already sent
id: recall-row
roles: Supervisor, Admin
screens: day-board
open: my-sites
keywords: recall take back undo submit mistake after submit withdraw row correct before approval
related: submit-day, ask-office-change

You noticed a mistake after **Submit day** and the office has not approved yet.

1. Open the machine's row and tap **Recall** (or menu ⋮ → **Recall the day** for the whole day).
2. Write what needs fixing. The row goes back to Draft.
3. Fix it and submit the day again.

Note: After the office approves, Recall is not possible: use **Ask the office**.

## Fix the rows the office sent back
id: fix-rejected-rows
roles: Supervisor
screens: rejected-rows, my-sites
open: rejected-rows
popular: Supervisor
keywords: rejected sent back returned fix resubmit send again office note refused
related: submit-day, recall-row

Rows the office sent back come with a note saying what to fix.

1. On **My sites** tap the red card "row(s) sent back by the office", or menu → **Rejected rows**.
2. Read the office note on each row.
3. Open the row, fix it, then tap **Send again**.

## Ask the office to change an approved row
id: ask-office-change
roles: Supervisor
screens: day-board
open: my-sites
keywords: change request ask office approved row wrong mistake after approval correction request
related: recall-row, supervisor-change-requests

Once the office approved a row, only the office can change it. You send a request.

1. Open the approved row on the **Day board** and tap **Ask the office**.
2. Change the values that are wrong and write why (required).
3. Tap **Send the request**. Nothing changes until the office approves.
4. Follow it in menu ⋮ → **My change requests**. You can **Withdraw** it while it waits.

## Night shift and machines from yesterday
id: night-shift
roles: Supervisor, Admin, Accountant
screens: day-board
open: my-sites
keywords: night shift midnight yesterday since yesterday overnight two shifts continuous
related: check-out

How the app handles night work and machines that work two shifts in a row.

- A night machine not checked out before midnight stays on the day it started. It shows on the next day's board with **Since yesterday**, so you can check it out there.
- Two shifts in a row for the same machine (the second starts within 30 minutes of the first, even on another site) count as one continuous work: overtime starts after the limit times the number of shifts.

## Record a past day (late entry)
id: record-past-day
roles: Supervisor
screens: my-sites, day-board
open: my-sites
keywords: past day yesterday another day forgot late entry old day previous date
related: open-site-day, fill-from-paper

You can record a day you missed, as long as it is after your assignment to the site.

1. On **My sites** tap **Another day** and pick the date.
2. Open the site and record as usual.
3. A row entered several days late asks **Why is it entered late?** The office sees it as a late entry.
4. Tap **Back to today** when you are done.

## Daily report PDF and report for the client (supervisor)
id: supervisor-reports
roles: Supervisor
screens: day-board
open: my-sites
keywords: report pdf daily report client print share
related: client-daily-report

Print or share the day of your site as a PDF.

1. On the **Day board** open the menu ⋮.
2. Tap **Daily report PDF** for the site's day, or **Report for the client** for the client's version.

## Approve the days the supervisors sent
id: approve-attendance
roles: Admin, Accountant
screens: attendance-review
open: attendance-review
popular: Admin
keywords: approve accept confirm validate submitted rows days attendance review ok
related: reject-attendance, acknowledge-anomaly, edit-attendance-row

Only the Admin approves. Do it every day or two: anything left waiting blocks the invoices at the month end.

1. Open **Attendance review** and set **Status** to **Submitted**.
2. Rows with an anomaly must be acknowledged first (see "Acknowledge an anomaly").
3. Tick the rows and tap **Approve**.

Tip: The tiles at the top count what is **Waiting approval**, **Anomalies to check** and **Drafts (not submitted)**.

## Reject a row back to the supervisor
id: reject-attendance
roles: Admin
screens: attendance-review
open: attendance-review
keywords: reject refuse send back return supervisor wrong row fix
related: approve-attendance, edit-attendance-row

Send rows back to the supervisor with a note when they must be fixed on site. Only the Admin rejects.

1. In **Attendance review**, tick the rows.
2. Tap **Reject** and write what the supervisor must fix.
3. The rows go back to the supervisor under **Rejected rows**.

Tip: Small mistake? **Edit** the row yourself instead of rejecting it.

## Acknowledge an anomaly
id: acknowledge-anomaly
roles: Admin
screens: attendance-review
open: attendance-review
keywords: anomaly warning check meter went backwards long session 16 hours meter mismatch acknowledge
related: approve-attendance

A row with an anomaly cannot be approved until the Admin checks it.

- A session longer than 16 hours.
- The meter went backwards.
- The meter differs from the work hours by more than 15%.

1. In **Attendance review**, set **Anomalies** to **To acknowledge**.
2. Open the row, check it, tap **Acknowledge anomaly** and write what you checked.

## Edit an attendance row (office)
id: edit-attendance-row
roles: Admin, Accountant
screens: attendance-review
open: attendance-review
keywords: edit correct fix change row times status operator meter after approval purple
related: official-correction, void-attendance-row, approve-attendance

The office can fix a row directly while it is not inside a finalized invoice.

1. In **Attendance review**, open the row and tap **Edit**.
2. Change the day status, times, pauses, meter, work done or remarks.
3. An approved row needs a reason. It stays Approved and is marked "edited after approval" (purple in the table).

- A draft batch over that day becomes stale and must be recalculated.
- If the day is in a finalized batch, **Edit** is replaced by **Official correction**.

## Void a row that should not exist
id: void-attendance-row
roles: Admin, Accountant
screens: attendance-review
open: attendance-review
keywords: void delete remove duplicate wrong machine wrong day cancel row
related: edit-attendance-row

For a row that is wrong as a whole: wrong machine, wrong day, or a duplicate.

1. In **Attendance review**, open the row and tap **Void row**.
2. Write why. The row is kept as Cancelled and is never paid.

## Standby hours of a monthly machine
id: standby-hours-monthly
roles: Admin, Accountant
screens: attendance-review
open: attendance-review
popular: Accountant
keywords: standby hours monthly machine set hours paid hours site not ready waiting deduct
related: monthly-machine-rules, fix-blockers

A monthly machine has no standby %: you decide how many standby hours are paid on each standby row.

1. In **Attendance review**, open the standby row and tap **Set hours**.
2. Type the hours paid (at most the hours per day of the rate card) and the reason.
3. Example: 10 hours a day, standby the whole day. 10 = nothing deducted; 6 = 4 hours deducted; 0 = the whole day deducted.

Note: If you leave it empty, the invoice is blocked at the month end.

## Approve a supervisor's change request
id: supervisor-change-requests
roles: Admin, Accountant
screens: attendance-review
open: attendance-review
keywords: change request supervisor asked change requests from supervisors apply request
related: ask-office-change, official-correction

Supervisors ask for changes to approved rows. The Admin or the accountant applies or rejects them.

1. In **Attendance review**, tap **Change requests**.
2. Open the request, compare the values, then **Apply** or **Reject the request**.
3. If the day is already in a finalized batch, it becomes an official correction.

## Live board
id: live-board
roles: Admin, Accountant
screens: live-board
open: live-board
keywords: live board now today dashboard on site working where machines problems estimated cost
related: client-daily-report

See every site right now: who is working, on break, broken, not arrived, and the estimated cost of the day.

1. Open **Live board**.
2. Switch between **By site** and **By vendor**.
3. Tick **Problems only** to see late machines, breakdowns and anomalies.

## Daily equipment report for the client
id: client-daily-report
roles: Admin, Accountant
screens: client-report
open: client-report
keywords: client report daily report pdf arabic english owner consultant print
related: live-board, supervisor-reports

A PDF of the day's machines for the client, in English or Arabic.

1. Open **Daily report (client)**.
2. Choose the date, the sites and the shifts.
3. Fill **Addressed to / issued by** and any **Additional information** (e.g. Weather).
4. Tap **English PDF** or **Arabic PDF**.

## Record fuel given to a machine
id: record-fuel-issue
roles: Admin, Accountant
screens: fuel-adjustments
open: fuel-adjustments
keywords: fuel diesel litres liters give fuel fuel issue receipt record fuel
related: price-fuel, fuel-difference-setup

Fuel we gave to a vendor's machine, from the receipt.

1. Open **Fuel & adjustments** → **Fuel issues** and tap **Record fuel**.
2. Choose the machine and site, the date, the **Litres (from the receipt)**, and the price if you know it.
3. Save, then upload a photo or PDF of the receipt.

Note: A date inside a finalized period is refused: use a date in an open month, or an official correction.

## Price the fuel issues
id: price-fuel
roles: Admin, Accountant
screens: fuel-adjustments
open: fuel-adjustments
popular: Accountant
keywords: fuel price unpriced price per litre without price blocker diesel give a price set the price cost of fuel
related: record-fuel-issue, fix-blockers

Fuel without a price blocks the invoice.

1. Open **Fuel & adjustments** → **Fuel issues** and keep **Unpriced only** on.
2. Tap an issue and enter the **Price per litre**, or use **Apply to all** for one price for all of them.
3. Changing a price that was already set asks for a reason.

## Add an adjustment (bonus, penalty, damage...)
id: add-adjustment
roles: Admin, Accountant
screens: fuel-adjustments
open: fuel-adjustments
keywords: adjustment bonus penalty fine damage mobilization transport deduct add amount extra
related: create-invoice-batch

An amount added to or deducted from a vendor's invoice: mobilization, penalty, damage, bonus...

1. Open **Fuel & adjustments** → **Adjustments** and tap **New adjustment**.
2. Choose the machine, the type (Mobilization, Penalty, Damage, Bonus...) and the amount.
3. **Add to vendor** pays more; **Deduct from vendor** pays less.
4. The date decides which month it is paid in. A date in a finalized month is refused.

## Upload the signed monthly sheet
id: upload-signed-sheet
roles: Admin, Accountant
screens: paper-sheets
open: paper-sheets
popular: Accountant
keywords: upload scan signed sheet paper timesheet photo pdf monthly sheet signature
related: reconcile-sheet, finalize-batch

One signed sheet per machine, site and month. By default a batch cannot be finalized without it.

1. Open **Paper sheets** and filter **Need a scan**.
2. Open the sheet and tap **Upload scan** (PDF or photos).

Tip: **Print sheet** prints the empty monthly sheet for the site.

## Compare the paper with the rows and close the sheet
id: reconcile-sheet
roles: Admin, Accountant
screens: paper-sheets
open: paper-sheets
keywords: reconcile compare match mismatch close sheet close month paper check signatures
related: upload-signed-sheet, reopen-sheet

Check the signed paper against the recorded rows, then close the sheet for the month.

1. Open the sheet in **Paper sheets**, with the scan next to the rows.
2. Mark each row **Matches** or **Different** (say what is different).
3. Tap **Close month**, type the **Site engineer** and the **Vendor representative** names, then **Close sheet**.

Note: Matching is recommended but does not block payment, and it does not make a batch stale.

## Reopen a closed sheet
id: reopen-sheet
roles: Admin
screens: paper-sheets
open: paper-sheets
keywords: reopen closed sheet unlock sheet
related: reconcile-sheet

Only the Admin can reopen a closed monthly sheet.

1. Open the closed sheet in **Paper sheets**.
2. Tap **Reopen** and write the reason.

## Create the monthly invoice batch
id: create-invoice-batch
roles: Admin, Accountant
screens: invoices
open: invoices
popular: Admin, Accountant
keywords: invoice payroll batch generate month end vendor statement pay vendor calculate preview new invoice
related: fix-blockers, finalize-batch, monthly-machine-exception

At the month end the accountant calculates the vendors' invoices from the approved days.

1. Open **Invoice** and tap **New invoice batch**.
2. **Scope**: period (From / To), the vendor (or all), the site, the currency.
3. With a vendor chosen, tick its machines (**Select all ready**).
4. Tap **Calculate preview**: amounts per machine, and the problems to fix (blockers).
5. Fix the blockers, calculate again, then tap **Generate batch**.

- One batch per currency: USD and SYP make two batches.
- **Generate anyway** leaves the open rows out (they go to a later batch) and needs a reason. Fix the problems first.

## Fix what blocks the invoice
id: fix-blockers
roles: Admin, Accountant
screens: invoices, attendance-review, fuel-adjustments, paper-sheets
open: invoices
popular: Accountant
keywords: blockers problems cannot generate blocked not approved fuel unpriced standby hours missing scan open session
related: create-invoice-batch, approve-attendance, price-fuel, standby-hours-monthly

The preview lists what must be fixed, with where to fix it:

- Rows not approved → **Attendance review** (Admin approves).
- Anomaly not acknowledged → **Attendance review**.
- Fuel without a price → **Fuel & adjustments** → **Fuel issues**.
- Official fuel price missing → **Fuel & adjustments** → **Fuel prices**.
- Standby hours not set (monthly machine) → **Attendance review** → **Set hours**.
- Machine still checked in → the supervisor must check it out.
- Signed sheet missing → **Paper sheets** → **Upload scan**.
- A monthly machine with no row on a working day → it is deducted as a full absence.

## Monthly machine: exception for one month
id: monthly-machine-exception
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: monthly exception month amount days divided by hourly price 27 days 26 days special month
related: monthly-machine-rules, create-invoice-batch

When one machine's month is billed differently (e.g. the vendor is paid on the 27th day).

1. In **New invoice batch**, choose the vendor and the machine.
2. In **Monthly machines: normal month or exception**, type the amount of the month, the days it is divided by, or the hourly price.
3. Calculate the preview.

Note: It cannot change while a batch (even a draft) bills that month: void the draft first.

## How monthly machines are paid
id: monthly-machine-rules
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: monthly machine rules full month missing hours deduction absence extra hours overtime hourly price
related: extra-hours-cover, standby-hours-monthly, monthly-machine-exception

The rules used to bill machines rented by the month.

- A normal month pays the full monthly price, whatever the number of working days.
- Hourly price = monthly price ÷ working days of the month ÷ hours per day.
- Every working day has its hours (e.g. 10). An absence or a day with no row is deducted in full; a short day loses the missing hours.
- Breakdown (the vendor's fault) is deducted by the breakdown % and never covered.
- Extra hours, or work on the weekly day off, are extra hours. They do not cover missing hours unless the Admin decides it.

## Let extra hours cover missing hours
id: extra-hours-cover
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: extra hours cover missing hours offset overtime compensate admin decision
related: monthly-machine-rules

Only the Admin decides, per machine and month, before finalizing.

1. In the preview (or the draft batch), find the monthly machine.
2. Tick **COVER the missing hours (Admin decision)**.
3. Yes: each extra hour covers a missing hour. No: missing hours are deducted and extra hours are paid as overtime (if overtime is on).

Note: An hour is either used to cover or paid as overtime, never both.

## Finalize a batch (issue the invoice numbers)
id: finalize-batch
roles: Admin, Accountant
screens: invoices
open: invoices
popular: Admin
keywords: finalize lock close batch invoice numbers official approve invoice issue numbers
related: undo-finalize, mark-batch-paid, stale-batch

Finalize issues the official invoice numbers: one per vendor, one per machine, and one for the fuel difference.

1. Open **Invoice** and open the draft batch.
2. Check it. If it says changes since it was calculated, tap **Recalculate** first.
3. Tap **Finalize** and confirm.

- After this, the days of the period cannot change, and no fuel, adjustment or deployment can be added there, except by an official correction.
- By default only the Admin can finalize.

## Undo a Finalize
id: undo-finalize
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: undo finalize unfinalize mistake back to draft reopen batch
related: finalize-batch, official-correction

Within a few hours (setting, 72 by default) and while nothing was paid or corrected, a finalized batch can go back to a draft with the same invoice numbers.

1. Open the batch and tap **Undo Finalize** (it shows the time left).
2. Write the reason. An Admin does it at once; an accountant's request waits for the Admin.

Note: After that time, use an official correction.

## Mark a batch as paid
id: mark-batch-paid
roles: Admin, Accountant
screens: invoices
open: invoices
popular: Admin
keywords: mark paid paid payment pay batch paid done settle transfer cheque
related: record-payment, finalize-batch

After the money is paid, mark the finalized batch as paid.

1. Open **Invoice** and open the finalized batch.
2. Tap **Mark paid**, add the payment reference (bank transfer / cheque no.) if you have it, and confirm.

- **Undo mark paid** is possible for a limited time (setting).
- Paying part of it? Use **Record payment** instead.

## Record a partial payment
id: record-payment
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: partial payment record payment pay part of batch partly paid some advance installment voucher remaining balance
related: mark-batch-paid, reverse-payment, vendor-statement

Record each payment to a vendor when you pay in several parts.

1. Open the finalized batch and find the vendor.
2. Tap **Record payment**: amount, **Method** (cash, bank transfer, cheque), **Payment date**, reference.
3. Save. **Open voucher** prints the payment voucher. When nothing is left, the batch becomes Paid by itself.

## Reverse a payment
id: reverse-payment
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: reverse payment wrong payment cancel payment undo payment voucher reversed
related: record-payment

Undo a payment recorded by mistake. Nothing is deleted.

1. Open the batch, find the payment and tap **Reverse**.
2. Write why (printed on the voucher). The voucher is kept and marked REVERSED; the amount is owed again.

Note: An accountant can reverse their own payment within a limited time; after that, only the Admin.

## Void a batch or make a new version
id: void-or-new-version
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: void cancel batch new version supersede regenerate wrong batch redo
related: stale-batch, finalize-batch, approve-batch-request

What to do when a batch is wrong depends on how far it went.

- Draft batch with a mistake: **Void** it and generate again, or **Recalculate**.
- Finalized, not paid: **New version** replaces it. The old invoice numbers are kept but marked cancelled.
- Paid: not possible. Use an official correction.

An accountant sees **Ask to void** / **Ask for new version**: the Admin approves it first.

## A batch says it changed (stale)
id: stale-batch
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: stale changed recalculate outdated changes since calculated cannot finalize
related: void-or-new-version, finalize-batch

Something that moves money changed after the draft was calculated: hours, fuel, an adjustment, a price or a setting.

1. Open the batch: it lists the changes.
2. Tap **Recalculate** (or Void and generate again). It cannot be finalized before.

Note: Paper matching and notes do not make a batch stale.

## Approve an accountant's request on a batch
id: approve-batch-request
roles: Admin
screens: invoices
open: invoices
keywords: approve request accountant request void request new version request undo finalize waiting admin
related: void-or-new-version, undo-finalize

When only the Admin closes invoices, the accountant's void, new version or undo requests wait for you.

1. Open **Invoice** and open the batch with a waiting request.
2. Read the reason, then tap **Approve** (it runs now, in your name) or **Reject**.

## PDFs, Excel and statements of a batch
id: export-batch
roles: Admin, Accountant
screens: invoices
open: invoices
keywords: pdf excel export print statement vendor invoice machine invoice fuel difference statement download
related: vendor-statement

Every document of a batch: vendor invoices, machine invoices, fuel difference, summary and Excel.

1. Open **Invoice** and open the batch.
2. Use **Summary PDF**, **Vendor invoice PDF**, **Machine invoice**, **Fuel difference statements** or **Excel**.
3. Before the vendor PDF opens, choose what it shows (daily table, hours calculation, notes...). Items, amounts and totals are always shown.

## Vendor statement of account
id: vendor-statement
roles: Admin, Accountant
screens: vendors, machines
open: vendors
keywords: statement of account balance owed vendor account history ledger billing history provisional statement
related: record-payment, opening-balance

Everything we billed and paid a vendor, and what we still owe.

1. Open **Vendors**, open the vendor, and tap **Statement of account**: every invoice, payment and note, with the balance owed.
2. **Provisional statement** shows what the next invoice would contain.
3. For one machine: **Machines** → open it → **Billing history**.

## Official correction after a batch is finalized
id: official-correction
roles: Admin, Accountant
screens: attendance-review, fuel-adjustments, invoices
open: attendance-review
keywords: official correction debit note credit note dn cn mistake finalized paid locked fix after finalize
related: edit-attendance-row, undo-finalize

A finalized invoice never changes. The difference is settled with a debit note (DN, the vendor gets more) or a credit note (CN, for us).

1. In **Attendance review**, open the row and tap **Official correction**. Choose what changes and write the reason.
2. An Admin's correction is applied at once. An accountant's goes to the Admin.
3. Follow it in **Fuel & adjustments** → **Corrections**: review, set another amount with a reason, **Approve**, **Return** or **Cancel**.
4. On approval it issues a DN-… or CN-… number and an adjustment in the first open period.

Tip: Fuel or amount mistakes: open the paid batch, then the machine, then **Official correction**.
