import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters';
import { TransformInterceptor } from './common/interceptors';
import { API_PREFIX, SWAGGER_PATH } from './common/constants';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // ─── Global Prefix ────────────────────────────────
  app.setGlobalPrefix(API_PREFIX);

  app.enableCors({
    origin: [
      'https://smarteco.rw',
      'http://smarteco.rw',
      'https://www.smarteco.rw',
      'http://www.smarteco.rw',
      'https://admin.smarteco.rw',
      'http://admin.smarteco.rw',
      'https://smarteco-admin-panel-nine.vercel.app',
      'http://localhost:3000',
      'http://localhost:3001',
      /https:\/\/.*\.ngrok-free\.app$/,
      /https:\/\/.*\.ngrok-free\.dev$/,
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'ngrok-skip-browser-warning',
    ],
    credentials: true,
  });

  // ─── Global Validation Pipe ───────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip non-whitelisted properties
      forbidNonWhitelisted: true, // Throw error on extra properties
      transform: true, // Auto-transform payloads to DTO instances
      transformOptions: {
        enableImplicitConversion: true, // Convert query string params
      },
    }),
  );

  // ─── Global Exception Filter ──────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());

  // ─── Global Response Transform Interceptor ────────
  app.useGlobalInterceptors(new TransformInterceptor());

  // ─── Swagger / OpenAPI ────────────────────────────
  const config = new DocumentBuilder()
    .setTitle('Ejova API')
    .setDescription(
      `
## Smart Waste Management Platform API

Ejova enables residents and businesses in Rwanda to:
- 📅 Schedule waste pickups
- 📍 Track collectors in real-time
- 🗑️ Manage IoT Smart Bins
- ⭐ Earn EcoPoints rewards
- 💰 Make mobile payments (MTN MoMo / Airtel Money)

### Authentication
All authenticated endpoints require a Bearer token in the Authorization header.
Use the \`/auth/otp/send\` and \`/auth/otp/verify\` endpoints to obtain tokens.

### Response Format
All responses follow a consistent format:
\`\`\`json
{
  "success": true,
  "message": "Optional message",
  "data": { ... },
  "meta": { "page": 1, "limit": 10, "total": 100, "totalPages": 10 }
}
\`\`\`

### Role-Based Access
- **USER** — Default role. Can manage own pickups, bins, points, and payments.
- **COLLECTOR** — Can view assigned pickups and update status/location.
- **ADMIN** — Full access to all data, analytics, and user management.
    `,
    )
    .setVersion('1.0.0')
    .setContact(
      'Ejova Engineering',
      'https://smarteco.rw',
      'api@smarteco.rw',
    )
    .setLicense('Proprietary', 'https://smarteco.rw/terms')
    .addServer('http://localhost:3000', 'Local Development')
    .addServer('https://api.smarteco.rw', 'Production')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description:
          'Enter JWT access token obtained from /auth/otp/verify or /auth/google',
        in: 'header',
      },
      'JWT-auth',
    )
    .addTag('Auth', 'Registration, OTP verification, and token management')
    .addTag('Users', 'User profile management and referrals')
    .addTag('Pickups', 'Waste pickup scheduling and management')
    .addTag('Bins', 'Smart bin management and IoT integration')
    .addTag('EcoPoints', 'EcoPoints rewards and tier system')
    .addTag('Collectors', 'Collector management and assignments')
    .addTag('Payments', 'Mobile money payments (MTN MoMo, Airtel)')
    .addTag('Notifications', 'Push, SMS, and in-app notifications')
    .addTag('Admin', 'Admin dashboard and system management')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    customSiteTitle: 'Ejova API Docs',
    customCss: `
      .swagger-ui .topbar { display: none }
      .swagger-ui .info .title { color: #2e7d32; }
      .swagger-ui .scheme-container { background: #f1f8e9; padding: 12px; border-radius: 6px; }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
      showRequestDuration: true,
      tryItOutEnabled: true,
      requestSnippetsEnabled: true,
    },
  });

  // ─── Start Server ────────────────────────────────
  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`🚀 Ejova API running on http://localhost:${port}`);
  logger.log(
    `📚 Swagger docs available at http://localhost:${port}/${SWAGGER_PATH}`,
  );
}

bootstrap().catch((err: Error) => {
  const logger = new Logger('Bootstrap');
  logger.error(`Error during server bootstrap: ${err.message}`, err.stack);
  process.exit(1);
});
