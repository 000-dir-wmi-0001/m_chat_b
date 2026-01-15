import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { UnifiedGateway } from './unified.gateway';

@Module({
  imports: [
    // Load environment variables from .env file
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // Rate limiting: 10 requests per 60 seconds per IP
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 60 seconds
        limit: 10,  // 10 requests per minute per IP
      },
    ]),
  ],
  controllers: [AppController],
  providers: [
    UnifiedGateway,
    // Enable rate limiting globally
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
