# Use an official Node.js runtime (use a version >= 18)
FROM node:18-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first for better caching
COPY package*.json ./

# Install app dependencies (including native ones needed for pg/Cloud SQL)
RUN apt-get update && apt-get install -y procps && rm -rf /var/lib/apt/lists/*
RUN npm install --omit=dev

# Copy the rest of your application code
COPY . .

# Cloud Run provides the PORT environment variable
# EXPOSE 8080 # Not strictly needed as Cloud Run uses the PORT variable

# Command to run the application
CMD [ "node", "server.js" ]