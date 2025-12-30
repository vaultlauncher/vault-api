@echo off
docker buildx create --use --name multiarch-builder 2>nul || docker buildx use multiarch-builder

docker buildx build --platform linux/amd64 -t vault-api:latest --load .

docker buildx rm multiarch-builder
