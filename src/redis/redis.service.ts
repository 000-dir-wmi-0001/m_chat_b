import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private isConnected = false;

  constructor(private configService: ConfigService) {
    this.connect();
  }

  private async connect() {
    try {
      const host = this.configService.get<string>('REDIS_HOST');
      const port = this.configService.get<number>('REDIS_PORT', 6379);
      const username = this.configService.get<string>('REDIS_USERNAME');
      const password = this.configService.get<string>('REDIS_PASSWORD');

      // Only connect if Redis is configured
      if (!host || !password) {
        this.logger.warn('Redis not configured. Using in-memory storage fallback.');
        return;
      }

      this.client = new Redis({
        host,
        port,
        username,
        password,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log('✅ Redis connected successfully');
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        this.logger.error('Redis connection error:', err.message);
        this.logger.warn('Falling back to in-memory storage');
      });

      this.client.on('close', () => {
        this.isConnected = false;
        this.logger.warn('Redis connection closed');
      });

    } catch (error) {
      this.logger.error('Failed to initialize Redis:', error.message);
      this.logger.warn('Using in-memory storage fallback');
    }
  }

  /**
   * Get a value from Redis
   * @param key The key to retrieve
   * @returns The value or null if not found or Redis unavailable
   */
  async get(key: string): Promise<string | null> {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      return await this.client.get(key);
    } catch (error) {
      this.logger.error(`Redis GET error for key "${key}":`, error.message);
      return null;
    }
  }

  /**
   * Set a value in Redis with optional expiration
   * @param key The key to set
   * @param value The value to store
   * @param ttlSeconds Optional TTL in seconds
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      return false;
    }

    try {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
      return true;
    } catch (error) {
      this.logger.error(`Redis SET error for key "${key}":`, error.message);
      return false;
    }
  }

  /**
   * Delete a key from Redis
   * @param key The key to delete
   */
  async delete(key: string): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      return false;
    }

    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      this.logger.error(`Redis DEL error for key "${key}":`, error.message);
      return false;
    }
  }

  /**
   * Check if a key exists in Redis
   * @param key The key to check
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      return false;
    }

    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      this.logger.error(`Redis EXISTS error for key "${key}":`, error.message);
      return false;
    }
  }

  /**
   * Get all keys matching a pattern
   * @param pattern The pattern to match (e.g., "room:*")
   */
  async keys(pattern: string): Promise<string[]> {
    if (!this.isConnected || !this.client) {
      return [];
    }

    try {
      return await this.client.keys(pattern);
    } catch (error) {
      this.logger.error(`Redis KEYS error for pattern "${pattern}":`, error.message);
      return [];
    }
  }

  /**
   * Increment a key's integer value
   * @param key The key to increment
   * @returns The new value
   */
  async incr(key: string): Promise<number> {
    if (!this.isConnected || !this.client) {
      return 0;
    }
    try {
      return await this.client.incr(key);
    } catch (error) {
      this.logger.error(`Redis INCR error for key "${key}":`, error.message);
      return 0;
    }
  }

  /**
   * Set a timeout on key
   * @param key The key to expire
   * @param seconds TTL in seconds
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      return false;
    }
    try {
      const result = await this.client.expire(key, seconds);
      return result === 1;
    } catch (error) {
      this.logger.error(`Redis EXPIRE error for key "${key}":`, error.message);
      return false;
    }
  }

  /**
   * Check if Redis is available
   */
  isAvailable(): boolean {
    return this.isConnected && this.client !== null;
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
      this.logger.log('Redis connection closed');
    }
  }
}
