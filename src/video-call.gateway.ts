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

interface VideoRoom {
  creator: string;
  users: string[];
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

@WebSocketGateway(3003, {
  cors: {
    origin: ['http://localhost:3000', 'https://m-chat-three.vercel.app'],
    credentials: true
  },
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket']
})
export class VideoCallGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private videoRooms: Record<string, VideoRoom> = {};
  private ipTracking: Record<string, IPTracker> = {};

  private generateCode(): string {
    let code;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.videoRooms[code]);
    return code;
  }

  private getClientIP(client: Socket): string {
    return client.handshake.address || client.conn.remoteAddress || 'unknown';
  }

  private checkRateLimit(ip: string, type: 'generation' | 'join'): boolean {
    const now = Date.now();
    
    if (!this.ipTracking[ip]) {
      this.ipTracking[ip] = {
        codeGenerations: { count: 0, resetTime: now + 60000 },
        joinAttempts: { count: 0, resetTime: now + 60000 }
      };
    }

    const tracker = this.ipTracking[ip];
    
    if (tracker.blockedUntil && now < tracker.blockedUntil) {
      return false;
    }

    const limit = type === 'generation' ? tracker.codeGenerations : tracker.joinAttempts;
    const maxCount = type === 'generation' ? 5 : 3;

    if (now > limit.resetTime) {
      limit.count = 0;
      limit.resetTime = now + 60000;
    }

    if (limit.count >= maxCount) {
      if (type === 'join') {
        tracker.blockedUntil = now + 600000;
      }
      return false;
    }

    limit.count++;
    return true;
  }

  @SubscribeMessage('createRoom')
  handleCreateRoom(@ConnectedSocket() client: Socket) {
    const ip = this.getClientIP(client);
    console.log('Video Call - Creating room for client:', client.id, 'IP:', ip);
    
    if (!this.checkRateLimit(ip, 'generation')) {
      console.log('Rate limit exceeded for IP:', ip);
      return { error: 'Rate limit exceeded. Please try again later.' };
    }

    const code = this.generateCode();
    this.videoRooms[code] = {
      creator: client.id,
      users: [client.id],
    };
    client.join(code);
    console.log('Video Call - Room created with code:', code, 'Creator:', client.id);
    return { code };
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    const ip = this.getClientIP(client);
    console.log('Video Call - Client', client.id, 'trying to join room:', data.code, 'IP:', ip);
    
    const room = this.videoRooms[data.code];
    if (!room) {
      if (!this.checkRateLimit(ip, 'join')) {
        console.log('Rate limit exceeded for failed join attempt, IP:', ip);
        return { error: 'Too many failed attempts. Please try again later.' };
      }
      console.log('Video Call - Room not found:', data.code);
      return { error: 'Room not found' };
    }
    
    room.users.push(client.id);
    client.join(data.code);
    console.log('Video Call - User joined room:', data.code, 'Users:', room.users.length);
    
    this.server.to(data.code).emit('userJoined', { userId: client.id, totalUsers: room.users.length });
    
    return { success: true, totalUsers: room.users.length };
  }

  @SubscribeMessage('offer')
  handleOffer(@MessageBody() data: { offer: any; code: string }, @ConnectedSocket() client: Socket) {
    client.to(data.code).emit('offer', { offer: data.offer, from: client.id });
    return { success: true };
  }

  @SubscribeMessage('answer')
  handleAnswer(@MessageBody() data: { answer: any; code: string }, @ConnectedSocket() client: Socket) {
    client.to(data.code).emit('answer', { answer: data.answer, from: client.id });
    return { success: true };
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(@MessageBody() data: { candidate: any; code: string }, @ConnectedSocket() client: Socket) {
    client.to(data.code).emit('ice-candidate', { candidate: data.candidate, from: client.id });
    return { success: true };
  }

  @SubscribeMessage('endCall')
  handleEndCall(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    console.log('Video Call - Client', client.id, 'ending call in room:', data.code);
    client.to(data.code).emit('callEnded');
    return { success: true };
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    console.log('Video Call - Client', client.id, 'leaving room:', data.code);
    const room = this.videoRooms[data.code];
    if (room && room.users.includes(client.id)) {
      room.users = room.users.filter((id) => id !== client.id);
      if (room.users.length === 0) {
        this.destroyRoom(data.code);
      } else {
        this.server.to(data.code).emit('userLeft', { userId: client.id, totalUsers: room.users.length });
      }
    }
    return { success: true };
  }

  private destroyRoom(code: string) {
    delete this.videoRooms[code];
    this.server.to(code).emit('userDisconnected');
  }

  handleDisconnect(client: Socket) {
    console.log('Video Call - Client disconnected:', client.id);
    for (const code in this.videoRooms) {
      const room = this.videoRooms[code];
      if (room.users.includes(client.id)) {
        room.users = room.users.filter((id) => id !== client.id);
        if (room.users.length === 0) {
          this.destroyRoom(code);
        } else {
          this.server.to(code).emit('userLeft', { userId: client.id, totalUsers: room.users.length });
        }
        console.log('Video Call - User left room:', code, 'Remaining users:', room.users.length);
      }
    }
  }

  handleConnection(client: Socket) {
    console.log('Video Call - Client connected:', client.id);
    client.on('disconnect', () => this.handleDisconnect(client));
  }
}
