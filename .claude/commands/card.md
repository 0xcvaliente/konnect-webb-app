---
description: Start work on one Technical Kanban card - fetch it, make its branch, set it In Progress, show what done means
argument-hint: <Notion card URL or title>
---

Start work on this Technical Kanban card: $ARGUMENTS

1. Use the `notion-konnect` MCP server only (konnected-notion-workflow skill). If $ARGUMENTS is a title, search the Technical Kanban data source `9df9048f-f231-421e-8a0d-a71869aabb91` for it; if several match, list them and stop.
2. Fetch the card. Show its Goal, Acceptance criteria, Out of scope and Depends on. If a card it depends on is not Done, say so and stop.
3. Check the working tree is clean. Make a branch from the latest `origin/main`: `feat/<short-name>` from the card title (lowercase, hyphens, at most 4 words). Never work on `main`.
4. Set the card's Status to `In Progress` (the one Notion write allowed without asking), and put the branch name in `PR / Branch` only once a pull request exists.
5. Read the skills the card needs (always konnected-product-rules first) and list the files you expect to touch.
6. Stop and show the plan. Build only after the user says go. The card is done only when every acceptance criterion passes and `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
