import { Controller, Get, Logger, Req, ForbiddenException } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import * as crypto from 'crypto';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  // Get allowed origins from env or use defaults
  // Set ALLOWED_ORIGINS=https://yourdomain.com,https://anotherdomain.com in production
  private readonly allowedOrigins: string[] = (
    process.env.ALLOWED_ORIGINS || 
    'http://localhost:3000,http://localhost:3001'
  ).split(',').map(o => o.trim());

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
   */
  @Get('turn-credentials')
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // Stricter: 5 per minute
  getTurnCredentials(@Req() request: FastifyRequest) {
    // Origin check - only allow requests from trusted domains
    const origin = request.headers.origin || request.headers.referer || '';
    const isAllowedOrigin = this.allowedOrigins.some(allowed => 
      origin.startsWith(allowed)
    );
    
    // In production, enforce origin check. In dev, allow all.
    const isDev = process.env.NODE_ENV !== 'production';
    if (!isDev && !isAllowedOrigin) {
      this.logger.warn(`TURN credentials request blocked from origin: ${origin}`);
      throw new ForbiddenException('Unauthorized origin');
    }

    const turnSecret = process.env.TURN_SECRET;
    const turnUrl = process.env.TURN_URL;
    const turnPort = process.env.TURN_PORT || '3478';

    if (!turnSecret || !turnUrl) {
      this.logger.warn('TURN server not configured - missing TURN_SECRET or TURN_URL env variables');
      return {
        error: 'TURN server not configured',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ]
      };
    }

    // Credentials valid for 1 hour (3600 seconds)
    const ttl = 3600;
    const expiryTimestamp = Math.floor(Date.now() / 1000) + ttl;
    
    // Username format: expiry_timestamp:random_id
    const username = `${expiryTimestamp}:mchat_${crypto.randomBytes(8).toString('hex')}`;
    
    // Password is HMAC-SHA1 of username using the shared secret
    const hmac = crypto.createHmac('sha1', turnSecret);
    hmac.update(username);
    const credential = hmac.digest('base64');

    this.logger.log(`Generated TURN credentials for ${turnUrl}:${turnPort}, expires at ${new Date(expiryTimestamp * 1000).toISOString()}`);

    return {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
          urls: `turn:${turnUrl}:${turnPort}`,
          username: username,
          credential: credential,
        },
      ],
      ttl: ttl,
      expiresAt: expiryTimestamp * 1000, // milliseconds for frontend
    };
  }
}
