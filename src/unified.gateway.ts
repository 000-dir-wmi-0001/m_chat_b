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
  },
  maxHttpBufferSize: 50 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket']
})
export class UnifiedGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private rooms: Record<string, Room> = {};
  private ipTracking: Record<string, IPTracker> = {};

  private generateCode(): string {
    let code;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.rooms[code]);
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
    const ip = this.getClientIP(client);
    console.log(`${type.toUpperCase()} - Creating room for client:`, client.id, 'IP:', ip);
    
    if (!this.checkRateLimit(ip, 'generation')) {
      console.log('Rate limit exceeded for IP:', ip);
      return { error: 'Rate limit exceeded. Please try again later.' };
    }

    const code = this.generateCode();
    this.rooms[code] = {
      creator: client.id,
      users: [client.id],
      type,
      messages: type === 'text' ? [] : undefined,
      audioSettings: type === 'voice' ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000
      } : undefined
    };
    client.join(code);
    console.log(`${type.toUpperCase()} - Room created with code:`, code, 'Creator:', client.id);
    return { code };
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    return this.joinRoom(client, data.code, 'text');
  }

  @SubscribeMessage('joinVideoRoom')
  handleJoinVideoRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    return this.joinRoom(client, data.code, 'video');
  }

  @SubscribeMessage('joinVoiceRoom')
  handleJoinVoiceRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    return this.joinRoom(client, data.code, 'voice');
  }

  private joinRoom(client: Socket, code: string, expectedType: 'text' | 'video' | 'voice') {
    const ip = this.getClientIP(client);
    console.log(`${expectedType.toUpperCase()} - Client`, client.id, 'trying to join room:', code, 'IP:', ip);
    
    const room = this.rooms[code];
    if (!room) {
      if (!this.checkRateLimit(ip, 'join')) {
        console.log('Rate limit exceeded for failed join attempt, IP:', ip);
        return { error: 'Too many failed attempts. Please try again later.' };
      }
      console.log(`${expectedType.toUpperCase()} - Room not found:`, code);
      return { error: 'Room not found' };
    }
    
    room.users.push(client.id);
    client.join(code);
    console.log(`${room.type.toUpperCase()} - User joined room:`, code, 'Users:', room.users.length);
    
    this.server.to(code).emit('userJoined', { userId: client.id, totalUsers: room.users.length });
    if (room.type === 'voice') {
      this.server.to(code).emit('userCount', { count: room.users.length });
    }
    
    return { success: true, messages: room.messages || [], totalUsers: room.users.length };
  }

  @SubscribeMessage('sendMessage')
  handleSendMessage(
    @MessageBody() data: { code: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.code];
    if (!room || !room.users.includes(client.id)) return { error: 'Not in room' };
    
    if (room.users.length < 2) return { error: 'Need at least 2 users to chat' };
    
    const message = { 
      sender: client.id, 
      text: data.text, 
      timestamp: Date.now()
    };
    if (room.messages) room.messages.push(message);
    this.server.to(data.code).emit('newMessage', message);
    return { success: true };
  }

  @SubscribeMessage('sendFile')
  handleSendFile(
    @MessageBody() data: { code: string; file: { name: string; data: string; type: string; size: number } },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const room = this.rooms[data.code];
      if (!room || !room.users.includes(client.id)) return { error: 'Not in room' };
      
      if (room.users.length < 2) return { error: 'Need at least 2 users to share files' };
      
      console.log('Sending file:', data.file.name, 'Size:', data.file.size);
      
      this.server.to(data.code).emit('receiveFile', {
        sender: client.id,
        file: data.file,
        timestamp: Date.now()
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error sending file:', error);
      return { error: 'Failed to send file' };
    }
  }

  @SubscribeMessage('offer')
  handleOffer(@MessageBody() data: { offer: any; code: string }, @ConnectedSocket() client: Socket) {
    const room = this.rooms[data.code];
    const offerData = { 
      offer: data.offer, 
      from: client.id,
      audioSettings: room?.audioSettings
    };
    client.to(data.code).emit('offer', offerData);
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

  @SubscribeMessage('audioQuality')
  handleAudioQuality(@MessageBody() data: { code: string; quality: 'low' | 'medium' | 'high' }, @ConnectedSocket() client: Socket) {
    const room = this.rooms[data.code];
    if (room?.type === 'voice' && room.audioSettings) {
      // Adjust settings based on network quality
      switch (data.quality) {
        case 'low':
          room.audioSettings.sampleRate = 16000;
          break;
        case 'medium':
          room.audioSettings.sampleRate = 24000;
          break;
        case 'high':
          room.audioSettings.sampleRate = 48000;
          break;
      }
      client.to(data.code).emit('audioSettingsUpdate', room.audioSettings);
    }
    return { success: true };
  }

  @SubscribeMessage('endCall')
  handleEndCall(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    console.log('Client', client.id, 'ending call in room:', data.code);
    // Notify all users in the room that call ended
    this.server.to(data.code).emit('callEnded', { endedBy: client.id });
    // Destroy the room to force redirect
    this.destroyRoom(data.code);
    return { success: true };
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    return this.leaveRoom(client, data.code);
  }

  @SubscribeMessage('leaveVideoRoom')
  handleLeaveVideoRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    return this.leaveRoom(client, data.code);
  }

  @SubscribeMessage('leaveVoiceRoom')
  handleLeaveVoiceRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    const room = this.rooms[data.code];
    if (room?.type === 'voice') {
      // End call for all users when someone leaves voice room
      this.server.to(data.code).emit('callEnded', { endedBy: client.id });
    }
    return this.leaveRoom(client, data.code);
  }

  private leaveRoom(client: Socket, code: string) {
    console.log('Client', client.id, 'leaving room:', code);
    const room = this.rooms[code];
    if (room && room.users.includes(client.id)) {
      room.users = room.users.filter((id) => id !== client.id);
      if (room.users.length === 0) {
        this.destroyRoom(code);
      } else {
        this.server.to(code).emit('userLeft', { userId: client.id, totalUsers: room.users.length });
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
    console.log('Client disconnected:', client.id);
    for (const code in this.rooms) {
      const room = this.rooms[code];
      if (room.users.includes(client.id)) {
        room.users = room.users.filter((id) => id !== client.id);
        if (room.users.length === 0) {
          this.destroyRoom(code);
        } else {
          this.server.to(code).emit('userLeft', { userId: client.id, totalUsers: room.users.length });
          if (room.type === 'voice') {
            this.server.to(code).emit('userCount', { count: room.users.length });
          }
        }
      }
    }
  }

  handleConnection(client: Socket) {
    console.log('Client connected:', client.id);
  }
}