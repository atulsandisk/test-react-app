import { httpsAgent } from './auth.js';
import rabbitmq, {FOREIGN_SERVER_CONFIG } from './rabbitmq.js';
import { globalSessionNames, globalChatHistory, getCurrentUserId, MODEL_TYPES } from './chat.js';
import fetch from 'node-fetch';

// Token accumulation for thinking processing
const tokenBuffers = new Map(); // { sessionKey: { tokens: [], fullContent: '', model: '' } }

// Function to get model name from ID (imported logic from chat.js)
const getModelNameFromId = (modelId) => {
  // Handle undefined, null, or non-string model IDs
  if (!modelId) return 'unknown';
  
  // Convert to string if it's a number
  const modelIdStr = String(modelId);
  
  // Direct match
  if (MODEL_TYPES[modelIdStr]) {
    return modelIdStr;
  }
  
  // Fallback mappings based on /modellist endpoint - CORRECTED ORDER
  const modelMappings = {
    '1': 'Llama-3.1-8B-Instruct-UD',  // DeepSeek Llama (model_id: 1)
    '2': 'gpt-oss-20b',   // DeepSeek Qwen (model_id: 2)
    '3': 'Qwen-1.5B-QuickChat',                   // GPT-OSS 20B (model_id: 3)
    '4': 'InterVL-Vision-LLM',     // Llama 3.1 (model_id: 4)
  
    // Legacy mappings for backwards compatibility
    'gpt-oss': 'gpt-oss-20b',
    'qwen': 'Qwen-1.5B-QuickChat',
    'llama': 'Llama-3.1-8B-Instruct-UD',
    'Vission-LLM': 'InterVL-Vision-LLM'
  };
  
  const lowerModelId = modelIdStr.toLowerCase();
  for (const [key, value] of Object.entries(modelMappings)) {
    if (lowerModelId.includes(key)) {
      return value;
    }
  }
  
  return modelIdStr; // Return original string if no mapping found
};

// Helper function to generate session title from first message (like ChatGPT)
const generateSessionTitle = (firstMessage) => {
  if (!firstMessage || typeof firstMessage !== 'string') return 'New Chat';
  const trimmed = firstMessage.trim();
  if (!trimmed) return 'New Chat';
  // Take first 50 characters and add ellipsis if longer
  return trimmed.length > 50 
    ? trimmed.substring(0, 50).trim() + '...'
    : trimmed;
};

// 🆕 Helper function to remove incomplete chat from globalChatHistory (for stopped chats)
const removeIncompleteChatFromHistory = (userId, sessionId, chatId) => {
  const historyKey = `${userId}_${sessionId}`;
  if (!globalChatHistory[historyKey]) {
    console.log(`📭 No history found for ${historyKey}`);
    return;
  }

  const beforeLength = globalChatHistory[historyKey].length;
  
  // Remove messages with this specific chat_id that are incomplete
  globalChatHistory[historyKey] = globalChatHistory[historyKey].filter(msg => {
    const shouldRemove = msg.chat_id === chatId && (!msg.isComplete || msg.isComplete === false);
    if (shouldRemove) {
      console.log(`🗑️ Removing incomplete ${msg.role} message for chat_id ${chatId}`);
    }
    return !shouldRemove;
  });

  const afterLength = globalChatHistory[historyKey].length;
  const removedCount = beforeLength - afterLength;
  
  if (removedCount > 0) {
    console.log(`✅ Removed ${removedCount} incomplete message(s) for chat_id ${chatId} from globalChatHistory`);
  } else {
    console.log(`ℹ️ No incomplete messages found for chat_id ${chatId}`);
  }
};

// Enhanced thinking processor for token streaming
const processTokenStreamThinking = (token, sessionKey, modelId, io, roomId, chatId, sessionId) => {
  if (!token || typeof token !== 'string') {
    return token || '';
  }
  
  // Get or create token buffer for this session
  if (!tokenBuffers.has(sessionKey)) {
    tokenBuffers.set(sessionKey, {
      tokens: [],
      fullContent: '',
      model: getModelNameFromId(modelId),
      thinkingContent: '',
      isInThinking: false,
      hasThinkingStarted: false,
      isInResponseTags: false,
      hasResponseStarted: false,
      // New fields for retroactive thinking logic
      pendingThinkingTokens: [],     // Store tokens streamed to main chat during thinking
      thinkingMessageId: null        // Track message ID for potential retroactive move
    });
    console.log(`🧠 Created new token buffer for session: ${sessionKey}, model: ${getModelNameFromId(modelId)}`);
  }
  
  const buffer = tokenBuffers.get(sessionKey);
  
  // Update model for current chat (handles model switching in same session)
  const currentModel = getModelNameFromId(modelId);
  if (buffer.model !== currentModel) {
    console.log(`🔄 Model switched in session ${sessionKey}: ${buffer.model} → ${currentModel}`);
    buffer.model = currentModel;
    // Reset thinking state when model changes
    buffer.isInThinking = false;
    buffer.hasThinkingStarted = false;
    buffer.isInResponseTags = false;
    buffer.hasResponseStarted = false;
    buffer.thinkingContent = '';
    // Reset new retroactive thinking fields
    buffer.pendingThinkingTokens = [];
    buffer.thinkingMessageId = null;
  }
  
  buffer.tokens.push(token);
  buffer.fullContent += token;
  
  // Debug: Log every token to trace the pattern
  console.log(`🔍 Token #${buffer.tokens.length}: "${token}" | Buffer content: "${buffer.fullContent.substring(0, 100)}..."`);
  
  // CRITICAL DEBUG: Log model detection
  // console.log(`🎯 MODEL DEBUG - Using modelId: "${modelId}", mapped to: "${buffer.model}", sessionKey: "${sessionKey}"`);
  
  // SPECIAL DEBUG: Check for <think> tags in buffer content
  const hasThinkStart = buffer.fullContent.includes('<think>');
  const hasThinkEnd = buffer.fullContent.includes('</think>');
  if (hasThinkStart || hasThinkEnd) {
    console.log(`🎯 THINK TAG DETECTION - Buffer contains <think>: ${hasThinkStart}, </think>: ${hasThinkEnd}`);
    console.log(`🎯 Full buffer content: "${buffer.fullContent}"`);
  }
  
  // SPECIAL DEBUG: Check for GPT-OSS tags in buffer content
  const hasGptAnalysis = buffer.fullContent.includes('<|channel|>analysis<|message|>');
  const hasGptStart = buffer.fullContent.includes('<|start|>assistant<|channel|>final<|message|>');
  const hasGptEnd = buffer.fullContent.includes('<|end|>');
  if (hasGptAnalysis || hasGptStart || hasGptEnd) {
    console.log(`🎯 GPT-OSS TAG DETECTION - Analysis: ${hasGptAnalysis}, Start: ${hasGptStart}, End: ${hasGptEnd}`);
    console.log(`🎯 GPT-OSS Buffer State - isInThinking: ${buffer.isInThinking}, hasThinkingStarted: ${buffer.hasThinkingStarted}, isInResponseTags: ${buffer.isInResponseTags}, hasResponseStarted: ${buffer.hasResponseStarted}`);
    console.log(`🎯 Full buffer content: "${buffer.fullContent}"`);
  }
  
  // Get model configuration
  const modelConfig = MODEL_TYPES[buffer.model];
  if (!modelConfig || !modelConfig.supports_thinking) {
    // console.log(`🚫 Model ${buffer.model} does not support thinking - passing through token`);
    return token; // Pass through if model doesn't support thinking
  }
  
  const { thinking_tags, response_tags } = modelConfig;
  console.log(`🏷️ Using thinking tags for ${buffer.model}: start="${thinking_tags.start}", end="${thinking_tags.end}"`);
  console.log(`🏷️ Using response tags for ${buffer.model}: start="${response_tags.start}", end="${response_tags.end}"`);
  
  // Check for thinking start tag
  if (thinking_tags.start && buffer.fullContent.includes(thinking_tags.start) && !buffer.hasThinkingStarted) {
    console.log(`🧠 Thinking start detected for ${buffer.model} at position ${buffer.fullContent.indexOf(thinking_tags.start)}`);
    
    // 🔍 EDGE CASE: Check for empty thinking tags like <think></think>
    if (thinking_tags.end && buffer.fullContent.includes(thinking_tags.end)) {
      const startIndex = buffer.fullContent.indexOf(thinking_tags.start);
      const endIndex = buffer.fullContent.indexOf(thinking_tags.end, startIndex);
      const thinkingContent = buffer.fullContent.substring(startIndex + thinking_tags.start.length, endIndex).trim();
      
      if (!thinkingContent || thinkingContent.length === 0) {
        console.log(`🚫 Empty thinking tags detected: <think></think> - skipping thinking mode`);
        // Remove empty thinking tags and continue with normal streaming
        const beforeThinking = buffer.fullContent.substring(0, startIndex);
        const afterThinking = buffer.fullContent.substring(endIndex + thinking_tags.end.length);
        const cleanContent = beforeThinking + afterThinking;
        
        // Return the cleaned content without thinking tags
        if (cleanContent.trim()) {
          console.log(`📤 Streaming content after removing empty thinking tags: "${cleanContent.substring(0, 50)}..."`);
          return cleanContent;
        }
        return '';
      }
    }
    
    buffer.isInThinking = true;
    buffer.hasThinkingStarted = true;
    
    // Generate unique message ID for tracking
    buffer.thinkingMessageId = `thinking_${sessionKey}_${Date.now()}`;
    console.log(`🆔 Generated thinking message ID: ${buffer.thinkingMessageId}`);
    
    // Extract thinking start position
    const startIndex = buffer.fullContent.indexOf(thinking_tags.start);
    const beforeThinking = buffer.fullContent.substring(0, startIndex);
    
    // Stream any content before thinking (if any)
    if (beforeThinking.trim()) {
      console.log(`📤 Streaming content before thinking: "${beforeThinking}"`);
      io.to(roomId).emit('chat-stream', {
        type: 'stream',
        content: beforeThinking,
        chat_id: chatId,
        session_id: sessionId,
        timestamp: new Date().toISOString()
      });
    }
    
    // Start accumulating thinking content (exclude the start tag)
    buffer.thinkingContent = buffer.fullContent.substring(startIndex + thinking_tags.start.length);
    console.log(`🧠 Started accumulating thinking content: "${buffer.thinkingContent.substring(0, 50)}..."`);
    console.log(`🎯 NEW LOGIC: Will stream thinking tokens to main chat and track for potential retroactive move`);
    return ''; // Don't stream thinking start tag
  }
  
  // If we're in thinking mode, accumulate content
  if (buffer.isInThinking) {
    buffer.thinkingContent += token;
    console.log(`🧠 Accumulating thinking token: "${token}" | Total thinking: "${buffer.thinkingContent.substring(0, 100)}..."`);
    
    // 🚀 NEW RETROACTIVE LOGIC: Stream thinking tokens to MAIN CHAT immediately
    // Track these tokens for potential retroactive move to thinking box
    if (token.trim() && token !== thinking_tags.start && token !== thinking_tags.end) {
      buffer.pendingThinkingTokens.push(token);
      console.log(`📡 NEW LOGIC: Streaming thinking token to MAIN CHAT: "${token}"`);
      
      // Stream to main chat area with special tracking
      io.to(roomId).emit('chat-stream', {
        type: 'stream',
        content: token,
        chat_id: chatId,
        session_id: sessionId,
        messageId: buffer.thinkingMessageId, // Add message ID for tracking
        isPendingThinking: true, // Mark as potentially thinking content
        timestamp: new Date().toISOString()
      });
    }
    
    // 🎯 SPECIAL LOGIC FOR GPT-OSS: Check for response start tag as thinking completion signal
    // For GPT-OSS, thinking ends when we see "<|channel|>final<|message|>" (part of response start)
    const isGptOss = buffer.model === 'gpt-oss-20b' || buffer.model === '3';
    const gptOssResponseSignal = '<|channel|>final<|message|>';
    
    let thinkingEndDetected = false;
    let endIndex = -1;
    let thinkingOnly = '';
    
    if (isGptOss && buffer.thinkingContent.includes(gptOssResponseSignal)) {
      // For GPT-OSS: Use response start signal as thinking end
      console.log(`🎯 GPT-OSS: Response start signal detected as thinking completion: "${gptOssResponseSignal}"`);
      endIndex = buffer.thinkingContent.indexOf(gptOssResponseSignal);
      thinkingOnly = buffer.thinkingContent.substring(0, endIndex).trim();
      thinkingEndDetected = true;
    } else if (!isGptOss && thinking_tags.end && buffer.thinkingContent.includes(thinking_tags.end)) {
      // For other models: Use standard thinking end tag
      console.log(`🏁 Standard thinking end detected for ${buffer.model} at position ${buffer.thinkingContent.indexOf(thinking_tags.end)}`);
      endIndex = buffer.thinkingContent.indexOf(thinking_tags.end);
      thinkingOnly = buffer.thinkingContent.substring(0, endIndex).trim();
      thinkingEndDetected = true;
    }
    
    if (thinkingEndDetected) {
      
      // 🔍 VALIDATION: Only process non-empty thinking content
      if (thinkingOnly && thinkingOnly.length > 0) {
        console.log(`� RETROACTIVE MOVE: Moving content from main chat to thinking box`);
        console.log(`📡 Content to move: "${thinkingOnly.substring(0, 100)}..."`);
        
        // Send retroactive move command to frontend
        io.to(roomId).emit('chat-stream', {
          type: 'move_to_thinking',
          content: thinkingOnly,
          chat_id: chatId,
          session_id: sessionId,
          messageId: buffer.thinkingMessageId,
          pendingTokens: buffer.pendingThinkingTokens,
          timestamp: new Date().toISOString()
        });
        
        // Send thinking complete signal
        io.to(roomId).emit('chat-stream', {
          type: 'thinking_complete',
          chat_id: chatId,
          session_id: sessionId,
          timestamp: new Date().toISOString()
        });
        console.log(`✅ Sent retroactive move and thinking_complete signals`);
        
        // 🎯 STORE THINKING CONTENT IN GLOBAL CHAT HISTORY for persistence
        console.log(`💾 Storing meaningful thinking content in globalChatHistory for session: ${sessionKey}`);
        const historyKey = sessionKey;
        const userId = sessionKey.split('_')[0]; // Extract userId from sessionKey format: userId_sessionId
        
        if (!globalChatHistory[historyKey]) {
          globalChatHistory[historyKey] = [];
        }
        
        // Find the last assistant message and add thinking content
        const lastMessage = globalChatHistory[historyKey][globalChatHistory[historyKey].length - 1];
        if (lastMessage && lastMessage.role === 'assistant' && !lastMessage.isComplete) {
          lastMessage.thinkingContent = thinkingOnly;
          lastMessage.hasThinking = true;
          console.log(`✅ Added thinking content to existing assistant message in globalChatHistory`);
        } else {
          // Create new assistant message with thinking content
          globalChatHistory[historyKey].push({
            role: 'assistant',
            content: '', // Will be filled by subsequent tokens
            thinkingContent: thinkingOnly,
            hasThinking: true,
            timestamp: new Date().toISOString(),
            message_type: 'assistant_with_thinking',
            chat_id: chatId,
            session_id: sessionId,
            user_id: userId,
            isComplete: false,
            token_count: 0
          });
          console.log(`✅ Created new assistant message with thinking content in globalChatHistory`);
        }
      } else {
        console.log(`🚫 Empty thinking content detected - leaving content in main chat`);
      }
      
      buffer.isInThinking = false;
      // Reset retroactive tracking
      buffer.pendingThinkingTokens = [];
      buffer.thinkingMessageId = null;
      
      // Continue with content after thinking end
      let afterThinking = '';
      if (isGptOss) {
        // For GPT-OSS: Content after the response signal is the main response
        afterThinking = buffer.thinkingContent.substring(endIndex + gptOssResponseSignal.length);
        console.log(`📝 GPT-OSS content after response signal: "${afterThinking.substring(0, 50)}..."`);
      } else {
        // For other models: Content after thinking end tag
        afterThinking = buffer.thinkingContent.substring(endIndex + thinking_tags.end.length);
        console.log(`📝 Content after thinking end: "${afterThinking.substring(0, 50)}..."`);
      }
      
      // Check if we have response start tag in the remaining content (for non-GPT-OSS models)
      if (!isGptOss && response_tags.start && afterThinking.includes(response_tags.start)) {
        console.log(`🎯 Response start tag detected in remaining content`);
        const responseStartIndex = afterThinking.indexOf(response_tags.start);
        const beforeResponse = afterThinking.substring(0, responseStartIndex);
        
        // Stream any content before response start (if any)
        if (beforeResponse.trim()) {
          console.log(`📤 Streaming content before response start: "${beforeResponse}"`);
          return beforeResponse;
        }
        
        // Mark that we're now in response tags and skip the response start tag
        buffer.isInResponseTags = true;
        buffer.hasResponseStarted = true;
        const afterResponseStart = afterThinking.substring(responseStartIndex + response_tags.start.length);
        console.log(`🎯 Skipping response start tag, content after: "${afterResponseStart.substring(0, 50)}..."`);
        
        if (afterResponseStart.trim()) {
          return afterResponseStart;
        }
        return '';
      }
      
      // For GPT-OSS: We've already extracted the main response content after the signal
      if (isGptOss) {
        console.log(`🎯 GPT-OSS: Processing main response content directly`);
        // Mark as in response tags since we're now in the main response
        buffer.isInResponseTags = true;
        buffer.hasResponseStarted = true;
        
        if (afterThinking.trim()) {
          return afterThinking;
        }
        return '';
      }
      
      // If no response tags are configured or found, stream content directly
      if (!response_tags.start || !response_tags.end) {
        console.log(`📤 No response tags configured for ${buffer.model}, streaming content directly after thinking`);
        if (afterThinking.trim()) {
          return afterThinking;
        }
        return '';
      }
      
      if (afterThinking.trim()) {
        console.log(`📤 Streaming remaining content after thinking: "${afterThinking.substring(0, 50)}..."`);
        return afterThinking;
      }
      return '';
    }
    
    // Still in thinking, don't return content (already streamed to main chat above)
    return '';
  }
  
  // Check for response start tag (if not already detected)
  if (response_tags.start && !buffer.hasResponseStarted && buffer.fullContent.includes(response_tags.start)) {
    console.log(`🎯 Response start tag detected for ${buffer.model}: "${response_tags.start}"`);
    const responseStartIndex = buffer.fullContent.indexOf(response_tags.start);
    const beforeResponse = buffer.fullContent.substring(0, responseStartIndex);
    
    // Stream any content before response start
    if (beforeResponse.trim()) {
      console.log(`📤 Streaming content before response start: "${beforeResponse}"`);
      io.to(roomId).emit('chat-stream', {
        type: 'stream',
        content: beforeResponse,
        chat_id: chatId,
        session_id: sessionId,
        timestamp: new Date().toISOString()
      });
    }
    
    buffer.isInResponseTags = true;
    buffer.hasResponseStarted = true;
    
    // Return content after response start tag (exclude the tag itself)
    const afterResponseStart = buffer.fullContent.substring(responseStartIndex + response_tags.start.length);
    console.log(`🎯 Skipping response start tag, content after: "${afterResponseStart.substring(0, 50)}..."`);
    
    if (afterResponseStart.trim()) {
      return afterResponseStart;
    }
    return '';
  }
  
  // If we're in response tags, check for response end tag
  if (buffer.isInResponseTags && response_tags.end && buffer.fullContent.includes(response_tags.end)) {
    console.log(`🏁 Response end tag detected for ${buffer.model}: "${response_tags.end}"`);
    const responseEndIndex = buffer.fullContent.indexOf(response_tags.end);
    const responseContent = buffer.fullContent.substring(0, responseEndIndex);
    
    // Extract just the response content (after response start tag)
    const responseStartIndex = responseContent.indexOf(response_tags.start);
    const pureResponseContent = responseStartIndex >= 0 
      ? responseContent.substring(responseStartIndex + response_tags.start.length).trim()
      : responseContent.trim();
    
    console.log(`📤 Streaming pure response content: "${pureResponseContent.substring(0, 100)}..."`);
    
    // Reset response tag state
    buffer.isInResponseTags = false;
    
    // Continue with content after response end tag
    const afterResponse = buffer.fullContent.substring(responseEndIndex + response_tags.end.length);
    console.log(`📝 Content after response end: "${afterResponse.substring(0, 50)}..."`);
    
    // Return the pure response content
    if (pureResponseContent) {
      return pureResponseContent;
    }
    
    // If there's content after the response end tag, return that too
    if (afterResponse.trim()) {
      return afterResponse;
    }
    return '';
  }
  
  // If we're in response tags but haven't hit the end tag yet, stream the token
  if (buffer.isInResponseTags) {
    console.log(`📤 Streaming response token: "${token}"`);
    return token;
  }
  
  // Normal streaming (we're past thinking and response tags)
  console.log(`📤 Normal streaming token (post-thinking): "${token}"`);
  console.log(`📊 Buffer state: isInThinking=${buffer.isInThinking}, hasThinkingStarted=${buffer.hasThinkingStarted}, isInResponseTags=${buffer.isInResponseTags}`);
  return token;
};

// Clean up token buffer for session
const cleanupTokenBuffer = (sessionKey) => {
  if (tokenBuffers.has(sessionKey)) {
    tokenBuffers.delete(sessionKey);
    console.log(`🧹 Cleaned up token buffer for session: ${sessionKey}`);
  }
};

// 🚨 GLOBAL CONSUMER MANAGEMENT - Prevent consumer accumulation
let globalActiveConsumer = null;      // Track the currently active consumer
let globalConsumerCount = 0;          // Count total consumers created
let globalStreamingSessions = new Map(); // Track active streaming sessions

// Function to cleanup any existing consumer before creating new one
const forceCleanupAllConsumers = async () => {
  console.log(`🛑 FORCE CLEANUP: Cleaning up existing consumer before creating new one`);
  
  if (globalActiveConsumer) {
    try {
      await rabbitmq.cancelConsumer(globalActiveConsumer);
      console.log(`✅ Cancelled existing consumer: ${globalActiveConsumer.consumerTag}`);
      globalActiveConsumer = null;
    } catch (error) {
      console.error('❌ Error cleaning up existing consumer:', error);
    }
  }
  
  // Clear any active streaming sessions
  globalStreamingSessions.clear();
  console.log(`🧹 Consumer cleanup complete. Ready for new consumer.`);
};

// 🆕 NEW: Function to cleanup consumer for specific session (used by /stop endpoint)
const forceCleanupConsumerForSession = async (userId, sessionId, chatId = null) => {
  console.log(`🛑 STOP CLEANUP: Looking for consumer matching user: ${userId}, session: ${sessionId}, chat: ${chatId}`);
  
  if (globalActiveConsumer) {
    const consumerTag = globalActiveConsumer.consumerTag || '';
    console.log(`🔍 STOP CLEANUP: Checking active consumer tag: ${consumerTag}`);
    
    // Check if consumer tag matches the session pattern
    const sessionPattern = `${userId}_${sessionId}`;
    const chatPattern = chatId ? `${userId}_${sessionId}_${chatId}` : null;
    
    const matchesSession = consumerTag.includes(sessionPattern);
    const matchesChat = chatPattern ? consumerTag.includes(chatPattern) : false;
    
    if (matchesSession || matchesChat) {
      console.log(`🎯 STOP CLEANUP: Found matching consumer to cancel: ${consumerTag}`);
      try {
        await rabbitmq.cancelConsumer(globalActiveConsumer);
        globalActiveConsumer = null;
        console.log(`✅ STOP CLEANUP: Successfully cancelled consumer for stopped session`);
        
        // 🆕 CRITICAL FIX: Remove incomplete chat from globalChatHistory to prevent ID mismatch
        if (chatId) {
          console.log(`🧹 STOP CLEANUP: Removing incomplete chat_id ${chatId} from globalChatHistory`);
          removeIncompleteChatFromHistory(userId, sessionId, chatId);
        }
        
        // Clean up session tracking
        const sessionKey = `${userId}_${sessionId}`;
        globalStreamingSessions.delete(sessionKey);
        cleanupTokenBuffer(sessionKey);
        
        return true; // Consumer was found and cancelled
      } catch (error) {
        console.error('❌ STOP CLEANUP: Error cancelling consumer:', error);
        return false;
      }
    } else {
      console.log(`ℹ️ STOP CLEANUP: Active consumer doesn't match session pattern, no cleanup needed`);
      return false;
    }
  } else {
    console.log(`ℹ️ STOP CLEANUP: No active consumer found, nothing to clean up`);
    return false;
  }
};


// Socket.IO-based chat handler
export const initializeSocketChat = (io) => {
  //console.log('🔌 Initializing Socket.IO chat handlers');
  
  io.on('connection', (socket) => {
    //console.log('🔌 Socket connected for chat:', socket.id);
    
    // Handle chat message through Socket.IO
    socket.on('send-chat-message', async (data) => {
      //console.log('💬 Socket chat message received:', data);
      
      try {
        const {
          prompt,  // Direct prompt extraction
          message,
          session_id,  // Direct extraction
          chat_id,
          instance_id, // 🆕 CRITICAL: Extract instance_id for message filtering
          llm_model_id,
          summarize_flag,
          codebase_search_flag,
          personalize_flag,
          temp_file_flag,
          web_search_flag,
          // first_chat_flag, // Commented out - unused
          temp_file_paths,
          // userId, // Commented out - unused  
          roomId,
          authToken: receivedAuthToken  // Rename to avoid conflict
        } = data;

        // Use prompt directly or fallback to message
        const finalPrompt = prompt || message;

        // Extract user from socket - always use stored user from login
        const user_id = data.userId || getCurrentUserId();
        const authToken = receivedAuthToken;
        
        if (!user_id) {
          console.error('❌ No user ID available - user must login first');
          socket.emit('error', { error: 'Authentication required. Please login first.' });
          return;
        }
        
        //console.log('🚀 Starting Socket.IO chat processing for user:', user_id);
        //console.log('🔐 Auth token received:', authToken ? `${authToken.substring(0, 20)}...` : 'No token');
        //console.log('📝 Extracted prompt:', finalPrompt);

        // Use provided IDs directly (no database calls)
        const finalUserId = user_id;  // Use the authenticated user ID
        const finalSessionId = session_id || '1';
        const finalChatId = chat_id || '1';
        const finalInstanceId = instance_id; // 🆕 Store instance_id
        const first_chat_flag_final = data.first_chat_flag || false;

        //console.log(`📊 Using User: ${finalUserId}, Session: ${finalSessionId}, Chat: ${finalChatId}, First chat: ${first_chat_flag_final}`);

        // 🧹 CRITICAL: Reset token buffer and all flags for new chat to prevent thinking state carryover
        const sessionKey = `${finalUserId}_${finalSessionId}`;
        console.log(`🧹 Resetting token buffer and flags for new chat - Session: ${sessionKey}`);
        cleanupTokenBuffer(sessionKey);
        // Also forcibly reset all buffer state for this session
        tokenBuffers.set(sessionKey, {
          tokens: [],
          fullContent: '',
          model: getModelNameFromId(llm_model_id),
          thinkingContent: '',
          isInThinking: false,
          hasThinkingStarted: false,
          isInResponseTags: false,
          hasResponseStarted: false,
          // Reset new retroactive thinking fields
          pendingThinkingTokens: [],
          thinkingMessageId: null
        });

        // STORE USER PROMPT IN GLOBAL CHAT HISTORY
        const historyKey = `${finalUserId}_${finalSessionId}`;
        if (!globalChatHistory[historyKey]) {
          globalChatHistory[historyKey] = [];
        }
        
        // Add user prompt to chat history with enhanced metadata
        globalChatHistory[historyKey].push({
          role: 'user',
          content: finalPrompt,
          chat_id: finalChatId, // Include chat_id for consistency
          session_id: finalSessionId, // Include session_id for consistency
          user_id: finalUserId, // Include user_id for consistency
          timestamp: new Date().toISOString(),
          message_type: 'user_prompt',
          isComplete: false // 🆕 Mark as incomplete until response completes
        });
        
        //console.log(`💾 Stored user prompt in globalChatHistory for session ${finalSessionId}`);

        // Note: User message display is handled by frontend, no need to echo back

        // Prepare payload for foreign server
        const payload = {
          user_id: String(finalUserId),
          chat_id: String(finalChatId),
          session_id: String(finalSessionId),
          llm_model_id: String(llm_model_id || "1"),
          summarize_flag: Boolean(summarize_flag || false),
          codebase_search_flag: Boolean(codebase_search_flag || false),
          personalize_flag: Boolean(personalize_flag || false),
          temp_file_flag: Boolean(temp_file_flag || false),
          first_chat_flag: Boolean(first_chat_flag_final),
          web_search_flag: Boolean(web_search_flag || false),
          prompt: String(finalPrompt),
          temp_file_paths: Array.isArray(temp_file_paths) ? temp_file_paths : []
        };

        //console.log('📡 Sending payload to foreign server:', JSON.stringify(payload, null, 2));

        // RabbitMQ consumer state
        let rabbitConsumer = null;
        let isStreamingComplete = false;
        let messageCount = 0;
        let completionTimeout = null;

        // Create unique consumer tag to track this specific consumer
        const consumerTag = `socket_${socket.id}_${finalSessionId}_${finalChatId}_${Date.now()}`;

        const cleanupConsumer = async () => {
          if (rabbitConsumer && !isStreamingComplete) {
            console.log(`🛑 Stopping RabbitMQ consumer: ${consumerTag}`);
            try {
              if (completionTimeout) {
                clearTimeout(completionTimeout);
                completionTimeout = null;
              }
              
              const cancelled = await rabbitmq.cancelConsumer(rabbitConsumer);
              console.log(cancelled ? `✅ Consumer ${consumerTag} cancelled` : '⚠️ Consumer cleanup skipped');
            } catch (error) {
              console.error('❌ Error cancelling RabbitMQ consumer:', error);
            }
            rabbitConsumer = null;
            globalActiveConsumer = null;  // Clear global tracking
            isStreamingComplete = true;
            
            // Clean up session context and token buffers
            const sessionKey = `${finalUserId}_${finalSessionId}`;
            globalStreamingSessions.delete(sessionKey);
            cleanupTokenBuffer(sessionKey);
          }
        };

        // Start RabbitMQ consumption
        //console.log('📡 Starting RabbitMQ consumption for Socket.IO streaming');
        
        try {
          // 🚨 FORCE CLEANUP ANY EXISTING CONSUMERS FIRST
          await forceCleanupAllConsumers();
          globalConsumerCount++;
          
          // Store session context for thinking processing AFTER cleanup
          const sessionKey = `${finalUserId}_${finalSessionId}`;
          console.log(`🔍 DEBUG: Storing session context with modelId: "${llm_model_id}", mapped to: "${getModelNameFromId(llm_model_id)}"`);
          globalStreamingSessions.set(sessionKey, {
            modelId: llm_model_id,
            chatId: finalChatId,
            instanceId: finalInstanceId, // 🆕 Store instance_id for message filtering
            sessionId: finalSessionId,
            userId: finalUserId,
            consumerTag
          });
          
          const connected = await rabbitmq.ensureConnection();
          if (!connected) {
            throw new Error('RabbitMQ connection unavailable');
          }

          console.log(`🔥 Creating NEW consumer #${globalConsumerCount} for chat ${finalChatId} (session: ${finalSessionId})`);

          // Start the consumer  
          rabbitmq.consumeQueue(rabbitmq.queues.chat, (message) => {
            // console.log(`📦 RabbitMQ message received - Raw:`, JSON.stringify(message, null, 2));
            
            try {
              if (isStreamingComplete) {
                // console.log(`⏹️ Consumer ${consumerTag} - Streaming complete, ignoring message`);
                return;
              }
            
              messageCount++;
              //console.log(`📨 Consumer ${consumerTag} - Message #${messageCount}:`, JSON.stringify(message, null, 2));
              //console.log(`🔍 Expected context - Chat: ${finalChatId}, Session: ${finalSessionId}`);
              //console.log(`🔍 Message context - Chat: ${message.chat_id}, Session: ${message.session_id}`);
              
              // FLEXIBLE FILTERING: Process messages that match chat_id
              if (message.chat_id) {
                const messageChatId = String(message.chat_id);
                const expectedChatId = String(finalChatId);
                
                if (messageChatId !== expectedChatId) {
                  //console.log(`🔄 Consumer ${consumerTag} - Ignoring message from different chat: ${messageChatId}, expecting: ${expectedChatId}`);
                  return;
                }
              }
              
              //console.log(`✅ Consumer ${consumerTag} - Processing message for correct session`);
              
              if (completionTimeout) {
                clearTimeout(completionTimeout);
                completionTimeout = null;
                //console.log(`⏰ Consumer ${consumerTag} - Cleared completion timeout`);
              }
              
              // console.log(`🔍 Checking message for completion signals:`, {
              //   type: message.type,
              //   status: message.status, 
              //   token: message.token,
              //   content: message.content ? message.content.substring(0, 100) + '...' : undefined,
              //   data: message.data ? message.data.substring(0, 100) + '...' : undefined
              // });
              
              // 🎯 SPECIAL DEBUG: Check if content contains problematic markdown patterns
              const contentText = message.content || message.data || '';
              const hasMarkdownPatterns = contentText.includes('**') || contentText.includes('====') || contentText.includes('```');
              if (hasMarkdownPatterns) {
                console.log(`🎯 MARKDOWN PATTERN DETECTED in message:`, {
                  type: message.type,
                  status: message.status,
                  token: message.token,
                  contentSnippet: contentText.substring(0, 200),
                  hasDoubleAsterisk: contentText.includes('**'),
                  hasEquals: contentText.includes('===='),
                  hasCodeBlock: contentText.includes('```'),
                  messageCount: messageCount,
                  timestamp: new Date().toISOString()
                });
              }
              
              // 🚨 CRITICAL DEBUG: Log ALL completion-related fields for every message
              // console.log(`🔍 FULL COMPLETION CHECK - Message #${messageCount}:`, {
              //   type: message.type,
              //   status: message.status,
              //   token: message.token,
              //   content_preview: message.content ? message.content.substring(0, 50) + '...' : 'undefined',
              //   data_preview: message.data ? message.data.substring(0, 50) + '...' : 'undefined',
              //   has_completion_type: message.type === 'completion',
              //   has_status_done: message.status === 'done',
              //   has_token_done: message.token === 'done',
              //   has_type_status: message.type === 'status',
              //   exact_completion_match: (message.type === 'status' && message.token === 'done') || (message.type === 'completion' && message.status === 'done')
              // });
              
              // Check for completion - VERY STRICT detection only for specific completion signals
              const isCompletionMessage = (
                // PRIMARY: Foreign server completion format - SPECIFIC status type with done token
                (message.type === 'status' && message.token === 'done') ||
                // SECONDARY: Only exact completion format - be very strict
                (message.type === 'completion' && message.status === 'done')
                // REMOVED ALL OTHER LOOSE COMPLETION CHECKS - too many false positives
                // These were causing markdown content to be detected as completion:
                // - message.type === 'completion'
                // - message.type === 'end' 
                // - message.type === 'done'
                // - message.content === '[DONE]' etc.
                // - message.status === 'complete' etc.
              );

              if (isCompletionMessage) {
                console.log(`🔍 COMPLETION DETECTED - Debug Info:`);
                console.log(`  - Message type: ${message.type}`);
                console.log(`  - Message status: ${message.status}`);
                console.log(`  - Message token: ${message.token}`);
                console.log(`  - Message content: ${message.content}`);
                console.log(`  - Message data: ${message.data}`);
                console.log(`  - Full message:`, JSON.stringify(message, null, 2));
                
                //console.log(`✅ Consumer ${consumerTag} - Completion signal detected`);
                //console.log(`🔍 Completion details - Type: ${message.type}, Status: ${message.status}, Chat: ${message.chat_id}`);
                
                // Validate completion message belongs to this chat
                if (message.chat_id && String(message.chat_id) !== String(finalChatId)) {
                  //console.log(`🔄 Consumer ${consumerTag} - Ignoring completion from different chat: ${message.chat_id}, expecting: ${finalChatId}`);
                  return;
                }
                
                isStreamingComplete = true;
                
                // MARK LAST MESSAGE AS COMPLETE IN GLOBAL CHAT HISTORY
                const historyKey = `${finalUserId}_${finalSessionId}`;
                if (globalChatHistory[historyKey] && globalChatHistory[historyKey].length > 0) {
                  // Mark assistant message as complete
                  const lastMessage = globalChatHistory[historyKey][globalChatHistory[historyKey].length - 1];
                  if (lastMessage && lastMessage.role === 'assistant') {
                    lastMessage.isComplete = true;
                    lastMessage.message_type = 'complete_response';
                    lastMessage.completion_timestamp = new Date().toISOString();
                    lastMessage.total_tokens = lastMessage.token_count || 1;
                    //console.log(`✅ Marked message as complete in globalChatHistory for session ${finalSessionId} (${lastMessage.total_tokens} tokens)`);
                  }
                  
                  // 🆕 CRITICAL FIX: Also mark the corresponding user message as complete
                  // Find the user message with the same chat_id
                  for (let i = globalChatHistory[historyKey].length - 1; i >= 0; i--) {
                    const msg = globalChatHistory[historyKey][i];
                    if (msg.role === 'user' && msg.chat_id === finalChatId && !msg.isComplete) {
                      msg.isComplete = true;
                      console.log(`✅ Marked user message as complete for chat_id ${finalChatId}`);
                      break;
                    }
                  }
                }
                
               

                // 🚀 SEND COMPLETION TO FRONTEND IMMEDIATELY 
                io.to(roomId).emit('chat-stream', {
                  type: 'complete',
                  content: 'Stream completed',
                  chat_id: finalChatId,
                  instance_id: finalInstanceId, // 🆕 Include instance_id for frontend filtering
                  session_id: finalSessionId,
                  completion_type: message.type,
                  total_tokens: messageCount,
                  timestamp: new Date().toISOString()
                });
                
                console.log(`✅ Sent completion signal to frontend immediately`);
                console.log(`🔚 RabbitMQ completion signal received - foreign server HTTP response can come later`);
                
                // Cleanup consumer after a short delay to allow foreign server response
                setTimeout(() => {
                  cleanupConsumer();
                }, 1000); // 1 second delay
                return;
              }
              
              // Extract response content - Handle token-by-token streaming from foreign server
              let responseContent = '';
              
              // PRIORITY 1: Handle token streaming (type: "token", data: token_text)
              if (message.type === 'token' && message.data) {
                responseContent = message.data;
                //console.log(`🎯 Token detected from foreign server - Chat: ${message.chat_id}, Token: "${responseContent}"`);
              }
              // PRIORITY 2: Handle other data formats
              else if (message.data && typeof message.data === 'string') {
                responseContent = message.data;
              } else if (typeof message === 'string') {
                responseContent = message;
              } else if (message.response) {
                responseContent = typeof message.response === 'string' ? message.response : JSON.stringify(message.response);
              } else if (message.content) {
                responseContent = message.content;
              } else if (message.message) {
                responseContent = message.message;
              } else {
                responseContent = JSON.stringify(message);
              }
              
              // Stream content if valid - Enhanced for token-by-token streaming
              if (responseContent) {
                const isTokenMessage = message.type === 'token';
                //console.log(`🔄 ${isTokenMessage ? 'TOKEN' : 'CONTENT'} #${messageCount} for chat ${finalChatId}:`, 
                        //    responseContent.length > 50 ? responseContent.substring(0, 50) + '...' : responseContent);
                
                // STORE STREAMING RESPONSE IN GLOBAL CHAT HISTORY
                const historyKey = `${finalUserId}_${finalSessionId}`;
                if (!globalChatHistory[historyKey]) {
                  globalChatHistory[historyKey] = [];
                }
                
                // Append streaming content to the last assistant message or create new one
                const lastMessage = globalChatHistory[historyKey][globalChatHistory[historyKey].length - 1];
                if (lastMessage && lastMessage.role === 'assistant' && !lastMessage.isComplete) {
                  // Append token to existing streaming message
                  lastMessage.content = (lastMessage.content || '') + responseContent;
                  lastMessage.timestamp = new Date().toISOString();
                  lastMessage.token_count = (lastMessage.token_count || 0) + 1;
                  if (isTokenMessage) {
                    lastMessage.message_type = 'streaming_tokens';
                  }
                } else {
                  // Create new assistant message for streaming
                  globalChatHistory[historyKey].push({
                    role: 'assistant',
                    content: responseContent,
                    timestamp: new Date().toISOString(),
                    message_type: isTokenMessage ? 'streaming_tokens' : 'streaming_content',
                    chat_id: finalChatId,
                    session_id: finalSessionId,
                    user_id: finalUserId, // Add user_id for consistency
                    isComplete: false,
                    token_count: 1
                  });
                }
                
                // EXTRACT SESSION NAME from USER PROMPT (not AI response) for session creation
                // This runs only once when first response arrives to create session with user's original question
                if (messageCount <= 3 && responseContent && responseContent.trim().length > 2) {
                  const existingSessionIndex = globalSessionNames.findIndex(s => s.session_id === finalSessionId && s.user_id === finalUserId);
                  if (existingSessionIndex === -1) {
                    // 🔧 FIX: Use USER PROMPT instead of AI response to avoid think tags in session title
                    // Find the user message in globalChatHistory for this session
                    const userMessage = globalChatHistory[historyKey]?.find(msg => msg.role === 'user' && msg.chat_id === finalChatId);
                    const userPrompt = userMessage?.content || finalPrompt;
                    const sessionTitle = generateSessionTitle(userPrompt);
                    
                    globalSessionNames.unshift({
                      session_id: finalSessionId,
                      title: sessionTitle,
                      user_id: finalUserId,
                      current_chat_id: finalChatId, // Track current chat_id
                      total_chats: 1, // Initialize chat count
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString()
                    });
                    
                    console.log(`📝 Created session from USER PROMPT: "${sessionTitle}" for session ${finalSessionId} with chat_id ${finalChatId}`);
                  } else {
                    // Update existing session with current chat_id
                    globalSessionNames[existingSessionIndex].current_chat_id = finalChatId;
                    globalSessionNames[existingSessionIndex].updated_at = new Date().toISOString();
                  }
                }
                
                // 🧠 THINKING PROCESSING: Process token through thinking system
                const sessionKey = `${finalUserId}_${finalSessionId}`;
                const sessionContext = globalStreamingSessions.get(sessionKey);
                // console.log(`🔍 DEBUG: Retrieving session context for key "${sessionKey}":`, sessionContext);
                // console.log(`🔍 DEBUG: Available session keys:`, Array.from(globalStreamingSessions.keys()));
                const processedToken = processTokenStreamThinking(
                  responseContent, 
                  sessionKey, 
                  sessionContext?.modelId || 'unknown',
                  io, 
                  roomId, 
                  finalChatId, 
                  finalSessionId
                );
                
                // Only stream if we have processed content (non-thinking content)
                if (processedToken && processedToken.trim()) {
                  console.log('📡 Streaming response to frontend:', processedToken);
                  io.to(roomId).emit('chat-stream', {
                    type: 'stream',
                    content: processedToken,
                    chat_id: finalChatId,
                    instance_id: finalInstanceId, // 🆕 Include instance_id for frontend filtering
                    session_id: finalSessionId,
                    token_number: messageCount,
                    timestamp: new Date().toISOString()
                  });
                } else {
                  console.log('🤫 Suppressed thinking content from frontend streaming');
                }
                
                //console.log(`📡 Streamed ${message.type === 'token' ? 'token' : 'content'} #${messageCount} to frontend via Socket.IO`);
                
                // Set safety timeout
                if (completionTimeout) {
                  clearTimeout(completionTimeout);
                }
                completionTimeout = setTimeout(() => {
                  if (!isStreamingComplete) {
                    //console.log('⏰ Safety timeout triggered - no completion message received in 60 seconds');
                    isStreamingComplete = true;
                    io.to(roomId).emit('chat-stream', {
                      type: 'complete',
                      content: 'Stream completed (safety timeout)',
                      instance_id: finalInstanceId, // 🆕 Include instance_id for frontend filtering
                      timestamp: new Date().toISOString()
                    });
                    cleanupConsumer();
                  }
                }, 60000); // 60 seconds safety timeout
              }
              
            } catch (error) {
              console.error('❌ Error processing RabbitMQ message for Socket.IO:', error);
            }
          }).then((consumer) => {
            rabbitConsumer = consumer;
            globalActiveConsumer = consumer;  // Store in global tracking
            console.log('✅ RabbitMQ consumer started for Socket.IO with tag:', consumer.consumerTag);
          }).catch((error) => {
            console.error('❌ Error starting RabbitMQ consumer for Socket.IO:', error);
          });

          // Send request to foreign server in parallel
          //console.log('🌐 Sending request to foreign server in parallel');
          
          try {
              console.log('Sending chat request to:', `${FOREIGN_SERVER_CONFIG.baseUrl}/chat with payload:`, JSON.stringify(payload, null));
              
              const foreignResponse = await fetch(`${FOREIGN_SERVER_CONFIG.baseUrl}/chat`, {
                  method: 'POST',
                  headers: {
                      'Content-Type': 'application/json',
                      'Authorization': authToken || ''
                  },
                  body: JSON.stringify(payload),
                  agent: httpsAgent
              });
          
              console.log(`✅ Foreign server HTTP response received (${foreignResponse.status}) - now sending completion to frontend`);
              // const responseData = await foreignResponse.json(); // parse once
              // console.log('🌍 Foreign server JSON response:', responseData);

              if (!foreignResponse.ok) {
                  const errorText = await foreignResponse.text();
                  console.log('Foreign server error:', errorText);
                  
                  // 🔧 FIX: Send error and immediate completion for foreign server errors
                  console.log(`🛑 Sending immediate completion due to foreign server error (${foreignResponse.status})`);
                  
                  // Parse error response if it's JSON
                  let errorMessage = errorText;
                  try {
                    const errorJson = JSON.parse(errorText);
                    errorMessage = errorJson.error || errorText;
                  } catch {
                    // Use raw text if not JSON
                  }
                  
                  // Send error message to frontend
                  io.to(roomId).emit('chat-stream', {
                    type: 'error',
                    content: `Error: ${errorMessage}`,
                    chat_id: finalChatId,
                    session_id: finalSessionId,
                    error_code: foreignResponse.status,
                    timestamp: new Date().toISOString()
                  });
                  
                  // Send completion immediately - don't wait for RabbitMQ
                  isStreamingComplete = true;
                  io.to(roomId).emit('chat-stream', {
                    type: 'complete',
                    content: 'Stream completed (foreign server error)',
                    chat_id: finalChatId,
                    session_id: finalSessionId,
                    completion_type: 'foreign_server_error',
                    error_code: foreignResponse.status,
                    total_tokens: messageCount,
                    timestamp: new Date().toISOString()
                  });
                  
                  // Cleanup immediately
                  console.log(`🧹 Cleaning up consumer immediately due to foreign server error`);
                  setTimeout(() => {
                    cleanupConsumer();
                  }, 500);
                  return; // Exit early on error
              }
              
              // 🔧 FIX: For SUCCESS - send completion after brief delay (let RabbitMQ finish streaming)
              console.log(`✅ Foreign server success (${foreignResponse.status}) - waiting briefly for RabbitMQ completion`);
              
              // Set a reasonable timeout for success cases to ensure completion
              setTimeout(() => {
                if (!isStreamingComplete) {
                  console.log(`🎯 Sending completion after foreign server success (safety)`);
                  isStreamingComplete = true;
                  
                  io.to(roomId).emit('chat-stream', {
                    type: 'complete',
                    content: 'Stream completed',
                    chat_id: finalChatId,
                    session_id: finalSessionId,
                    completion_type: 'foreign_server_success',
                    status_code: foreignResponse.status,
                    total_tokens: messageCount,
                    timestamp: new Date().toISOString()
                  });
                  
                  // Cleanup after success
                  console.log(`🧹 Cleaning up consumer after foreign server success`);
                  setTimeout(() => {
                    cleanupConsumer();
                  }, 1000);
                }
              }, 5000); // 5 second timeout for success cases
              
          } catch (error) {
              console.error('❌ Error sending to foreign server:', error);
              
              // 🔧 FIX: Send completion immediately on network error
              console.log(`🛑 Sending immediate completion due to network error: ${error.code || error.type || 'Unknown'}`);
              
              // Determine error message based on error type
              let userFriendlyMessage = 'Network connection error';
              if (error.code === 'ECONNRESET' || error.message.includes('socket hang up')) {
                userFriendlyMessage = 'Connection lost to AI server - please try again';
              } else if (error.code === 'ECONNREFUSED') {
                userFriendlyMessage = 'AI server is unavailable - please try again later';
              } else if (error.code === 'ETIMEDOUT') {
                userFriendlyMessage = 'Request timed out - please try again';
              } else {
                userFriendlyMessage = `Network error: ${error.message}`;
              }
              
              // Send network error to frontend
              io.to(roomId).emit('chat-stream', {
                type: 'error',
                content: userFriendlyMessage,
                chat_id: finalChatId,
                instance_id: finalInstanceId, // 🆕 Include instance_id for frontend filtering
                session_id: finalSessionId,
                error_code: error.code || error.type || 'NETWORK_ERROR',
                timestamp: new Date().toISOString()
              });
              
              // Send completion immediately
              isStreamingComplete = true;
              io.to(roomId).emit('chat-stream', {
                type: 'complete',
                content: 'Stream completed due to network error',
                chat_id: finalChatId,
                instance_id: finalInstanceId, // 🆕 Include instance_id for frontend filtering
                session_id: finalSessionId,
                completion_type: 'network_error',
                error_details: error.code || error.type,
                total_tokens: messageCount,
                timestamp: new Date().toISOString()
              });
              
              // Cleanup immediately
              console.log(`🧹 Cleaning up consumer immediately due to network error: ${error.code}`);
              setTimeout(() => {
                cleanupConsumer();
              }, 500);
          }

          // Send acknowledgment
          socket.emit('chat-message-received', {
            success: true,
            session_id: finalSessionId,
            chat_id: finalChatId,
            message: 'Chat processing started'
          });

        } catch (error) {
          console.error('❌ Error setting up RabbitMQ consumer:', error);
        }
        
      } catch (error) {
        console.error('❌ Socket.IO chat error:', error);
        socket.emit('chat-error', {
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // 🆕 NEW: Handle force room leave (triggered by /stop endpoint)
    socket.on('force-leave-room', (data) => {
      console.log('🚪 STOP: Force leaving room:', data.roomId, 'Session:', data.sessionId, 'Reason:', data.reason);
      
      // Leave the specified room
      if (data.roomId) {
        socket.leave(data.roomId);
        console.log('👋 STOP: Socket', socket.id, 'left room:', data.roomId, 'due to', data.reason);
      }
    });

    // Handle client disconnect
    socket.on('disconnect', () => {
      //console.log('🔌 Socket disconnected for chat:', socket.id);
    });
  });
};

// Export additional function for /stop endpoint cleanup
export { forceCleanupConsumerForSession };
