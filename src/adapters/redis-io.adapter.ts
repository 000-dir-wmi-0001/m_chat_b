import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private readonly logger = new Logger(RedisIoAdapter.name);

  constructor(private app: INestApplication) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const configService = this.app.get(ConfigService);
    const host = configService.get<string>('REDIS_HOST');
    const port = configService.get<number>('REDIS_PORT', 6379);
    const username = configService.get<string>('REDIS_USERNAME');
    const password = configService.get<string>('REDIS_PASSWORD');

    if (!host || !password) {
      this.logger.warn('Redis configuration missing. Skipping Redis Adapter initialization (Single instance mode).');
      return;
    }

    try {
      const pubClient = new Redis({
        host,
        port,
        username,
        password,
        retryStrategy: (times) => Math.min(times * 50, 2000),
      });

      const subClient = pubClient.duplicate();

      // Robust connection handling
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          pubClient.once('connect', () => {
            resolve();
          });
          pubClient.once('error', (err) => {
            reject(err);
          });
        }),
        new Promise<void>((resolve, reject) => {
          subClient.once('connect', () => {
            resolve();
          });
          subClient.once('error', (err) => {
            reject(err);
          });
        }),
      ]);

      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log(`✅ Redis Adapter initialized for WebSocket scaling`);
    } catch (e) {
      this.logger.error('Failed to initialize Redis Adapter:', e);
      // Don't throw - allow app to start in single-instance mode (using default in-memory adapter)
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
