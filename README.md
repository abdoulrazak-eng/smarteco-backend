# 🌿 SmartEco AI Backend

> Smart Waste Management Platform for Rwanda — Backend API

[![NestJS](https://img.shields.io/badge/NestJS-11-ea2845?logo=nestjs)](https://nestjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma)](https://www.prisma.io/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

SmartEco AI enables residents and businesses in Rwanda to schedule waste pickups, track collectors in real-time, manage IoT smart bins, earn EcoPoints rewards, and make mobile money payments — all from a single platform.

---

## ✨ Features

- **🔐 OTP Authentication** — Phone-based login with JWT access + refresh tokens
- **📅 Pickup Scheduling** — Book waste collection with preferred time slots
- **📍 Real-Time Tracking** — Track collector location via WebSocket
- **🗑️ Smart Bin Management** — IoT-connected bins with fill-level monitoring
- **⭐ EcoPoints Rewards** — Earn points for every pickup, tier-based multipliers
- **🤝 Referral System** — Invite friends, earn bonus EcoPoints
- **💰 Mobile Payments** — MTN MoMo & Airtel Money integration
- **📢 Notifications** — Push (Firebase), SMS, WhatsApp, and in-app
- **👨‍💼 Admin Dashboard** — System management and analytics

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS 11 (TypeScript) |
| Database | PostgreSQL 16 |
| ORM | Prisma 7 |
| Auth | JWT + Passport |
| Docs | Swagger / OpenAPI |
| Real-time | Socket.io |
| Queue | BullMQ + Redis |
| Payments | MTN MoMo, Airtel Money |
| SMS | Africa's Talking |
| Push | Firebase Cloud Messaging |

## 📁 Project Structure

```
src/
├── common/                 # Shared utilities
│   ├── constants/          # App-wide constants
│   ├── decorators/         # @CurrentUser, @Roles
│   ├── dto/                # PaginationDto, ApiResponseDto
│   ├── filters/            # Global exception filter
│   ├── guards/             # RolesGuard
│   └── interceptors/       # Response transform interceptor
├── config/                 # Configuration & validation
├── database/               # Prisma schema, service & module
├── modules/
│   ├── auth/               # OTP, JWT, login/register
│   ├── users/              # Profile, referrals, FCM
│   ├── pickups/            # Waste pickup scheduling
│   ├── bins/               # Smart bin CRUD
│   ├── eco-points/         # Rewards & tier system
│   ├── collectors/         # Collector management
│   ├── payments/           # Mobile money transactions
│   ├── notifications/      # Multi-channel notifications
│   └── admin/              # Admin operations
├── jobs/                   # Background job queues
├── websocket/              # Real-time tracking gateway
├── app.module.ts
└── main.ts
```

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **PostgreSQL** ≥ 14
- **Redis** (optional, for queues)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/smarteco-backend.git
cd smarteco-backend

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your actual values
```

### Database Setup

```bash
# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate dev

# (Optional) Seed the database
npx prisma db seed
```

### Run the Server

```bash
# Development (watch mode)
npm run start:dev

# Production build
npm run build
npm run start:prod
```

The API will be available at `http://localhost:3000` and Swagger docs at `http://localhost:3000/api/docs`.

## 🔑 Environment Variables

Copy `.env.example` and fill in your values:

```env
# App
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user@localhost:5432/smarteco

# JWT
JWT_SECRET=your-secret-here
JWT_REFRESH_SECRET=your-refresh-secret-here

# See .env.example for all available variables
```

> ⚠️ **Never commit `.env` to version control.** The `.env.example` file contains placeholder values for reference.

## 📚 API Documentation

Once the server is running, visit **[http://localhost:3000/api/docs](http://localhost:3000/api/docs)** for interactive Swagger documentation.

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/auth/otp/send` | Send OTP to phone |
| `POST` | `/api/v1/auth/otp/verify` | Verify OTP & get tokens |
| `POST` | `/api/v1/auth/refresh` | Refresh access token |
| `GET` | `/api/v1/users/me` | Get user profile |
| `PATCH` | `/api/v1/users/me` | Update profile |
| `GET` | `/api/v1/users/me/referral` | Get referral stats |

### Response Format

All responses follow a consistent format:

```json
{
  "success": true,
  "message": "Optional message",
  "data": { ... },
  "meta": { "page": 1, "limit": 10, "total": 100, "totalPages": 10 }
}
```

## 🧪 Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## 🧑‍💻 Development Notes

- **Sandbox OTP**: In development mode, OTP is always `123456`
- **API Prefix**: All routes are prefixed with `/api/v1`
- **Validation**: Global `ValidationPipe` with whitelist enabled
- **Error Handling**: Global `HttpExceptionFilter` for consistent error responses

## 📄 License

This project is licensed under the MIT License.

---

Built with 💚 for a cleaner Rwanda 🇷🇼
