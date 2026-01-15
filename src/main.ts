import 'dotenv/config'; // Load .env file
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
