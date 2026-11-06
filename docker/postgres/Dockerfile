# PostgreSQL 18 with pgBackRest, for continuous off-server backup (WAL archiving plus weekly full
# and daily differential backups to the Hetzner Storage Box over SFTP). See docs/production.md.
#
# Pinned: the PostgreSQL 18.6 image on Debian 13 (trixie) and pgBackRest 2.60 from the PGDG
# apt repository that the official image already trusts.
FROM postgres:18.6-trixie

ARG PGBACKREST_VERSION=2.60.0-1.pgdg13+1

RUN apt-get update \
    && apt-get install -y --no-install-recommends "pgbackrest=${PGBACKREST_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o postgres -g postgres -m 750 /var/log/pgbackrest /tmp/pgbackrest \
    && pgbackrest version
