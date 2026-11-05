.PHONY: all test test-backend test-frontend build-backend build-frontend run-backend run-frontend clean

all: test build-backend build-frontend

test: test-backend test-frontend

test-backend:
	cd apps/server && go test -v ./...

test-frontend:
	cd apps/web && npm test -- --run

build-backend:
	cd apps/server && go build -o bin/senora-server ./cmd/server

build-frontend:
	cd apps/web && npm run build

run-backend:
	cd apps/server && go run ./cmd/server

run-frontend:
	cd apps/web && npm run dev
