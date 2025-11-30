import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { UnifiedGateway } from './unified.gateway';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [UnifiedGateway],
})
export class AppModule {}
