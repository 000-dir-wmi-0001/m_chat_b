import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { RedisService } from './redis/redis.service';

interface Room {
  creator: string;
  users: string[];
  type: 'text' | 'video' | 'voice';
  messages?: { sender: string; text: string; timestamp: number }[];
  audioSettings?: {
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
    sampleRate: number;
  };
}

interface FileTransfer {
  id: string;
  sender: string;
  receiver: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  totalChunks: number;
  receivedChunks: number;
  timestamp: number;
}

// Factory function for WebSocket gateway configuration
function createWebSocketGatewayConfig() {
  // Return basic config - CORS will be handled dynamically
  return {
    cors: {
      origin: true, // Allow all origins initially, will be validated in connection
      credentials: true,
    },
    // Memory optimization: Reduced buffer size (10MB instead of 50MB)
    // File transfers use P2P anyway, this is mainly for signaling
    maxHttpBufferSize: 10 * 1024 * 1024,
    // Faster ping to detect dead connections sooner
    pingInterval: 20000,
    pingTimeout: 30000,
    // WebSocket only - no polling fallback (saves memory)
    transports: ['websocket'],
    // Disable per-message compression to reduce CPU/memory
    perMessageDeflate: false,
    // Limit concurrent connections per IP (optional, adjust as needed)
    connectTimeout: 10000,
  };
}

@WebSocketGateway(createWebSocketGatewayConfig)
export class UnifiedGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  private readonly logger = new Logger(UnifiedGateway.name);

  constructor(
    private configService: ConfigService,
    private redisService: RedisService
  ) { }

  // Initialize cleanup timer
  onModuleInit() {
    // Set up periodic cleanup of old file transfers
    setInterval(() => {
      this.cleanupOldTransfers();
    }, this.CLEANUP_INTERVAL);

    // Set up periodic cleanup of inactive rooms
    setInterval(() => {
      this.cleanupInactiveRooms();
    }, this.CLEANUP_INTERVAL);



    this.logger.log('Memory cleanup timers initialized');
  }

  // Cleanup old/abandoned file transfers to prevent memory leaks
  private cleanupOldTransfers() {
    const now = Date.now();
    const timeoutMs = this.TRANSFER_TIMEOUT;
    let cleanedCount = 0;

    for (const [transferId, transfer] of this.fileTransfers.entries()) {
      if (now - transfer.timestamp > timeoutMs) {
        this.fileTransfers.delete(transferId);
        cleanedCount++;
        this.logger.log(`Cleaned up old file transfer: ${transferId} (${transfer.fileName})`);
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`File transfer cleanup completed. Removed ${cleanedCount} old transfers.`);
    }
  }

  // Cleanup inactive rooms to free memory
  private cleanupInactiveRooms() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const code in this.rooms) {
      const lastActivity = this.roomLastActivity.get(code) || 0;
      const room = this.rooms[code];

      // Remove room if inactive and empty, or inactive for too long
      if (room.users.length === 0 || (now - lastActivity > this.ROOM_INACTIVITY_TIMEOUT)) {
        delete this.rooms[code];
        this.roomLastActivity.delete(code);
        // Explicitly remove from Redis to free up space
        if (this.redisService.isAvailable()) {
          void this.redisService.delete(`room:${code}`);
        }
        cleanedCount++;
        this.logger.log(`Cleaned up inactive room: ${code}`);
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Room cleanup completed. Removed ${cleanedCount} inactive rooms. Active rooms: ${Object.keys(this.rooms).length}`);
    }
  }



  // Update room activity timestamp
  private updateRoomActivity(code: string) {
    this.roomLastActivity.set(code, Date.now());
  }

  // Get allowed origins from config (same as main app)
  private getAllowedOrigins(): string[] {
    try {
      const origins = this.configService.getOrThrow<string>('CORS_ORIGINS');
      return origins.split(',').map(o => o.trim());
    } catch (error) {
      // Fallback to defaults if not configured
      return [
        'http://localhost:3000',
        'https://m-chat-three.vercel.app',
        'https://mchat.momin-mohasin.me',
      ];
    }
  }

  @WebSocketServer()
  server: Server;

  private rooms: Record<string, Room> = {};
  private fileTransfers: Map<string, FileTransfer> = new Map();
  private readonly MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB limit for security
  private readonly CHUNK_SIZE = 64 * 1024; // 64KB chunks (consistent with frontend)
  private readonly TRANSFER_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_MESSAGE_LENGTH = 5000; // Maximum message length
  private readonly CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes cleanup interval

  // Memory optimization constants
  private readonly MAX_MESSAGES_PER_ROOM = 50; // Reduced from 100 to save Redis memory (30MB limit)
  private readonly ROOM_INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 min inactive = cleanup
  private readonly RATE_LIMIT_CLEANUP_INTERVAL = 5 * 60 * 1000; // Clean rate limits every 5 min
  private roomLastActivity: Map<string, number> = new Map(); // Track room activity

  // Allowed file types whitelist for security
  private readonly ALLOWED_FILE_TYPES = new Set([
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
    // Documents
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Archives
    'application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed', 'application/x-7z-compressed', 'application/gzip',
    // Audio
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4',
    // Video
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
    // Other safe types
    'application/json', 'application/xml',
  ]);

  // Blocked file extensions for additional security
  private readonly BLOCKED_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
    '.vbs', '.vbe', '.js', '.jse', '.ws', '.wsf', '.wsc', '.wsh',
    '.ps1', '.psm1', '.psd1', '.ps1xml', '.pssc', '.psc1',
    '.dll', '.sys', '.drv', '.ocx',
    '.hta', '.cpl', '.msc', '.jar',
  ]);

  // Rate limiting for room joins (prevent brute force)
  private readonly MAX_JOIN_ATTEMPTS = 5; // Max attempts per minute

  // Input validation and sanitization utilities
  private validateAndSanitizeMessage(text: string): { isValid: boolean; sanitizedText?: string; error?: string } {
    if (!text || typeof text !== 'string') {
      return { isValid: false, error: 'Message must be a non-empty string' };
    }

    // Trim whitespace
    const trimmed = text.trim();

    // Check length
    if (trimmed.length === 0) {
      return { isValid: false, error: 'Message cannot be empty' };
    }

    if (trimmed.length > this.MAX_MESSAGE_LENGTH) {
      return { isValid: false, error: `Message too long (max ${this.MAX_MESSAGE_LENGTH} characters)` };
    }

    // Basic sanitization - remove potentially dangerous characters
    // This is a basic implementation - consider using a proper sanitization library like DOMPurify
    let sanitized = trimmed
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/javascript:/gi, '') // Remove javascript: URLs
      .replace(/on\w+\s*=/gi, '') // Remove event handlers
      .replace(/style\s*=\s*["'][^"']*["']/gi, ''); // Remove style attributes

    // Additional security checks
    const dangerousPatterns = [
      /<iframe/i,
      /<object/i,
      /<embed/i,
      /<form/i,
      /<input/i,
      /eval\(/i,
      /Function\(/i,
      /setTimeout\s*\(/i,
      /setInterval\s*\(/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(sanitized)) {
        return { isValid: false, error: 'Message contains potentially dangerous content' };
      }
    }

    return { isValid: true, sanitizedText: sanitized };
  }

  // Validate file type against whitelist
  private validateFileType(fileName: string, fileType: string): { isValid: boolean; error?: string } {
    // Check file extension
    const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    if (this.BLOCKED_EXTENSIONS.has(ext)) {
      return { isValid: false, error: `File type '${ext}' is not allowed for security reasons` };
    }

    // Check MIME type against whitelist
    if (!this.ALLOWED_FILE_TYPES.has(fileType.toLowerCase())) {
      // Allow generic binary for unknown but non-blocked types
      if (fileType === 'application/octet-stream' && !this.BLOCKED_EXTENSIONS.has(ext)) {
        return { isValid: true };
      }
      return { isValid: false, error: `File type '${fileType}' is not allowed` };
    }

    return { isValid: true };
  }

  // Check rate limiting for room joins (using Redis)
  private async checkJoinRateLimit(clientId: string): Promise<{ allowed: boolean; error?: string }> {
    const key = `rate_limit:join:${clientId}`;

    // Increment count
    const count = await this.redisService.incr(key);

    // Set expiry if first attempt
    if (count === 1) {
      await this.redisService.expire(key, 60); // 60 seconds TTL
    }

    // Check limit
    if (count > this.MAX_JOIN_ATTEMPTS) {
      return { allowed: false, error: 'Too many join attempts. Please wait a minute.' };
    }

    return { allowed: true };
  }

  // Sync room with Redis
  private async syncRoomToRedis(code: string) {
    const room = this.rooms[code];
    if (room && this.redisService.isAvailable()) {
      // Store in Redis with shorter TTL (1 hour) to respect 30MB limit
      await this.redisService.set(`room:${code}`, JSON.stringify(room), 3600);
    }
  }

  // Load room from Redis if not in memory
  private async loadRoomFromRedis(code: string): Promise<Room | null> {
    if (this.redisService.isAvailable()) {
      const data = await this.redisService.get(`room:${code}`);
      if (data) {
        try {
          const room = JSON.parse(data) as Room;
          // Cache in memory
          this.rooms[code] = room;
          return room;
        } catch (e) {
          this.logger.error(`Failed to parse room data from Redis for ${code}`);
        }
      }
    }
    return null;
  }

  private generateCode(): string {
    let code: string;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.rooms[code]);
    return code;
  }

  // Public room creation handlers
  @SubscribeMessage('createRoom')
  handleCreateRoom(@ConnectedSocket() client: Socket) {
    return this.createRoom(client, 'text');
  }

  @SubscribeMessage('createVideoRoom')
  handleCreateVideoRoom(@ConnectedSocket() client: Socket) {
    return this.createRoom(client, 'video');
  }

  @SubscribeMessage('createVoiceRoom')
  handleCreateVoiceRoom(@ConnectedSocket() client: Socket) {
    return this.createRoom(client, 'voice');
  }

  private createRoom(client: Socket, type: 'text' | 'video' | 'voice') {
    this.logger.log(`${type.toUpperCase()} - Creating room for client: ${client.id}`);

    const code = this.generateCode();

    this.rooms[code] = {
      creator: client.id,
      users: [client.id],
      type,
      messages: type === 'text' ? [] : undefined,
      audioSettings:
        type === 'voice'
          ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
          }
          : undefined,
    };

    // Track room activity for cleanup
    this.updateRoomActivity(code);

    // Persist to Redis
    void this.syncRoomToRedis(code);

    void client.join(code);
    this.logger.log(
      `${type.toUpperCase()} - Room created with code: ${code} Creator: ${client.id}`,
    );
    return { code };
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    @MessageBody() data: { code: string },
    @ConnectedSocket() client: Socket,
  ) {
    return this.joinRoom(client, data.code);
  }

  @SubscribeMessage('joinVideoRoom')
  handleJoinVideoRoom(
    @MessageBody() data: { code: string },
    @ConnectedSocket() client: Socket,
  ) {
    return this.joinRoom(client, data.code, 'video');
  }

  @SubscribeMessage('joinVoiceRoom')
  handleJoinVoiceRoom(
    @MessageBody() data: { code: string },
    @ConnectedSocket() client: Socket,
  ) {
    return this.joinRoom(client, data.code, 'voice');
  }

  private async joinRoom(
    client: Socket,
    code: string,
    expectedType?: 'text' | 'video' | 'voice',
  ) {
    const typeLabel = (expectedType || 'universal').toUpperCase();
    this.logger.log(
      `${typeLabel} - Client ${client.id} trying to join room: ${code}`,
    );

    // Check rate limit
    const rateLimit = await this.checkJoinRateLimit(client.id);
    if (!rateLimit.allowed) {
      this.logger.warn(`Rate limit exceeded for client ${client.id}`);
      return { error: rateLimit.error };
    }

    let room: Room | null | undefined = this.rooms[code];
    if (!room) {
      // Try loading from Redis
      room = await this.loadRoomFromRedis(code);
    }

    if (!room) {
      this.logger.warn(`${typeLabel} - Room not found: ${code}`);
      return { error: 'Room not found' };
    }

    // Validate room type matches expected type if provided
    if (expectedType && room.type !== expectedType) {
      this.logger.warn(`${expectedType.toUpperCase()} - Room type mismatch: expected ${expectedType}, got ${room.type}`);
      return { error: 'Wrong room type' };
    }

    // Prevent duplicate entries for the same client
    if (!room.users.includes(client.id)) {
      room.users.push(client.id);
    }
    void client.join(code);

    // Track room activity
    this.updateRoomActivity(code);

    this.logger.log(
      `${room.type.toUpperCase()} - User joined room: ${code} Users: ${room.users.length}`,
    );

    // Update Redis
    void this.syncRoomToRedis(code);

    this.server
      .to(code)
      .emit('userJoined', { userId: client.id, totalUsers: room.users.length });
    if (room.type === 'voice') {
      this.server.to(code).emit('userCount', { count: room.users.length });
    }

    return {
      success: true,
      messages: room.messages || [],
      totalUsers: room.users.length,
      roomType: room.type,
    };
  }

  @SubscribeMessage('sendMessage')
  handleSendMessage(
    @MessageBody() data: { code: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.code];
    if (!room || !room.users.includes(client.id))
      return { error: 'Not in room' };

    if (room.users.length < 2)
      return { error: 'Need at least 2 users to chat' };

    // Validate and sanitize message
    const validation = this.validateAndSanitizeMessage(data.text);
    if (!validation.isValid) {
      return { error: validation.error };
    }

    const message = {
      sender: client.id,
      text: validation.sanitizedText!,
      timestamp: Date.now(),
    };

    // Store message with limit to prevent memory bloat
    if (room.messages) {
      room.messages.push(message);
      // Keep only last N messages to save memory
      if (room.messages.length > this.MAX_MESSAGES_PER_ROOM) {
        room.messages = room.messages.slice(-this.MAX_MESSAGES_PER_ROOM);
      }
    }

    // Update Redis
    void this.syncRoomToRedis(data.code);

    this.server.to(data.code).emit('newMessage', message);
    return { success: true };
  }

  @SubscribeMessage('userTyping')
  handleUserTyping(
    @MessageBody() data: { roomCode: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.roomCode];
    if (!room || !room.users.includes(client.id)) return;

    // Broadcast typing event to all other users in the room
    client.to(data.roomCode).emit('userTyping', { userId: client.id });
  }

  @SubscribeMessage('stopTyping')
  handleStopTyping(
    @MessageBody() data: { roomCode: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.roomCode];
    if (!room || !room.users.includes(client.id)) return;

    // Broadcast stop typing event to all other users in the room
    client.to(data.roomCode).emit('userStopTyping', { userId: client.id });
  }

  @SubscribeMessage('sendFile')
  handleSendFile(
    @MessageBody()
    data: {
      code: string;
      file: { name: string; data: string; type: string; size: number };
    },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const room = this.rooms[data.code];
      if (!room || !room.users.includes(client.id))
        return { error: 'Not in room' };

      if (room.users.length < 2)
        return { error: 'Need at least 2 users to share files' };

      // Validate file size limit for security
      if (data.file.size > this.MAX_FILE_SIZE) {
        return { error: `File size exceeds maximum limit of ${this.MAX_FILE_SIZE / (1024 * 1024)}MB` };
      }

      // Validate file type against whitelist for security
      const fileTypeValidation = this.validateFileType(data.file.name, data.file.type);
      if (!fileTypeValidation.isValid) {
        this.logger.warn(`File type rejected: ${data.file.name} (${data.file.type}) - ${fileTypeValidation.error}`);
        return { error: fileTypeValidation.error };
      }

      this.logger.log(
        `Starting chunked file transfer: ${data.file.name} Size: ${data.file.size}`,
      );

      // Calculate number of chunks needed (will be sent by client)
      const totalChunks = Math.ceil(data.file.size / this.CHUNK_SIZE);
      const transferId = `${client.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Validate we have exactly 2 users for P2P file transfer
      const otherUsers = room.users.filter(id => id !== client.id);
      if (otherUsers.length !== 1) {
        return { error: 'File transfer requires exactly 2 users in room' };
      }

      // Create file transfer record
      const transfer: FileTransfer = {
        id: transferId,
        sender: client.id,
        receiver: otherUsers[0], // Safe now
        fileName: data.file.name,
        fileSize: data.file.size,
        fileType: data.file.type,
        totalChunks,
        receivedChunks: 0,
        timestamp: Date.now(),
      };

      this.fileTransfers.set(transferId, transfer);

      // Notify room that file transfer is starting
      this.server.to(data.code).emit('fileTransferStart', {
        transferId,
        fileName: data.file.name,
        fileSize: data.file.size,
        fileType: data.file.type,
        totalChunks,
      });

      return { success: true, transferId, totalChunks };
    } catch (error) {
      this.logger.error('Error starting file transfer:', error);
      return { error: 'Failed to start file transfer' };
    }
  }

  @SubscribeMessage('fileChunk')
  handleFileChunk(
    @MessageBody()
    data: {
      transferId: string;
      chunkIndex: number;
      totalChunks: number;
      chunk: string;
      fileName: string;
      fileSize: number;
      fileType: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    const transfer = this.fileTransfers.get(data.transferId);
    if (!transfer || transfer.sender !== client.id) {
      return { error: 'Invalid transfer' };
    }

    // Don't store chunks in memory - just relay them immediately
    // This prevents memory exhaustion for large files
    transfer.receivedChunks++;

    // Relay chunk to room (excluding sender)
    client.to(transfer.receiver).emit('fileChunk', data);

    // Check if transfer is complete
    if (transfer.receivedChunks === transfer.totalChunks) {
      // Notify completion
      setTimeout(() => {
        this.server
          .to(transfer.receiver)
          .emit('fileTransferComplete', { transferId: data.transferId });
        // Clean up transfer immediately after completion
        this.fileTransfers.delete(data.transferId);
      }, 100);
    }

    return { success: true };
  }

  @SubscribeMessage('cancelFileTransfer')
  handleCancelFileTransfer(
    @MessageBody() data: { transferId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const transfer = this.fileTransfers.get(data.transferId);
    if (transfer && transfer.sender === client.id) {
      this.fileTransfers.delete(data.transferId);
      // Notify room about cancellation
      for (const roomCode in this.rooms) {
        const room = this.rooms[roomCode];
        if (room.users.includes(client.id)) {
          this.server
            .to(roomCode)
            .emit('fileTransferCancelled', { transferId: data.transferId });
          break;
        }
      }
      return { success: true };
    }
    return { error: 'Transfer not found or not authorized' };
  }

  @SubscribeMessage('offer')
  handleOffer(
    @MessageBody() data: { offer: RTCSessionDescriptionInit; code: string; isScreenShare?: boolean; streamType?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.code];
    const offerData = {
      offer: data.offer,
      from: client.id,
      roomType: room?.type,
      audioSettings: room?.audioSettings,
      isScreenShare: data.isScreenShare,
      streamType: data.streamType,
    };
    client.to(data.code).emit('offer', offerData);
    return { success: true };
  }

  @SubscribeMessage('answer')
  handleAnswer(
    @MessageBody() data: { answer: RTCSessionDescriptionInit; code: string; isScreenShare?: boolean; streamType?: string },
    @ConnectedSocket() client: Socket,
  ) {
    client
      .to(data.code)
      .emit('answer', {
        answer: data.answer,
        from: client.id,
        isScreenShare: data.isScreenShare,
        streamType: data.streamType
      });
    return { success: true };
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(
    @MessageBody() data: { candidate: RTCIceCandidateInit; code: string; isScreenShare?: boolean; streamType?: string },
    @ConnectedSocket() client: Socket,
  ) {
    client
      .to(data.code)
      .emit('ice-candidate', {
        candidate: data.candidate,
        from: client.id,
        isScreenShare: data.isScreenShare,
        streamType: data.streamType
      });
    return { success: true };
  }

  @SubscribeMessage('trackUpdate')
  handleTrackUpdate(
    @MessageBody()
    data: { code: string; trackKind: 'audio' | 'video'; enabled: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.code];
    if (!room || !room.users.includes(client.id)) {
      return { error: 'Not in room' };
    }

    // Notify other users about track state change
    client.to(data.code).emit('trackStateChanged', {
      userId: client.id,
      trackKind: data.trackKind,
      enabled: data.enabled,
    });

    this.logger.log(
      `User ${client.id} ${data.enabled ? 'enabled' : 'disabled'} ${data.trackKind} track in room ${data.code}`,
    );
    return { success: true };
  }

  @SubscribeMessage('screenShareUpdate')
  handleScreenShareUpdate(
    @MessageBody() data: { code: string; isSharing: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    client.to(data.code).emit('remoteScreenShareUpdate', {
      userId: client.id,
      isSharing: data.isSharing,
    });
    this.logger.log(`User ${client.id} ${data.isSharing ? 'started' : 'stopped'} screen share in room ${data.code}`);
    return { success: true };
  }

  @SubscribeMessage('requestVideoCall')
  handleRequestVideoCall(
    @MessageBody() data: { roomCode: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.roomCode];
    if (!room || !room.users.includes(client.id)) {
      return { error: 'Not in room' };
    }

    // Broadcast request to other users in the room
    client.to(data.roomCode).emit('incomingVideoCall', { from: client.id });
    this.logger.log(`User ${client.id} requested video call in room ${data.roomCode}`);
    return { success: true };
  }

  @SubscribeMessage('respondVideoCall')
  handleRespondVideoCall(
    @MessageBody() data: { roomCode: string; accepted: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.roomCode];
    if (!room || !room.users.includes(client.id)) {
      return { error: 'Not in room' };
    }

    // Broadcast response to other users
    client.to(data.roomCode).emit('videoCallResponse', {
      from: client.id,
      accepted: data.accepted
    });
    this.logger.log(
      `User ${client.id} ${data.accepted ? 'accepted' : 'rejected'} video call in room ${data.roomCode}`
    );
    return { success: true };
  }

  @SubscribeMessage('requestVoiceCall')
  handleRequestVoiceCall(
    @MessageBody() data: { roomCode: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.roomCode];
    if (!room || !room.users.includes(client.id)) {
      return { error: 'Not in room' };
    }

    // Broadcast request to other users in the room
    client.to(data.roomCode).emit('incomingVoiceCall', { from: client.id });
    this.logger.log(`User ${client.id} requested voice call in room ${data.roomCode}`);
    return { success: true };
  }

  @SubscribeMessage('respondVoiceCall')
  handleRespondVoiceCall(
    @MessageBody() data: { roomCode: string; accepted: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.roomCode];
    if (!room || !room.users.includes(client.id)) {
      return { error: 'Not in room' };
    }

    // Broadcast response to other users
    client.to(data.roomCode).emit('voiceCallResponse', {
      from: client.id,
      accepted: data.accepted
    });
    this.logger.log(
      `User ${client.id} ${data.accepted ? 'accepted' : 'rejected'} voice call in room ${data.roomCode}`
    );
    return { success: true };
  }

  @SubscribeMessage('endCall')
  handleEndCall(
    @MessageBody() data: { code: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Client ${client.id} ending call in room: ${data.code}`);
    // Notify all users in the room that call ended
    this.server.to(data.code).emit('callEnded', { endedBy: client.id });
    // Destroy the room to force redirect
    this.destroyRoom(data.code);
    return { success: true };
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(
    @MessageBody() data: { code: string },
    @ConnectedSocket() client: Socket,
  ) {
    return this.leaveRoom(client, data.code);
  }

  @SubscribeMessage('leaveVideoRoom')
  handleLeaveVideoRoom(
    @MessageBody() data: { code: string },
    @ConnectedSocket() client: Socket,
  ) {
    return this.leaveRoom(client, data.code);
  }

  @SubscribeMessage('leaveVoiceRoom')
  handleLeaveVoiceRoom(
    @MessageBody() data: { code: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.code];
    if (room?.type === 'voice') {
      // End call for all users when someone leaves voice room
      this.server.to(data.code).emit('callEnded', { endedBy: client.id });
    }
    return this.leaveRoom(client, data.code);
  }

  private leaveRoom(client: Socket, code: string) {
    this.logger.log(`Client ${client.id} leaving room: ${code}`);
    const room = this.rooms[code];
    if (room && room.users.includes(client.id)) {
      room.users = room.users.filter((id) => id !== client.id);
      if (room.users.length === 0) {
        this.destroyRoom(code);
      } else {
        this.server.to(code).emit('userLeft', {
          userId: client.id,
          totalUsers: room.users.length,
        });
        if (room.type === 'voice') {
          this.server.to(code).emit('userCount', { count: room.users.length });
        }
      }
    }
    return { success: true };
  }

  private destroyRoom(code: string) {
    delete this.rooms[code];
    this.server.to(code).emit('userDisconnected');
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    // Clean up file transfers for disconnected user
    for (const [transferId, transfer] of this.fileTransfers.entries()) {
      if (transfer.sender === client.id || transfer.receiver === client.id) {
        this.fileTransfers.delete(transferId);
      }
    }

    for (const code in this.rooms) {
      const room = this.rooms[code];
      if (room.users.includes(client.id)) {
        room.users = room.users.filter((id) => id !== client.id);
        if (room.users.length === 0) {
          this.destroyRoom(code);
        } else {
          this.server.to(code).emit('userLeft', {
            userId: client.id,
            totalUsers: room.users.length,
          });
          if (room.type === 'voice') {
            this.server
              .to(code)
              .emit('userCount', { count: room.users.length });
          }
        }
      }
    }
  }

  @SubscribeMessage('p2pOffer')
  handleP2POffer(
    @MessageBody()
    data: {
      roomCode: string;
      transferId: string;
      offer: RTCSessionDescriptionInit;
    },
    @ConnectedSocket() client: Socket,
  ) {
    // Forward offer to other user in room
    const room = this.rooms[data.roomCode];
    if (room) {
      const otherUsers = room.users.filter(id => id !== client.id);
      if (otherUsers.length === 1) {
        this.server.to(otherUsers[0]).emit('p2pOffer', {
          transferId: data.transferId,
          offer: data.offer,
          roomCode: data.roomCode,
        });
      }
    }
  }

  @SubscribeMessage('p2pAnswer')
  handleP2PAnswer(
    @MessageBody()
    data: {
      roomCode: string;
      transferId: string;
      answer: RTCSessionDescriptionInit;
    },
    @ConnectedSocket() client: Socket,
  ) {
    // Forward answer to other user in room
    const room = this.rooms[data.roomCode];
    if (room) {
      const otherUsers = room.users.filter(id => id !== client.id);
      if (otherUsers.length === 1) {
        this.server.to(otherUsers[0]).emit('p2pAnswer', {
          transferId: data.transferId,
          answer: data.answer,
        });
      }
    }
  }

  @SubscribeMessage('p2pIceCandidate')
  handleP2PIceCandidate(
    @MessageBody()
    data: {
      roomCode: string;
      transferId: string;
      candidate: RTCIceCandidateInit;
    },
    @ConnectedSocket() client: Socket,
  ) {
    // Forward ICE candidate to other user in room
    const room = this.rooms[data.roomCode];
    if (room) {
      const otherUsers = room.users.filter(id => id !== client.id);
      if (otherUsers.length === 1) {
        this.server.to(otherUsers[0]).emit('p2pIceCandidate', {
          transferId: data.transferId,
          candidate: data.candidate,
        });
      }
    }
  }

  handleConnection(client: Socket) {
    // Validate origin for consistency with main app CORS policy
    const allowedOrigins = this.getAllowedOrigins();
    const origin = client.handshake.headers.origin || client.handshake.headers.referer || '';

    const isAllowedOrigin = allowedOrigins.some(allowed =>
      origin.startsWith(allowed)
    );

    // In production, enforce origin check (same as TURN credentials)
    let isDev = false;
    try {
      const nodeEnv = this.configService.getOrThrow<string>('NODE_ENV');
      isDev = nodeEnv !== 'production';
    } catch (error) {
      isDev = true;
    }

    if (!isDev && !isAllowedOrigin) {
      this.logger.warn(`WebSocket connection blocked from origin: ${origin}`);
      client.disconnect(true);
      return;
    }

    this.logger.log(`Client connected: ${client.id} from ${origin || 'unknown origin'}`);
  }
}
