import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
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

@WebSocketGateway({
  cors: {
    origin: [
      'http://localhost:3000',
      'https://m-chat-three.vercel.app',
      'https://mchat.momin-mohasin.me',
    ],
    credentials: true,
  },
  maxHttpBufferSize: 50 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket'],
})
export class UnifiedGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(UnifiedGateway.name);

  @WebSocketServer()
  server: Server;

  private rooms: Record<string, Room> = {};
  private fileTransfers: Map<string, FileTransfer> = new Map();
  private readonly MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER; // No limit - P2P handles any size
  private readonly CHUNK_SIZE = 64 * 1024; // 64KB chunks (consistent with frontend)
  private readonly TRANSFER_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  private generateCode(): string {
    let code: string;
    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.rooms[code]);
    return code;
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
    return this.joinRoom(client, data.code, 'text');
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

  private joinRoom(
    client: Socket,
    code: string,
    expectedType: 'text' | 'video' | 'voice',
  ) {
    this.logger.log(
      `${expectedType.toUpperCase()} - Client ${client.id} trying to join room: ${code}`,
    );

    const room = this.rooms[code];
    if (!room) {
      this.logger.warn(`${expectedType.toUpperCase()} - Room not found: ${code}`);
      return { error: 'Room not found' };
    }

    room.users.push(client.id);
    void client.join(code);
    this.logger.log(
      `${room.type.toUpperCase()} - User joined room: ${code} Users: ${room.users.length}`,
    );

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

    const message = {
      sender: client.id,
      text: data.text,
      timestamp: Date.now(),
    };
    if (room.messages) room.messages.push(message);
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

      this.logger.log(
        `Starting chunked file transfer: ${data.file.name} Size: ${data.file.size}`,
      );

      // Calculate number of chunks needed (will be sent by client)
      const totalChunks = Math.ceil(data.file.size / this.CHUNK_SIZE);
      const transferId = `${client.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create file transfer record
      const transfer: FileTransfer = {
        id: transferId,
        sender: client.id,
        receiver: room.users.find((id) => id !== client.id)!, // Assume 2-user rooms
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
    @MessageBody() data: { offer: RTCSessionDescriptionInit; code: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.rooms[data.code];
    const offerData = {
      offer: data.offer,
      from: client.id,
      roomType: room?.type,
      audioSettings: room?.audioSettings,
    };
    client.to(data.code).emit('offer', offerData);
    return { success: true };
  }

  @SubscribeMessage('answer')
  handleAnswer(
    @MessageBody() data: { answer: RTCSessionDescriptionInit; code: string },
    @ConnectedSocket() client: Socket,
  ) {
    client
      .to(data.code)
      .emit('answer', { answer: data.answer, from: client.id });
    return { success: true };
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(
    @MessageBody() data: { candidate: RTCIceCandidateInit; code: string },
    @ConnectedSocket() client: Socket,
  ) {
    client
      .to(data.code)
      .emit('ice-candidate', { candidate: data.candidate, from: client.id });
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
      const otherUser = room.users.find((id) => id !== client.id);
      if (otherUser) {
        this.server.to(otherUser).emit('p2pOffer', {
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
      const otherUser = room.users.find((id) => id !== client.id);
      if (otherUser) {
        this.server.to(otherUser).emit('p2pAnswer', {
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
      const otherUser = room.users.find((id) => id !== client.id);
      if (otherUser) {
        this.server.to(otherUser).emit('p2pIceCandidate', {
          transferId: data.transferId,
          candidate: data.candidate,
        });
      }
    }
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }
}
