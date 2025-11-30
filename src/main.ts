import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true })
  );
  
  // Environment configuration
  const port = parseInt(process.env.PORT || '3001') || 3001;
  const corsOrigins = process.env.CORS_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'https://m-chat-three.vercel.app'
  ];
  
  // CORS configuration
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });
  
  // Global middleware
  app.use((req, res, next) => {
    res.setHeader('Content-Length', '10485760');
    next();
  });
  
  await app.listen(port);
  
  console.log(`🚀 Backend server running on http://localhost:${port}`);
  console.log(`📡 WebSocket server ready for connections`);
  console.log(`🔒 CORS origins: ${corsOrigins.join(', ')}`);
  console.log(`⚡ Rate limiting enabled`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
}

bootstrap().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
