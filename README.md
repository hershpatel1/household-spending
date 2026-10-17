# Household Money

Hersh and Sonali's household money app: spending log, regular payments, month-end reconciliation, and a forecast of every pot to July 2030.

Live at https://hershpatel1.github.io/household-spending/

## What's here

| File | What it is |
|---|---|
| `index.html` | The whole app: one page (HTML, CSS and JavaScript), hosted by GitHub Pages |
| `README.md` | This file |

The app talks straight to the Firebase project `household-budget-e2592` (Firestore and anonymous sign-in). No bank details are stored anywhere.

## Screens

- **Home**: month-end status, float, next 14 days, actions and one-offs to pay, budgets (month or year to date), Household Investment.
- **Log**: spend, refund, income (with bonus), transfer (including to a pension or between ISAs).
- **Transactions**: bank-style feed with filters.
- **Plan**: regular payments by account, budgets, one-offs, and the forecast against the saved plan.
- **Month-end**: tick regular payments, payslips and the £99,000 test, tie each current account to £0.00, record mortgage, ISAs and pensions, next month's moves.

## Data (Firestore collections)

`transactions`, `budgets`, `annualBudgets` (shared with the original app), and `plan_items`, `actions`, `planned_payments`, `budget_rules`, `month_ends`, `v2meta` (opening balances, seed version, the saved plan).

## History

The original spending tracker is preserved in the history at commit `8830b7e` ("Update index.html"), the last commit before the rebuild.
