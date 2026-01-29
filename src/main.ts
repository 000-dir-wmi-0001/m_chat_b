import 'dotenv/config'; // Load .env file
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
// import { nodeProfilingIntegration } from '@sentry/profiling-node';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './adapters/redis-io.adapter';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  // Initialize Sentry before the app
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      // nodeProfilingIntegration(),
    ],
    // Performance Monitoring
    tracesSampleRate: 1.0, //  Capture 100% of the transactions
    // Set sampling rate for profiling - this is relative to tracesSampleRate
    profilesSampleRate: 1.0,
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // Get configuration service
  const configService = app.get(ConfigService);

  // Environment configuration
  const port = configService.get<number>('PORT') || 3001;

  // Get NODE_ENV with getOrThrow for strict validation
  let nodeEnv = 'development';
  try {
    nodeEnv = configService.getOrThrow<string>('NODE_ENV');
  } catch (error) {
    // Default to development if not set
    nodeEnv = 'development';
  }

  // Get CORS origins with fallback
  let corsOrigins: string[] = [];
  try {
    const corsOriginStr = configService.getOrThrow<string>('CORS_ORIGINS');
    corsOrigins = corsOriginStr.split(',').map(o => o.trim());
  } catch (error) {
    // Fallback to default origins if not configured
    corsOrigins = [
      'http://localhost:3000',
      'https://m-chat-three.vercel.app',
      'https://mchat.momin-mohasin.me',
    ];
  }

  // CORS configuration
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  // Enable compression
  await app.register(import('@fastify/compress'));

  // Enable Redis Adapter for WebSocket scaling
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // Global middleware - Note: Using Fastify, not Express
  // Content-Length header is handled automatically by Fastify

  // await app.listen(port);
  await app.listen({ port, host: '0.0.0.0' });

  logger.log(`🚀 Backend server running on http://localhost:${port}`);
  logger.log(`📡 WebSocket server ready for connections`);
  logger.log(`🔒 CORS origins: ${corsOrigins.join(', ')}`);
  logger.log(`⚡ Rate limiting enabled`);
  logger.log(`🌍 Environment: ${nodeEnv}`);
}

bootstrap().catch((err) => {
  logger.error('❌ Failed to start server:', err);
  process.exit(1);
});
