# Rolling back a deploy

## A deploy that fails rolls itself back

`deploy.sh` changes nothing for users until the new app container is healthy. If the migrations
fail, or the new container never passes `/api/health`, the script removes the new container and
exits with an error. The old container kept serving the whole time. Read the error, fix, deploy
again.

A migration that failed half-way can leave the schema changed. Payload runs each migration in a
transaction, so a failed one is normally undone; check with
`docker compose ... run --rm migrate node node_modules/payload/bin.js migrate:status`.

## Going back to the previous image

The image that ran before the last deploy is in `release.env.previous`:

```bash
cd /opt/konnected
cat release.env.previous                      # APP_IMAGE=ghcr.io/<owner>/konnect-webb-app:<sha>
SKIP_MIGRATIONS=1 scripts/deploy/deploy.sh <that image or its sha>
```

This is the same zero-downtime swap, in the other direction. `SKIP_MIGRATIONS=1` because the older
image has no newer migrations to run.

## What a rollback does not undo

Rolling back the image does not roll back the database. Migrations only move forward, so every
migration must be backward compatible (expand, then contract):

- Release N adds columns or tables and writes to both the old and the new shape. The old image
  still works on that schema, which is what makes the swap and a rollback safe.
- Release N+1, deployed once N is known to be good, stops using the old shape and drops it.
- Never rename or drop something the running image still reads in the same release.

If data itself must go back (a migration destroyed or corrupted it), restore the database to a
point just before the deploy with pgBackRest point-in-time recovery. `deploy.sh` took an
incremental backup right before the migrations, and WAL is archived every minute. This loses
everything written after that moment, so it is a decision for the team, not a routine step. Do
it on a stopped stack: stop app and worker, then run `pgbackrest restore --delta --type=time
--target="<timestamp>" --target-action=promote` in a container with the PostgreSQL volume and the
backup settings (as in the `restore-test` service), start PostgreSQL, check, then deploy the image
that matches that schema. Practise it with `restore-test.sh` first.

## Never

- Do not run `payload migrate:down` on production without a tested `down` and a fresh backup.
- Do not deploy an image tag other than a full commit SHA. Tags such as `latest` move.
