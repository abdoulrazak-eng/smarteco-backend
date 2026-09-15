# SmartEco AI Backend - Local Setup Guide

Welcome to the SmartEco AI backend project! This guide provides step-by-step instructions for running the server on a new device.

Our application stack consists of:
- **Node.js**: Runtime environment
- **NestJS**: Backend framework
- **PostgreSQL**: Primary database (LocalDB)
- **Prisma**: Object-Relational Mapper (ORM)
- **Redis**: Caching and background job queues

## 1. Prerequisites

Before you start, ensure you have the following installed on your machine:
- [Node.js](https://nodejs.org/en) (v18.0.0 or higher) - *Check with `node -v`*
- [PostgreSQL](https://www.postgresql.org/) (v14 or higher) - *Check with `psql -V`*
- [Redis](https://redis.io/) - *Check with `redis-cli ping`*

> **Note on LocalDB**: Ensure your local PostgreSQL service is running. You will need to create an empty database (e.g., `smarteco`) before running migrations.

## 2. Install Dependencies

1. Clone or get access to the repository on your device and navigate into the backend folder:
   ```bash
   cd smarteco-backend
   ```
2. Install the necessary project packages:
   ```bash
   npm install
   ```

## 3. Configure Environment Variables

The project uses environment variables for configuration. You need to create a local `.env` file based on the provided example.

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and update the `DATABASE_URL` to match your local PostgreSQL credentials:
   ```env
   # Format: postgresql://[USER]:[PASSWORD]@[HOST]:[PORT]/[DATABASE]
   DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/smarteco
   ```
3. Update `REDIS_HOST` and `REDIS_PORT` if your Redis isn't running on defaults.

## 4. Setup Prisma & Database

Prisma requires you to generate the client based on your schema and sync the schema with your local PostgreSQL database.

1. **Generate the Prisma Client**:
   This generates the TypeScript types based on your schema.
   ```bash
   npx prisma generate
   ```

2. **Run Migrations (db push)**:
   This will synchronize your Prisma schema with your local database engine.
   ```bash
   # Use 'npx prisma migrate dev' to create new migration history, 
   # or 'npx prisma db push' to quickly sync your dev schema
   npx prisma migrate dev 
   ```
   *(If you have a seed file configured, this will also seed your local database)*

## 5. Start the Server

Once your dependencies are installed, environment variables are set, and your database is configured, you're ready to spin up the NestJS server.

```bash
# Start in development/watch mode (best option for local dev)
npm run start:dev

# Or run standard start
npm run start
```

## 6. Verify Installation

If everything launched successfully, you will see output that the Nest application successfully started, typically mapped to port `3000`.

To verify:
- Open your browser and navigate to the Swagger API Documentation:
  👉 **[http://localhost:3000/api/docs](http://localhost:3000/api/docs)**
  
You should see the complete API reference structure documented!

## Common Issues & Troubleshooting

- **Error: Can't reach database server**: Double-check your `DATABASE_URL` username, password, host, and ensure the PostgreSQL service is actively running on your machine.
- **Error: PrismaClient is not found**: Run `npx prisma generate` again and restart your server.
- **Error: ECONNREFUSED 127.0.0.1:6379**: Ensure that your Redis server is running locally.
