.PHONY: all check check-backend check-frontend build-backend build-frontend run-backend run-frontend

all: check build-backend build-frontend

check: check-backend check-frontend

check-backend:
	cd apps/server && go vet ./...

check-frontend:
	cd apps/web && npx tsc --noEmit

build-backend:
	cd apps/server && go build -o bin/senora-server ./cmd/server

build-frontend:
	cd apps/web && npm run build

run-backend:
	cd apps/server && go run ./cmd/server

run-frontend:
	cd apps/web && npm run dev
