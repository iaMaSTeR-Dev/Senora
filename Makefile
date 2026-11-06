.PHONY: all test test-backend test-frontend build-backend build-frontend run-backend run-frontend clean

all: build-backend build-frontend

test: test-backend test-frontend

test-backend:
	cd apps/server && go vet ./...

test-frontend:
	cd apps/web && npx tsc --noEmit

build-backend:
	cd apps/server && go build -o bin/senora-server ./cmd/server

build-frontend:
	cd apps/web && npm run build

run-backend:
	cd apps/server && go run ./cmd/server

run-frontend:
	cd apps/web && npm run dev
