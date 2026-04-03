# Dune Server 🗄️

The **Dune Server** is the central backend hub for the Dune game save ecosystem. It safely receives, stores, and manages game save backups uploaded from both the Dune desktop client and the Playnite add-on.

## Architecture
- **Backend:** A robust host server handling incoming API requests, metadata parsing, and file storage.
- **Frontend Dashboard:** A web-based user interface (`frontend`) hosted by the server to view, search, and manage your synced game saves visually.
- **Containerized:** Fully Dockerized for guaranteed environment parity and straightforward, zero-configuration deployments.

## Quick Start (Docker)

1. **Deploy with Docker Compose:**
   Navigate to the repository root and start the server natively:
   ```bash
   docker-compose up -d --build
   ```

2. **Access the Dashboard:**
   The server binds to port `3023` by default. You can access the Dune web dashboard by navigating to:
   ```text
   http://localhost:3023
   ```

## Persistent Storage
Game save backups and metadata are persistently stored via a Docker volume mounted to `./data` in the host directory. This ensures your progress is never lost even if the container drops.
