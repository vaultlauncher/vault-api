#!/bin/bash

set -e

CONTAINER_NAME="vault-api"
IMAGE_NAME="vault-api"
PORT="3000"

echo "🔄 Pulling latest code..."
git pull

echo "🛑 Stopping and removing old container (if exists)..."
sudo docker stop $CONTAINER_NAME || true
sudo docker rm $CONTAINER_NAME || true

echo "🧱 Building new Docker image..."
sudo docker build -t $IMAGE_NAME .

echo "🚀 Starting new container with auto-restart..."
sudo docker run -d \
  --name $CONTAINER_NAME \
  -p ${PORT}:${PORT} \
  --restart unless-stopped \
  $IMAGE_NAME

echo "✅ Done! Container is running:"
sudo docker ps | grep $CONTAINER_NAME
