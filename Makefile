SHELL := /bin/sh

NPM ?= npm
COMPOSE ?= docker compose

.PHONY: install dev lint typecheck format test test-unit test-integration build migrate up down logs check clean

## Install exactly the locked dependency tree
install:
	$(NPM) ci

## Run the server with hot reload (tsx)
dev:
	$(NPM) run dev

## ESLint with --max-warnings=0
lint:
	$(NPM) run lint

## TypeScript without emitting
typecheck:
	$(NPM) run typecheck

## Prettier check
format:
	$(NPM) run format:check

## Unit tests (no database, no network)
test: test-unit

test-unit:
	$(NPM) run test:unit

test-integration:
	$(NPM) run test:integration

build:
	$(NPM) run build

## Apply pending migrations
migrate:
	$(NPM) run migrate

## Start PostgreSQL + the application
up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f app

## lint + typecheck + unit tests + integration tests + build
check:
	bash scripts/check.sh

clean:
	$(NPM) run clean
