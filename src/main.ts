import 'dotenv/config'; // Load .env file
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // Environment configuration
  const port = parseInt(process.env.PORT || '3001') || 3001;
  const corsOrigins = process.env.CORS_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'https://m-chat-three.vercel.app',
    'https://mchat.momin-mohasin.me',
  ];

  // CORS configuration
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  // Global middleware - Note: Using Fastify, not Express
  // Content-Length header is handled automatically by Fastify

  // await app.listen(port);
  await app.listen({ port, host: '0.0.0.0' });

  logger.log(`🚀 Backend server running on http://localhost:${port}`);
  logger.log(`📡 WebSocket server ready for connections`);
  logger.log(`🔒 CORS origins: ${corsOrigins.join(', ')}`);
  logger.log(`⚡ Rate limiting enabled`);
  logger.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
}

bootstrap().catch((err) => {
  logger.error('❌ Failed to start server:', err);
  process.exit(1);
});
