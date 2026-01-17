import { Controller, Get, Logger, Req, Inject, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import * as crypto from 'crypto';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(private configService: ConfigService) {}

  // Get allowed origins from config or use defaults
  private getAllowedOrigins(): string[] {
    try {
      const origins = this.configService.getOrThrow<string>('ALLOWED_ORIGINS');
      return origins.split(',').map(o => o.trim());
    } catch (error) {
      // Fallback to defaults if not configured
      return ['http://localhost:3000', 'http://localhost:3001'];
    }
  }

  @Get('health')
  @SkipThrottle() // Health checks shouldn't be rate limited
  healthCheck() {
    return {
      status: 'ok',
      service: 'M Chat Backend',
      timestamp: Date.now(),
    };
  }

  /**
   * Generate time-limited TURN credentials using HMAC-based authentication
   * These credentials are valid for 1 hour (3600 seconds)
   * 
   * Security:
   * - Rate limited: 5 requests per minute per IP
   * - Origin check: Only allowed domains can request credentials
   * 
   * Coturn validates these using the static-auth-secret configured on the server
   * Username format: timestamp:randomId (timestamp is expiry time)
   * Password: HMAC-SHA1(username, secret)
   * 
   * Environment variables required:
   * - TURN_SECRET: The shared secret from Coturn's static-auth-secret
   * - TURN_URL: The TURN server URL (e.g., turn.momin-mohasin.me)
   * - TURN_PORT: The TURN server port (default 3478)
   */
  @Get('turn-credentials')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  getTurnCredentials(@Req() request: FastifyRequest) {
    // Get config values
    const allowedOrigins = this.getAllowedOrigins();
    
    // TURN config is optional - use get() with defaults
    const turnSecret = this.configService.get<string>('TURN_SECRET');
    const turnUrl = this.configService.get<string>('TURN_URL');
    const turnPort = this.configService.get<string>('TURN_PORT') || '3478';
    
    // Get required values with getOrThrow
    let isDev = false;
    try {
      const nodeEnv = this.configService.getOrThrow<string>('NODE_ENV');
      isDev = nodeEnv !== 'production';
    } catch (error) {
      isDev = true; // Default to dev if not set
    }

    // Origin check - only allow requests from trusted domains
    const origin = request.headers.origin || request.headers.referer || '';
    const isAllowedOrigin = allowedOrigins.some(allowed => 
      origin.startsWith(allowed)
    );
    
    // In production, enforce origin check. In dev, allow all.
    if (!isDev && !isAllowedOrigin) {
      this.logger.warn(`TURN credentials request blocked from origin: ${origin}`);
      throw new ForbiddenException('Unauthorized origin');
    }

    // Build ICE servers array - always include STUN servers as fallback
    const iceServers: any[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    // If TURN server is configured, add it with credentials
    if (turnSecret && turnUrl) {
      // Credentials valid for 1 hour (3600 seconds)
      const ttl = 3600;
      const expiryTimestamp = Math.floor(Date.now() / 1000) + ttl;
      
      // Username format: expiry_timestamp:random_id
      const username = `${expiryTimestamp}:mchat_${crypto.randomBytes(8).toString('hex')}`;
      
      // Password is HMAC-SHA1 of username using the shared secret
      const hmac = crypto.createHmac('sha1', turnSecret);
      hmac.update(username);
      const credential = hmac.digest('base64');

      // Add TURN server as PRIMARY (before STUN servers for preference)
      iceServers.unshift({
        urls: [`turn:${turnUrl}:${turnPort}`, `turn:${turnUrl}:${turnPort}?transport=tcp`],
        username: username,
        credential: credential,
      });

      this.logger.log(`✅ Generated TURN credentials for ${turnUrl}:${turnPort}, expires at ${new Date(expiryTimestamp * 1000).toISOString()}`);

      return {
        iceServers,
        ttl: ttl,
        expiresAt: expiryTimestamp * 1000, // milliseconds for frontend
        turnConfigured: true,
      };
    }

    // TURN server not configured - log warning and return STUN-only
    this.logger.warn('⚠️  TURN server not configured - using STUN only. Set TURN_SECRET, TURN_URL, and TURN_PORT env variables for full functionality.');
    
    return {
      iceServers,
      ttl: null,
      expiresAt: null,
      turnConfigured: false,
      warning: 'TURN server not configured. Peer-to-peer connections may fail on restricted networks.',
    };
  }
}
