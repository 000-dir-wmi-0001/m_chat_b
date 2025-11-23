// Simple Node.js script to test backend WebSocket functionality
const { io } = require('socket.io-client');

const socket = io('http://localhost:3001', {
  transports: ['websocket'],
});

socket.on('connect', () => {
  console.log('Connected:', socket.id);
  // Create a room
  socket.emit('createRoom');
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});

socket.on('userJoined', (data) => {
  console.log('User joined:', data);
});

socket.on('newMessage', (msg) => {
  console.log('New message:', msg);
});

socket.on('roomExpired', () => {
  console.log('Room expired');
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
});

// Listen for createRoom response and join the room as a second client for testing
socket.on('createRoom', (data) => {
  console.log('Room created:', data);
  // Simulate joining the room with the same code
  setTimeout(() => {
    socket.emit('joinRoom', { code: data.code });
  }, 1000);
});

// Send a test message after joining
socket.on('joinRoom', (data) => {
  if (data.success) {
    console.log('Joined room, sending message...');
    socket.emit('sendMessage', { code: data.code, text: 'Hello from test script!' });
  } else {
    console.log('Join room error:', data.error);
  }
});
