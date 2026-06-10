#!/bin/bash
# Runs once on first container start via /docker-entrypoint-initdb.d/
# Creates per-database users and schemas.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER todo WITH PASSWORD '${MINI_POSTGRES_TODO_PASSWORD}';
    CREATE DATABASE todo OWNER todo;
    CREATE USER agent_kb WITH PASSWORD '${AGENT_KB_PASSWORD}';
    CREATE DATABASE agent_kb OWNER agent_kb;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "todo" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "agent_kb" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

# Fresh-install bootstrap only — existing instances: provisioned via Tofu in Phases 3/4
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER hatchet WITH PASSWORD '${HATCHET_POSTGRES_PASSWORD}';
    CREATE DATABASE hatchet OWNER hatchet;
    CREATE USER mem0 WITH PASSWORD '${MEM0_POSTGRES_PASSWORD}';
    CREATE DATABASE mem0 OWNER mem0;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "hatchet" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "mem0" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL
