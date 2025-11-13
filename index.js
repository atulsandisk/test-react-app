import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import process from 'process';
import filesystemRouter from './filesystem.js'
import auth from './auth.js'
import nfsManager from './nfsManager.js';
import sendRouter from './send.js';
import chatRouter from './chat.js';
import systemRouter from './system.js';
import mydriveRouter from './mydrive.js';
import rabbitmq from './rabbitmq.js';
import { initializeSocketChat } from './socketChat.js';

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server and Socket.IO server
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:5174", "http://10.66.10.103:5173"],
    methods: ["GET", "POST"]
  }
});

// Global state
let isShuttingDown = false;
let httpServer = null;

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  
  socket.on('join-chat-room', (data) => {
    const { roomId, userId, sessionId } = data;
    socket.join(roomId);
    console.log(`👥 Socket ${socket.id} joined chat room: ${roomId} for user: ${userId}, session: ${sessionId}`);
    
    // Acknowledge room join
    socket.emit('room-joined', { roomId, status: 'success' });
  });
  
  socket.on('leave-chat-room', (data) => {
    const { roomId } = data;
    socket.leave(roomId);
    console.log(`👋 Socket ${socket.id} left chat room: ${roomId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// Export io instance for use in other modules
export { io };

// Initialize RabbitMQ connection
async function initializeRabbitMQ() {
  try {
    await rabbitmq.connect();
    console.log('✅ RabbitMQ connected successfully');
  } catch (error) {
    console.error('❌ RabbitMQ connection failed:', error);
    // Don't exit - allow app to run without RabbitMQ for now
  }
}

app.use(cors({
  origin: ["http://localhost:5173", "http://localhost:5174", "http:// 10.66.10.103:5173"],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Welcome message
app.get('/api', (req, res) => {
  res.json({ message: 'Welcome to the AIPB API!' });
});

// NFS Status endpoint
app.get('/api/nfs-status', (req, res) => {
  const status = nfsManager.getStatus();
  res.json({
    status: 'success',
    data: status,
    timestamp: new Date().toISOString()
  });
});

// ======= AUTH API ENDPOINTS =======
app.use('/api', auth);

// ======= FILE SYSTEM API ENDPOINTS =======
app.use('/api/filesystem', filesystemRouter);
app.use('/api/fs', filesystemRouter); // Additional alias for filesystem
app.use('/api/files', filesystemRouter); // Additional alias for files (for temp uploads)
app.use('/api', sendRouter);

// ======= CHAT API ENDPOINTS =======
app.use('/api/chat', chatRouter);

// ======= MYDRIVE API ENDPOINTS =======
app.use('/api/mydrive', mydriveRouter);

// ======= SYSTEM API ENDPOINTS =======
app.use('/api/system', systemRouter);

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('⚠️  Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n📡 Received ${signal}. Starting graceful shutdown...`);
  
  try {
    // Close HTTP server first
    if (httpServer) {
      console.log('🔄 Closing HTTP server...');
      httpServer.close(() => {
        console.log('✅ HTTP server closed');
      });
    }
    
    // Close RabbitMQ connection
    if (rabbitmq) {
      console.log('🔄 Closing RabbitMQ connection...');
      await rabbitmq.close();
      console.log('✅ RabbitMQ connection closed');
    }
    
    // Shutdown NFS manager (unmount and stop file operations)
    await nfsManager.gracefulShutdown();
    
    console.log('✅ Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle Windows specific signals
if (process.platform === 'win32') {
  process.on('message', (msg) => {
    if (msg === 'shutdown') {
      gracefulShutdown('Windows shutdown');
    }
  });
}

// Start HTTP server immediately (non-blocking)
async function startHTTPServer() {
  console.log('🚀 Starting HTTP server...');
  
  httpServer = server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ HTTP Server running on http://0.0.0.0:${PORT}`);
    console.log(`📡 Server accessible at http://10.66.10.103:${PORT}`);
    console.log('🔌 Socket.IO server initialized');
    console.log('📡 All HTTP endpoints are now available');
    
    // Initialize Socket.IO chat handlers
    initializeSocketChat(io);
    console.log('💬 Socket.IO chat handlers initialized');
  });
  
  httpServer.on('error', (error) => {
    console.error('❌ HTTP Server error:', error);
  });
}

// Start server immediately without NFS dependency
async function startServer() {
  console.log('🚀 Starting AIPB Backend Server...');
  
  try {
    // Initialize RabbitMQ connection
    await initializeRabbitMQ();
    
    // Start HTTP server immediately (NFS will be mounted on login)
    console.log('🔄 Starting HTTP server...');
    await startHTTPServer();
    
    console.log('🎉 Server startup complete - HTTP services ready!');
    console.log('📡 NFS will be mounted when user logs in');
  } catch (error) {
    console.error('❌ Server startup failed:', error.message);
    console.error('💡 Please ensure:');
    console.error('   1. RabbitMQ server is running (optional for basic operation)');
    process.exit(1);
  }
}

// Start the server
startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});

