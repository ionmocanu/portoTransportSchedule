# Use a lightweight version of Node.js
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy all your files from your local folder into the container
COPY . .

# IMPORTANT: If your server uses a specific port (e.g., 3000), expose it here
EXPOSE 3000

# Tell Docker how to start your app
CMD ["node", "server.js"]