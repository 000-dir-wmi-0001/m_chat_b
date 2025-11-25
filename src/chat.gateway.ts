import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

interface TempRoom {
  users: string[];
  messages: { sender: string; text: string; timestamp: number; file?: { name: string; data: string; type: string; size: number } }[];
}

interface RateLimit {
  count: number;
  resetTime: number;
}

interface IPTracker {
  codeGenerations: RateLimit;
  joinAttempts: RateLimit;
  blockedUntil?: number;
}

@WebSocketGateway({ 
  cors: {
    origin: ['http://localhost:3000', 'https://m-chat-three.vercel.app'],
    credentials: true
  }
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private temporaryRooms: Record<string, TempRoom> = {};
  private ipTracking: Record<string, IPTracker> = {};

  // Generate a 6-digit code
  private generateCode(): string {
    let code;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.temporaryRooms[code]);
    return code;
  }

  // Get client IP address
  private getClientIP(client: Socket): string {
    return client.handshake.address || client.conn.remoteAddress || 'unknown';
  }

  // Check rate limits
  private checkRateLimit(ip: string, type: 'generation' | 'join'): boolean {
    const now = Date.now();
    
    if (!this.ipTracking[ip]) {
      this.ipTracking[ip] = {
        codeGenerations: { count: 0, resetTime: now + 60000 },
        joinAttempts: { count: 0, resetTime: now + 60000 }
      };
    }

    const tracker = this.ipTracking[ip];
    
    // Check if IP is blocked
    if (tracker.blockedUntil && now < tracker.blockedUntil) {
      return false;
    }

    const limit = type === 'generation' ? tracker.codeGenerations : tracker.joinAttempts;
    const maxCount = type === 'generation' ? 5 : 3;

    // Reset counter if time window expired
    if (now > limit.resetTime) {
      limit.count = 0;
      limit.resetTime = now + 60000;
    }

    // Check if limit exceeded
    if (limit.count >= maxCount) {
      if (type === 'join') {
        // Block IP for 10 minutes after join abuse
        tracker.blockedUntil = now + 600000;
      }
      return false;
    }

    limit.count++;
    return true;
  }

  // Create a new room and return its code
  @SubscribeMessage('createRoom')
  handleCreateRoom(@ConnectedSocket() client: Socket) {
    const ip = this.getClientIP(client);
    console.log('Creating room for client:', client.id, 'IP:', ip);
    
    if (!this.checkRateLimit(ip, 'generation')) {
      console.log('Rate limit exceeded for IP:', ip);
      return { error: 'Rate limit exceeded. Please try again later.' };
    }

    const code = this.generateCode();
    this.temporaryRooms[code] = {
      users: [client.id],
      messages: [],
    };
    client.join(code);
    console.log('Room created with code:', code);
    return { code };
  }

  // Join an existing room
  @SubscribeMessage('joinRoom')
  handleJoinRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    const ip = this.getClientIP(client);
    console.log('Client', client.id, 'trying to join room:', data.code, 'IP:', ip);
    
    const room = this.temporaryRooms[data.code];
    if (!room) {
      if (!this.checkRateLimit(ip, 'join')) {
        console.log('Rate limit exceeded for failed join attempt, IP:', ip);
        return { error: 'Too many failed attempts. Please try again later.' };
      }
      console.log('Room not found:', data.code);
      return { error: 'Room not found' };
    }
    
    if (room.users.length >= 2) {
      console.log('Room full:', data.code);
      return { error: 'Room full' };
    }
    
    room.users.push(client.id);
    client.join(data.code);
    console.log('User joined room:', data.code, 'Users:', room.users.length);
    this.server.to(data.code).emit('userJoined', { userId: client.id });
    return { success: true, messages: room.messages };
  }

  // Send a message
  @SubscribeMessage('sendMessage')
  handleSendMessage(
    @MessageBody() data: { code: string; text: string; file?: { name: string; data: string; type: string; size: number } },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.temporaryRooms[data.code];
    if (!room || !room.users.includes(client.id)) return { error: 'Not in room' };
    
    // File size limit (5MB)
    if (data.file && data.file.size > 5 * 1024 * 1024) {
      return { error: 'File too large. Maximum size is 5MB.' };
    }
    
    const message = { 
      sender: client.id, 
      text: data.text, 
      timestamp: Date.now(),
      ...(data.file && { file: data.file })
    };
    room.messages.push(message);
    this.server.to(data.code).emit('newMessage', message);
    return { success: true };
  }

  // Leave room manually
  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    console.log('Client', client.id, 'leaving room:', data.code);
    const room = this.temporaryRooms[data.code];
    if (room && room.users.includes(client.id)) {
      // Destroy room and notify all users
      this.destroyRoom(data.code);
    }
    return { success: true };
  }



  // Destroy room
  private destroyRoom(code: string) {
    delete this.temporaryRooms[code];
    this.server.to(code).emit('userDisconnected');
  }

  // Handle disconnect
  handleDisconnect(client: Socket) {
    console.log('Client disconnected:', client.id);
    for (const code in this.temporaryRooms) {
      const room = this.temporaryRooms[code];
      if (room.users.includes(client.id)) {
        room.users = room.users.filter((id) => id !== client.id);
        this.server.to(code).emit('userLeft', { userId: client.id });
        console.log('User left room:', code, 'Remaining users:', room.users.length);
        // If any user disconnects, destroy room and notify remaining users
        this.destroyRoom(code);
      }
    }
  }

  // Handle connection
  handleConnection(client: Socket) {
    console.log('Client connected:', client.id);
    client.on('disconnect', () => this.handleDisconnect(client));
  }
}
