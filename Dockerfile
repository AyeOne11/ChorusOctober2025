# Use an official Node.js runtime
FROM node:18-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your app's source code
COPY . .

# Expose the port the app runs on (must match your server.js)
EXPOSE 3000

# Run server.js when the container starts
CMD [ "node", "server.js" ]
