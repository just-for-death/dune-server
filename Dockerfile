FROM node:20-alpine

# Security: Upgrade Alpine packages to patch vulnerabilities
RUN apk update && apk upgrade --no-cache && apk add --no-cache unzip

WORKDIR /app

# Setup backend env
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev

# Copy everything
COPY backend/ ./backend/
COPY frontend/dist/ ./backend/frontend/dist/

# Ensure data directory exists
RUN mkdir -p /app/backend/data

WORKDIR /app/backend

ENV PORT=3030
EXPOSE 3030

CMD ["npm", "start"]
