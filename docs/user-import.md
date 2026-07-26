# Safe user imports

`scripts/import-users-csv.ts` imports users from CSV, XLS, or XLSX files for any active organization. It performs the investigation as a mandatory dry-run preflight and writes nothing unless `--insert` and an exact organization-code confirmation are both supplied.

## Accepted columns

The importer recognizes common header variants, including the legacy `Deparment` and `Eamil` spellings.

- Required: `Email`, `Role`, and either `First Name` + `Last Name` or `Name`.
- Branch-scoped roles: `Branch`/`Department`/`Location` is required for `BRANCH_ADMIN` and `ORDER_PORTAL`.
- Username: uses `Username`/`Login Code`; otherwise an organization config may opt into lowercase `first.last` generation. Spaces and punctuation inside each name part are removed.
- Password: accepts a compliant `Password`, or `--generate-passwords` can create a secure temporary password.
- Optional: `Phone`, `Employee ID`, `Address`, and account `Status` (`active`/`inactive`). Unknown status values are reported and ignored.

Role values such as `Head Office`, `Branch Admin`, and `Order Portal` are normalized to database role names. `SUPER_ADMIN` cannot be bulk imported.

## Workflow

Run a dry run first:

```powershell
npx tsx scripts/import-users-csv.ts `
  --file "C:\path\users.xlsx" `
  --organization ORG_CODE `
  --overrides config\organization-user-import.json `
  --generate-passwords `
  --send-welcome
```

The preflight checks the organization, roles, active branches, explicit branch overrides, workbook duplicates, and conflicts across both `users` and legacy `employee_credentials`. Matching users in the same organization are reported as already existing and are not updated or duplicated. Any ambiguous identity conflict blocks the whole live import.

If the file has no explicit Username column, imports are blocked unless its organization-bound config explicitly sets `"usernameFormat": "first.last"`. A combined `Name` column is split at the first space: the first word becomes first name and the remainder becomes last name. Username collisions within the file or database remain blocking errors.

After reviewing a clean dry run, add `--insert --confirm ORG_CODE`. New users are inserted in one serializable transaction, receive `mustChangePassword=true`, and are audit logged. Generated passwords are never printed. Choose exactly one credential delivery method: `--send-welcome`, or `--credentials-output tmp\organization-user-credentials.xlsx` for a local handoff workbook. The output file is created before the transaction and removed automatically if the transaction fails; `tmp/` is gitignored.

Branch matching is deliberately exact after trimming/case normalization. Put intentional differences in an organization-bound override file; the importer refuses to apply that file to another organization. The same file can define `allowedEmailDomains` so plausible but mistyped domains are blocked before welcome emails are sent. See `config/user-import-overrides.example.json`.

If a welcome email fails after commit, the script reports only the workbook row number. Reset that account's password before giving the user access.
