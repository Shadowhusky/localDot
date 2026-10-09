.PHONY: build test deploy deploy-dry-run

build:
	CGO_ENABLED=1 go build -trimpath -o bin/keyd ./cmd/keyd
	CGO_ENABLED=1 go build -trimpath -o bin/keyd-native ./cmd/keyd-native

test:
	go test ./...

# Builds, signs, verifies, self-tests and switches the hand-run keyd; see README.md.
deploy:
	scripts/deploy.sh

deploy-dry-run:
	scripts/deploy.sh --dry-run
