# Example agreement templates

**EXAMPLE, not legal text.** These two Word files exist so the agreement flow can be tried on a
developer's machine. Konnected writes the real agreements and a lawyer reviews them; the real
templates are uploaded in the app (Team, Agreement templates), never committed here.

- `example-company-agreement.docx`: Konnected and a company, one per project.
- `example-student-agreement.docx`: Konnected and a student, one per match.

`pnpm seed` uploads and publishes them when no template of that kind is published yet.

## Fields

A template puts a field where a value from the project should go, with double braces:
`{{project.title}}`. Only the fields listed in `src/lib/agreements/fields.ts` are accepted (the
team screen shows the list with a description of each); any other field, a loop or a condition is
refused at upload, and the screen says which one. A field without a value stops the agreement from
being made and tells the team which value is missing.

The company agreement cannot use student fields, and the student agreement cannot use the
company's price.

## Trying it locally

1. `docker compose up -d gotenberg` (the PDF converter, port 3400) and set
   `GOTENBERG_URL=http://127.0.0.1:3400`.
2. `pnpm seed`, then `pnpm dev`.
3. As the team: Agreements, make the company agreement of an approved project. As the company:
   Agreements, open it, read the PDF, tick, type your name, sign. As the team: sign for Konnected.
   The signed PDF goes to both by email (Mailpit at http://localhost:8025).
