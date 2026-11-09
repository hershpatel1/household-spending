Household Money
Hersh and Sonali's household money app: spending log, regular payments, month-end reconciliation, and a forecast of every pot to July 2030.
Live at https://hershpatel1.github.io/household-spending/
What's here
File	What it is
`index.html`	The whole app: one page (HTML, CSS and JavaScript), hosted by GitHub Pages
`README.md`	This file
`tests/`	Automated checks: the app runs in a headless browser against an in-memory copy of Firebase (never the real data)
The app talks straight to the Firebase project `household-budget-e2592` (Firestore and anonymous sign-in). No bank details are stored anywhere.
Screens
Home: month-end status, float, next 14 days (tick regular payments or enter an estimate's actual as you go), actions and one-offs to pay, budgets (month or year to date), Household Investment (with spare cash: Joint's lowest point over the next 12 months less a £1,000 buffer).
Log: spend, refund, income (with bonus), transfer (including to a pension or between ISAs).
Transactions: bank-style feed with filters, and a Ledger per account (Joint, Hersh and Sonali debit and credit) with a running total of logged transactions plus regular payments, expected or confirmed.
Plan: regular payments by account, budgets, one-offs, and the forecast against the saved plan.
Log > Payslip: record a payslip once (net pay, taxable pay to date and this period); Month-end has it waiting. Month-end can also fill the current-account balances from the Ledger (check them against your bank apps).
Month-end: tick regular payments (Commuting is calculated from transactions logged under the Commuting budget), payslips and the £99,000 test, tie each current account to £0.00, record mortgage, ISAs and pensions, next month's moves.
Data (Firestore collections)
`transactions`, `budgets`, `annualBudgets` (shared with the original app), and `plan_items`, `actions`, `planned_payments`, `budget_rules`, `month_ends`, `v2meta` (opening balances, seed version, the saved plan).
Testing
Run before every change goes live:
```
cd tests
npm install
npx playwright install chromium   # first time only
npm test
```
It covers: seeding, logging and the transaction feed, the set-up month with pending items, a full month-end tying out to £0.00, the £99,000 test with an early pension payment, paying and un-paying one-offs, locked closed months, and the forecast. Any failure exits with an error.
Behaviour worth knowing
Saves are held on the phone when offline and sync when the signal returns.
A month that has been closed is locked: transactions dated in it can't be added, edited or deleted until it is reopened in Month-end.
Recent errors are kept on the phone and shown under "App diagnostics" at the foot of Home.
History
The original spending tracker is preserved in the history at commit `8830b7e` ("Update index.html"), the last commit before the rebuild.
