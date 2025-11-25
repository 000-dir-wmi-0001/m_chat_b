import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: ['http://localhost:3000', 'https://m-chat-three.vercel.app'],
    credentials: true,
  });
  app.use((req, res, next) => {
    res.setHeader('Content-Length', '10485760');
    next();
  });
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`🚀 Backend server running on http://localhost:${port}`);
  console.log(`📡 WebSocket server ready for connections`);
  console.log(`🔒 CORS restricted to allowed origins`);
  console.log(`⚡ Rate limiting enabled`);
}
bootstrap();
