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
  messages: { sender: string; text: string; timestamp: number }[];
  timeout?: NodeJS.Timeout;
}

const ROOM_EXPIRY_MS = 20 * 60 * 1000; // 20 minutes

@WebSocketGateway({ cors: true })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private temporaryRooms: Record<string, TempRoom> = {};

  // Generate a 6-digit code
  private generateCode(): string {
    let code;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.temporaryRooms[code]);
    return code;
  }

  // Create a new room and return its code
  @SubscribeMessage('createRoom')
  handleCreateRoom(@ConnectedSocket() client: Socket) {
    console.log('Creating room for client:', client.id);
    const code = this.generateCode();
    this.temporaryRooms[code] = {
      users: [client.id],
      messages: [],
      timeout: setTimeout(() => this.destroyRoom(code), ROOM_EXPIRY_MS),
    };
    client.join(code);
    console.log('Room created with code:', code);
    return { code };
  }

  // Join an existing room
  @SubscribeMessage('joinRoom')
  handleJoinRoom(@MessageBody() data: { code: string }, @ConnectedSocket() client: Socket) {
    console.log('Client', client.id, 'trying to join room:', data.code);
    const room = this.temporaryRooms[data.code];
    if (!room) {
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
    @MessageBody() data: { code: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.temporaryRooms[data.code];
    if (!room || !room.users.includes(client.id)) return { error: 'Not in room' };
    const message = { sender: client.id, text: data.text, timestamp: Date.now() };
    room.messages.push(message);
    this.server.to(data.code).emit('newMessage', message);
    return { success: true };
  }



  // Destroy room
  private destroyRoom(code: string) {
    const room = this.temporaryRooms[code];
    if (room && room.timeout) clearTimeout(room.timeout);
    delete this.temporaryRooms[code];
    this.server.to(code).emit('roomExpired');
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
        if (room.users.length === 0) this.destroyRoom(code);
      }
    }
  }

  // Handle connection
  handleConnection(client: Socket) {
    console.log('Client connected:', client.id);
    client.on('disconnect', () => this.handleDisconnect(client));
  }
}
