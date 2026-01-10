import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

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

  console.log(`🚀 Backend server running on http://localhost:${port}`);
  console.log(`📡 WebSocket server ready for connections`);
  console.log(`🔒 CORS origins: ${corsOrigins.join(', ')}`);
  console.log(`⚡ Rate limiting enabled`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
}

bootstrap().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
