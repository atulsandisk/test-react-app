import express from 'express';
import { httpsAgent } from './auth.js'; // Removed extractUserFromRequest
import rabbitmq, { RABBITMQ_CONFIG, FOREIGN_SERVER_CONFIG } from './rabbitmq.js'; // Removed DEFAULT_USER_ID
import { getNextChatId } from './db.js'; // Removed getNextSessionId - we'll use our own
import fetch from 'node-fetch';
import { io } from './index.js'; // 🆕 NEW: Import io for socket cleanup
import { forceCleanupConsumerForSession } from './socketChat.js'; // 🆕 NEW: Import RabbitMQ cleanup
const router = express.Router();

/*
🎯 SESSION CHAT HISTORY FLOW OVERVIEW:
1. User logs in: Foreign server LAST SESSION ID stored in global variable (e.g., 18)
2. User chats without clicking Chat History: Creates local sessions starting from last_session_id + 1 (19, 20, 21...)
3. User clicks "Chat History" button: SINGLE API call fetches foreign sessions + returns combined with local
4. NEW SESSION FIFO RE-SYNC: When creating new session (chat_id=1), triggers re-sync to maintain FIFO order
5. Session IDs: Foreign server maintains 10 sessions in FIFO order, local sessions continue sequence
6. User logout: clearUserSessionData() flushes all global variables
7. MINIMAL OVERHEAD: Only "Chat History" button + new session creation trigger foreign server

📊 STORAGE APPROACH:
- globalSessionNames: Array of session objects (foreign + local)
- globalChatHistory: Object with chat messages keyed by "userId_sessionId"  
- foreignLastSessionIds: Object storing LAST session ID from foreign server per user
- sessionCounters: Object tracking next session ID per user (starts from foreign last + 1)
*/

// Track session message counts (in production, use Redis or database)
const sessionMessageCounts = new Map();

// GLOBAL VARIABLES for persistent chat storage
let globalSessionNames = [];  // Global session names array: [{ session_id, title, user_id, created_at, source }]
let globalChatHistory = {};   // Global chat history: { "userId_sessionId": [...messages] }
let sessionCacheTimestamp = new Map(); // Cache timestamps per user: { user_id: timestamp }
let globalModelList = [];     // Global model list: [{ id, name, description }]
let modelListCacheTimestamp = null; // Timestamp when models were last fetched

// NEW: Store foreign server LAST SESSION IDs from login (not counts)
let foreignLastSessionIds = {}; // { userId: lastSessionId } e.g., { "atul": "18" }

// NEW: Session ID counters per user (starts from foreign last session ID + 1)  
let sessionCounters = {}; // { userId: nextSessionId }

// NEW: Store current logged-in user from foreign server login response
let currentUserId = null; // Single user ID from foreign server login

// NEW: Store thinking content during streaming
let thinkingContentBuffer = {}; // { sessionKey: thinkingContent }

// NEW: Store personalized files per user
let globalPersonalizedFiles = {}; // { userId: [filePaths] } e.g., { "shanky": ["X:/_server/NFS_share/nSIM_User_Guide 1.pdf"] }

// Model configurations with thinking tag support
const MODEL_TYPES = {
    // Model ID mappings (for direct ID lookup)
    "1": {
        "type": "llama",
        "prompt_format": "llama",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    "2": {
        "type": "gpt-oss",
        "prompt_format": "gpt_oss",
        "supports_thinking": true,
        "thinking_tags": {"start": "<|channel|>analysis<|message|>", "end": "<|end|>"},
        "response_tags": {"start": "<|start|>assistant<|channel|>final<|message|>", "end": "<|end|>"}
    },
   "3": {
        "type": "QuickChat",
        "prompt_format": "Quickchat",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    "4": {
        "type": "Vision LLM",
        "prompt_format": "Vision LLM",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    "6": {
        "type": "qwen",
        "prompt_format": "qwen",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    "7": {
        "type": "qwen",
        "prompt_format": "qwen",
        "supports_thinking": true,
        "thinking_tags": {"start": "<think>", "end": "</think>"},
        "response_tags": {"start": "", "end": ""}
    },
    "8": {
        "type": "qwen",
        "prompt_format": "qwen",
        "supports_thinking": true,
        "thinking_tags": {"start": "<think>", "end": "</think>"},
        "response_tags": {"start": "", "end": ""}
    },
    "9": {
        "type": "llama",
        "prompt_format": "llama",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    // Model name mappings (for backward compatibility)
    "gpt-oss-20b": {
        "type": "gpt-oss",
        "prompt_format": "gpt_oss",
        "supports_thinking": true,
        "thinking_tags": {"start": "<|channel|>analysis<|message|>", "end": "<|end|>"},
        "response_tags": {"start": "<|start|>assistant<|channel|>final<|message|>", "end": "<|end|>"}
    },
    "DeepSeek-R1-Distill-Llama-8B": {
        "type": "deepseek-thinking",
        "prompt_format": "deepseek_llama", 
        "supports_thinking": true,
        "thinking_tags": {"start": "<think>", "end": "</think>"},
        "response_tags": {"start": "", "end": ""}
    },
    "DeepSeek-R1-Distill-Qwen-7B": {
        "type": "deepseek-thinking",
        "prompt_format": "qwen_deepseek",
        "supports_thinking": true,
        "thinking_tags": {"start": "<think>", "end": "</think>"},
        "response_tags": {"start": "", "end": ""}
    },
    "Qwen-1.5B-QuickChat": {
        "type": "QuickChat",
        "prompt_format": "QuickChat",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    "Qwen3-8B": {
        "type": "qwen",
        "prompt_format": "qwen",
        "supports_thinking": true,
        "thinking_tags": {"start": "<think>", "end": "</think>"},
        "response_tags": {"start": "", "end": ""}
    },
    "Qwen3-8B-UD": {
        "type": "qwen",
        "prompt_format": "qwen",
        "supports_thinking": true,
        "thinking_tags": {"start": "<think>", "end": "</think>"},
        "response_tags": {"start": "", "end": ""}
    },
    "Llama-3.1-8B-Instruct-UD": {
        "type": "llama",
        "prompt_format": "llama",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    "phi-4": {
        "type": "phi",
        "prompt_format": "phi",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    "Ministral-8B-Instruct-2410": {
        "type": "generic",
        "prompt_format": "generic",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    },
    "Llama-3.2-1B-Instruct": {
        "type": "generic",
        "prompt_format": "generic",
        "supports_thinking": false,
        "thinking_tags": {"start": "", "end": ""},
        "response_tags": {"start": "", "end": ""}
    }
};

// Function to get model name from model ID
const getModelNameFromId = (modelId) => {
  if (!modelId) return null;
  
  // Try to find model in cached globalModelList
  const model = globalModelList.find(m => String(m.id) === String(modelId));
  if (model && model.name) {
    console.log(`🔍 Found model name for ID ${modelId}: ${model.name}`);
    return model.name;
  }
  
  // Fallback mapping for common model IDs when globalModelList is not populated
  const fallbackMapping = {
  '1': 'Llama-3.1-8B-Instruct-UD',           // model_id: 1
  '2': 'gpt-oss-20b',               // model_id: 2
  '3': 'Qwen-1.5B-QuickChat',
  '4':'InterVL-Vision-LLM',                // Legacy mapping
  };
  
  if (fallbackMapping[String(modelId)]) {
    console.log(`🔄 Using fallback mapping for ID ${modelId}: ${fallbackMapping[String(modelId)]}`);
    return fallbackMapping[String(modelId)];
  }
  
  // Fallback - log warning and return null
  console.warn(`⚠️ Model ID ${modelId} not found in globalModelList or fallback mapping. Available models:`, 
    globalModelList.map(m => `${m.id}:${m.name}`).join(', '));
  return null;
};

// Enhanced thinking processor that handles multiple tag formats
const processStreamingThinking = (content, sessionKey, res, selectedModel) => {
  if (!content || typeof content !== 'string') {
    return content || '';
  }

  // Get model configuration
  const modelConfig = MODEL_TYPES[selectedModel];
  if (!modelConfig || !modelConfig.supports_thinking) {
    console.log(`🚫 Model ${selectedModel} does not support thinking - processing as regular content`);
    return content;
  }

  const { thinking_tags, response_tags } = modelConfig;
  
  // Skip if no thinking tags defined
  if (!thinking_tags.start || !thinking_tags.end) {
    console.log(`🚫 No thinking tags defined for model ${selectedModel}`);
    return content;
  }

  console.log(`🧠 Processing thinking content for model: ${selectedModel}`);
  console.log(`🏷️ Using thinking tags: "${thinking_tags.start}" ... "${thinking_tags.end}"`);
  console.log(`📝 Processing content length: ${content.length} characters`);
  console.log(`📝 Content preview: ${content.substring(0, 200)}...`);

  // Escape special regex characters in tags
  const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startTag = escapeRegex(thinking_tags.start);
  const endTag = escapeRegex(thinking_tags.end);
  
  // Create regex pattern for this model's thinking tags
  const thinkingRegex = new RegExp(`${startTag}([\\s\\S]*?)${endTag}`, 'g');
  
  let thinkingContent = '';
  let mainContent = content;
  let hasThinking = false;

  // Extract thinking content
  let match;
  while ((match = thinkingRegex.exec(content)) !== null) {
    thinkingContent += match[1].trim() + '\n\n';
    hasThinking = true;
    console.log(`✅ Extracted thinking segment: ${match[1].substring(0, 100)}...`);
  }

  if (hasThinking) {
    console.log(`✅ Found thinking content (${thinkingContent.length} chars): ${thinkingContent.substring(0, 100)}...`);
    
    // Remove thinking tags completely from main content
    mainContent = content.replace(thinkingRegex, '').trim();
    console.log(`🧹 Cleaned main content (${mainContent.length} chars): ${mainContent.substring(0, 100)}...`);
    
    // Handle response tags if they exist (like GPT-OSS)
    if (response_tags.start && response_tags.end) {
      const responseStartTag = escapeRegex(response_tags.start);
      const responseEndTag = escapeRegex(response_tags.end);
      const responseRegex = new RegExp(`${responseStartTag}([\\s\\S]*?)${responseEndTag}`, 'g');
      
      let responseMatch = responseRegex.exec(mainContent);
      if (responseMatch) {
        mainContent = responseMatch[1].trim();
        console.log(`📝 Extracted response content from ${selectedModel} response tags: ${mainContent.substring(0, 100)}...`);
      }
      // Remove response tags even if no match
      mainContent = mainContent.replace(new RegExp(`${responseStartTag}|${responseEndTag}`, 'g'), '').trim();
    }

    // Remove any remaining start/end tags that might be present
    mainContent = mainContent.replace(new RegExp(`${startTag}|${endTag}`, 'g'), '').trim();

    // Accumulate thinking content for this session
    if (!thinkingContentBuffer[sessionKey]) {
      thinkingContentBuffer[sessionKey] = '';
    }
    thinkingContentBuffer[sessionKey] += thinkingContent;
    
    // Stream thinking content to frontend
    if (!res.headersSent) {
      res.write(JSON.stringify({
        "type": "thinking",
        "content": thinkingContent.trim(),
        "timestamp": new Date().toISOString(),
        "isThinking": true
      }) + '\n');
      console.log(`📡 Streamed thinking content to frontend for ${selectedModel} (${thinkingContent.length} chars)`);
      
      // If we have main content, send thinking complete signal
      if (mainContent && mainContent.trim()) {
        res.write(JSON.stringify({
          "type": "thinking_complete",
          "timestamp": new Date().toISOString()
        }) + '\n');
        console.log(`🏁 Sent thinking complete signal for ${selectedModel}`);
      }
    }
  }

  // Return cleaned main content for regular streaming
  return mainContent;
};

// Session management functions
const setForeignLastSessionId = (userId, lastSessionId) => {
  foreignLastSessionIds[userId] = String(lastSessionId) || "0";
  console.log('💾 Stored foreign server LAST session ID for user:', userId, 'lastSessionId:', lastSessionId);
  
  // Reset session counter so next session starts from lastSessionId + 1
  delete sessionCounters[userId];
};

const setCurrentUserId = (userId) => {
  currentUserId = userId;
  console.log('👤 Set current user ID from foreign server login:', userId);
};

const getCurrentUserId = () => {
  return currentUserId;
};

// NEW: Functions to manage personalized files
const setPersonalizedFiles = (userId, filePaths) => {
  if (!userId) {
    console.warn('⚠️ Cannot set personalized files: userId is required');
    return;
  }
  
  globalPersonalizedFiles[userId] = Array.isArray(filePaths) ? filePaths : [];
  console.log('📂 Set personalized files for user:', userId, 'files:', globalPersonalizedFiles[userId].length);
  console.log('📂 Files:', globalPersonalizedFiles[userId]);
};

const getPersonalizedFiles = (userId) => {
  const finalUserId = userId || getCurrentUserId();
  return globalPersonalizedFiles[finalUserId] || [];
};

const addPersonalizedFile = (userId, filePath) => {
  const finalUserId = userId || getCurrentUserId();
  if (!globalPersonalizedFiles[finalUserId]) {
    globalPersonalizedFiles[finalUserId] = [];
  }
  
  // Avoid duplicates
  if (!globalPersonalizedFiles[finalUserId].includes(filePath)) {
    globalPersonalizedFiles[finalUserId].push(filePath);
    console.log('📂 Added personalized file for user:', finalUserId, 'file:', filePath);
  }
};

const removePersonalizedFile = (userId, filePath) => {
  const finalUserId = userId || getCurrentUserId();
  if (globalPersonalizedFiles[finalUserId]) {
    globalPersonalizedFiles[finalUserId] = globalPersonalizedFiles[finalUserId].filter(f => f !== filePath);
    console.log('📂 Removed personalized file for user:', finalUserId, 'file:', filePath);
  }
};

const getNextSessionId = (userId) => {
  // Use the current logged-in user ID if not provided
  const finalUserId = userId || getCurrentUserId();
  
  if (!sessionCounters[finalUserId]) {
    // Use foreign server LAST session ID + 1 as starting point
    const foreignLastId = parseInt(foreignLastSessionIds[finalUserId] || "0");
    sessionCounters[finalUserId] = foreignLastId; // Will be incremented below
    console.log('🆔 Initializing session counter for user:', finalUserId, 'starting from foreign server last ID:', foreignLastId);
  }
  
  sessionCounters[finalUserId] += 1;
  const nextId = sessionCounters[finalUserId].toString();
  console.log('🆔 Generated session ID:', nextId, 'for user:', finalUserId, '(foreign last + local increment)');
  return nextId;
};

// 10-SESSION SLIDING WINDOW MANAGEMENT
const manageSessionWindow = async (userId) => {
  const finalUserId = userId || getCurrentUserId();
  
  // Get user's sessions from globalSessionNames
  const userSessions = globalSessionNames.filter(session => session.user_id === finalUserId);
  
  console.log('🪟 WINDOW CHECK: User has', userSessions.length, 'sessions');
  
  // Check if we're creating the 9th session (warning) or 10th+ (deletion required)
  if (userSessions.length === 9) {
    // User is creating their 10th session - this is the last one before auto-deletion starts
    console.log('⚠️ SESSION LIMIT WARNING: User is creating their 10th session (last before auto-deletion)');
    return {
      deletedSession: null,
      shouldNotifyUser: true,
      isWarning: true,
      message: "This is your 10th session. Creating additional sessions will automatically remove the oldest ones to maintain the 10-session limit.",
      sessionCount: userSessions.length + 1 // Will be 10 after creation
    };
  }
  
  if (userSessions.length >= 25) {
    // Sort sessions by session_id (oldest first) - FIFO order
    const sortedSessions = userSessions.sort((a, b) => {
      const aSessionNum = parseInt(a.session_id.replace(/\D/g, '')) || 0;
      const bSessionNum = parseInt(b.session_id.replace(/\D/g, '')) || 0;
      return aSessionNum - bSessionNum; // Oldest session ID first
    });
    
    const oldestSession = sortedSessions[0];
    console.log('🗑️ WINDOW LIMIT REACHED: Will delete oldest session:', oldestSession.session_id);
    
    // Remove oldest session from globalSessionNames
    globalSessionNames = globalSessionNames.filter(session => 
      !(session.user_id === finalUserId && session.session_id === oldestSession.session_id)
    );
    
    // Remove oldest session's chat history from globalChatHistory
    const oldestHistoryKey = `${finalUserId}_${oldestSession.session_id}`;
    if (globalChatHistory[oldestHistoryKey]) {
      const messageCount = globalChatHistory[oldestHistoryKey].length;
      delete globalChatHistory[oldestHistoryKey];
      console.log('🗑️ WINDOW CLEANUP: Deleted', messageCount, 'messages from session:', oldestSession.session_id);
    }
    
    // Remove from session message counts
    const oldestSessionKey = `${finalUserId}_${oldestSession.session_id}`;
    if (sessionMessageCounts.has(oldestSessionKey)) {
      sessionMessageCounts.delete(oldestSessionKey);
      console.log('🗑️ WINDOW CLEANUP: Cleared message count for session:', oldestSession.session_id);
    }
    
    // Remove from thinking content buffer
    if (thinkingContentBuffer[oldestHistoryKey]) {
      delete thinkingContentBuffer[oldestHistoryKey];
      console.log('🗑️ WINDOW CLEANUP: Cleared thinking buffer for session:', oldestSession.session_id);
    }
    
    console.log('✅ WINDOW MAINTAINED: Sliding window now has', globalSessionNames.filter(s => s.user_id === finalUserId).length, 'sessions');
    
    return {
      deletedSession: oldestSession,
      shouldNotifyUser: true,
      isWarning: false,
      message: `Session "${oldestSession.title || oldestSession.session_id}" was automatically deleted to maintain the 10-session limit.`,
      sessionCount: 10 // Will maintain exactly 10 sessions
    };
  }
  
  return {
    deletedSession: null,
    shouldNotifyUser: false,
    isWarning: false,
    message: null,
    sessionCount: userSessions.length + 1 // Normal session creation
  };
};

// FETCH SESSION NAMES FROM FOREIGN SERVER
const fetchSessionNamesFromForeignServer = async (userId) => {
  const finalUserId = userId || getCurrentUserId();
  
  try {
    console.log('🌐 Fetching session names from foreign server for user:', finalUserId);
    
    // Call foreign server to get session names (no caching - always fetch fresh)
    const sessionNamesUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/sessionnames`;
    
    const foreignServerPayload = {
      user_id: String(finalUserId)
    };
    
    console.log('📤 Fetching session names from:', sessionNamesUrl);
    console.log('📤 Payload:', JSON.stringify(foreignServerPayload, null, 2));
    
    // Setup AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 10000); // 10 second timeout

    const foreignResponse = await fetch(sessionNamesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(foreignServerPayload),
      agent: httpsAgent,
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    if (foreignResponse.ok) {
      const responseData = await foreignResponse.json();
      console.log('✅ Foreign server session names fetched successfully');
      
      // Update globalSessionNames with foreign server sessions
      if (responseData.sessions && Array.isArray(responseData.sessions)) {
        // Remove existing foreign sessions for this user and add fresh ones
        globalSessionNames = globalSessionNames.filter(session => 
          !(session.user_id === finalUserId && session.source === 'foreign')
        );
        
        // Add fresh foreign sessions
        const foreignSessions = responseData.sessions.map(session => ({
          session_id: session.session_id || session.S_id,
          title: session.title || session.session_name || `Session ${session.session_id}`,
          user_id: finalUserId,
          created_at: session.created_at || new Date().toISOString(),
          source: 'foreign',
          total_chats: session.total_chats || 0
        }));
        
        globalSessionNames.unshift(...foreignSessions);
        console.log('📝 Updated globalSessionNames with', foreignSessions.length, 'foreign sessions');
        
        // Update cache timestamp (for logging purposes only)
        sessionCacheTimestamp.set(finalUserId, Date.now());
        
        return true;
      }
    } else {
      console.log('⚠️ Foreign server session names call failed:', foreignResponse.status);
      return false; // Don't block session creation if foreign server is down
    }
    
  } catch (error) {
    console.error('❌ Error fetching session names from foreign server:', error.message);
    return false; // Don't block session creation if foreign server has issues
  }
  
  return false;
};

// TASK 1: /chat Endpoint (Streaming Chat Response with On-Demand RabbitMQ Consumption)
router.post('/chat', async (req, res) => {
  let {
    user_id,
    chat_id, // Now included as required in new payload format
    session_id,
    llm_model_id,
    summarize_flag,
    codebase_search_flag,
    personalize_flag,
    temp_file_flag,
    first_chat_flag,
    web_search_flag,
    prompt,
    temp_file_paths,
    temp_file_name // File name for chat history display
  } = req.body;

  // Extract user ID from JWT token if not provided or if using default
  if (!user_id || user_id === 'default_user') {
    user_id = getCurrentUserId();
    console.log('🔄 Using stored user ID from login:', user_id);
  }

  // Validate required fields (now including chat_id)
  if (!user_id || !session_id || !prompt) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: user_id, session_id, prompt'
    });
  }

  // Check session limit (20 prompts max)
  const sessionKey = `${user_id}_${session_id}`;
  const currentCount = sessionMessageCounts.get(sessionKey) || 0;

  if (currentCount >= 15) {
    return res.status(429).json({
      success: false,
      error: 'Maximum limit reached. Create new chat.'
    });
  }

  // Set up streaming response headers for regular HTTP streaming
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // RabbitMQ consumer management for on-demand consumption
  let rabbitConsumer = null;
  let isStreamingComplete = false;

  // Function to cleanup RabbitMQ consumer - defined outside try block for error handling
  const cleanupConsumer = async () => {
    if (rabbitConsumer && !isStreamingComplete) {
      console.log('🛑 Stopping RabbitMQ consumption for session:', sessionKey);
      // Safely cancel the consumer without closing the channel
      try {
        const cancelled = await rabbitmq.cancelConsumer(rabbitConsumer);
        if (cancelled) {
          console.log('✅ Consumer cancelled successfully - Channel remains open for foreign server');
        } else {
          console.log('⚠️ Consumer cleanup skipped - may have been already cancelled');
        }
      } catch (error) {
        console.error('❌ Error cancelling consumer:', error);
      }
      rabbitConsumer = null;
      isStreamingComplete = true;
    }
  };

  try {
    console.log('Starting chat stream for session:', sessionKey);
    
    // Increment session message count
    sessionMessageCounts.set(sessionKey, currentCount + 1);

    // RENDER OLD CHAT HISTORY FOR THIS SESSION
    const historyKey = `${user_id}_${session_id}`;
    if (globalChatHistory[historyKey] && globalChatHistory[historyKey].length > 0) {
      console.log('📜 Rendering old chat history for session:', session_id);
      console.log('📊 Found', globalChatHistory[historyKey].length, 'previous messages');
      
      // Send old chat history first
      res.write(JSON.stringify({
        "type": "history_start",
        "content": "Loading previous chat history...",
        "timestamp": new Date().toISOString()
      }) + '\n');
      
      // Stream each old message
      for (const oldMessage of globalChatHistory[historyKey]) {
        res.write(JSON.stringify({
          "type": "history",
          "content": oldMessage.content || oldMessage.message || JSON.stringify(oldMessage),
          "role": oldMessage.role || "assistant",
          "timestamp": oldMessage.timestamp || new Date().toISOString(),
          "temp_file_name": oldMessage.temp_file_name || null
        }) + '\n');
      }
      
      res.write(JSON.stringify({
        "type": "history_end",
        "content": "Previous chat history loaded.",
        "timestamp": new Date().toISOString()
      }) + '\n');
    } else {
      console.log('📄 No previous chat history found for session:', session_id);
    }

    // SAVE USER PROMPT TO GLOBAL CHAT HISTORY
    if (!globalChatHistory[historyKey]) {
      globalChatHistory[historyKey] = [];
    }
    
    // Add user prompt to chat history with chat_id and temp file name
    globalChatHistory[historyKey].push({
      role: 'user',
      content: prompt,
      chat_id: chat_id, // Include chat_id from request body
      session_id: session_id,
      user_id: user_id,
      timestamp: new Date().toISOString(),
      message_type: 'prompt',
      temp_file_name: temp_file_name || null // Include temp file name for display
    });
    
    console.log('💾 Saved user prompt to globalChatHistory');
    if (temp_file_name) {
      console.log('📎 Attached file:', temp_file_name);
    }
    
    // UPDATE GLOBAL SESSION NAMES ARRAY (completes the session management flow)
    const existingSessionIndex = globalSessionNames.findIndex(s => s.session_id === session_id && s.user_id === user_id);
    const sessionTitle = `Chat Session ${session_id}`;
    
    if (existingSessionIndex === -1) {
      // Add new session to global session names with current chat_id
      globalSessionNames.unshift({
        session_id: session_id,
        title: sessionTitle,
        user_id: user_id,
        current_chat_id: chat_id, // Track the current/latest chat_id in this session
        total_chats: 1, // Start with 1 chat
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source: 'local' // Mark as locally created session
      });
      console.log('📝 FLOW UPDATE: Added new LOCAL session to globalSessionNames:', sessionTitle, 'with chat_id:', chat_id);
    } else {
      // Update existing session's updated_at and current_chat_id
      globalSessionNames[existingSessionIndex].updated_at = new Date().toISOString();
      globalSessionNames[existingSessionIndex].current_chat_id = chat_id;
      globalSessionNames[existingSessionIndex].total_chats = (globalSessionNames[existingSessionIndex].total_chats || 0) + 1;
      console.log('🔄 FLOW UPDATE: Updated existing session in globalSessionNames:', sessionTitle, 'new chat_id:', chat_id);
    }
    
    console.log('📊 Global session names count:', globalSessionNames.length);
    console.log('💾 Global chat history for this session:', globalChatHistory[historyKey].length, 'messages');

    // Don't send initial thinking message unless model actually provides <think> tags
    // The thinking will be extracted from the actual model response

    // Send a test streaming message to verify frontend connection
    setTimeout(() => {
      if (!res.headersSent && !isStreamingComplete) {
        res.write(JSON.stringify({"type":"stream","content":"Test streaming connection - this should appear in frontend","timestamp": new Date().toISOString()}) + '\n');
      }
    }, 1000);

    console.log('🎯 PRIORITY: RabbitMQ streaming will be the primary response source');
    console.log('📡 Foreign server response will NOT be streamed to frontend');

    // Prepare payload for foreign server - Ensure all fields are properly typed
    const finalRoomId = `chat_${user_id}_${session_id}_${chat_id}`;
    
  
    
    const payload = {
      user_id: String(user_id), // Ensure string type
      chat_id: String(chat_id), // Default chat_id as per new format - ensure string
      session_id: String(session_id), // Ensure string type
      llm_model_id: String(llm_model_id || "1"), // Ensure string type
      summarize_flag: Boolean(summarize_flag !== undefined ? summarize_flag : false), // Ensure boolean - default false
      codebase_search_flag: Boolean(codebase_search_flag !== undefined ? codebase_search_flag : false), // Ensure boolean - default false
      personalize_flag: Boolean(personalize_flag !== undefined ? personalize_flag : false), // Ensure boolean - default false
      temp_file_flag: Boolean(temp_file_flag !== undefined ? temp_file_flag : false), // Ensure boolean
      first_chat_flag: Boolean(first_chat_flag !== undefined ? first_chat_flag : false), // Ensure boolean
      web_search_flag: Boolean(web_search_flag !== undefined ? web_search_flag : false), // Ensure boolean - default false
      prompt: String(prompt), // Ensure string type
      temp_file_paths: Array.isArray(temp_file_paths) ? temp_file_paths : [], // Ensure array type
      room_id: finalRoomId
    };
    // Send payload to foreign server
    const chatUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/chat`;
    
    console.log('📡 Sending request to foreign server:', chatUrl);
    console.log('Sending payload to foreign server:', JSON.stringify(payload, null, 2));

    // Start foreign server request in parallel with RabbitMQ consumption
    console.log('🚀 Starting foreign server request...');
    const foreignServerPromise = (async () => {
      try {
        console.log('📡 Inside foreign server promise - making request...');
        const chatUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/chat`;
        
        // Setup AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, 30000); // 30 second timeout for chat requests
        
        const foreignResponse = await fetch(chatUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': req.headers.authorization || ''
          },
          body: JSON.stringify(payload),
          agent: httpsAgent,
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        console.log('📡 Foreign server fetch completed, status:', foreignResponse.status);
        return foreignResponse;
      } catch (error) {
        console.error('❌ Foreign server request error:', error);
        return { ok: false, status: 500, text: () => Promise.resolve(error.message) };
      }
    })();

    // Wait for foreign server response (RabbitMQ streams in parallel during this time)
    console.log('⏳ Waiting for foreign server response...');
    const foreignResponse = await foreignServerPromise;
    console.log('✅ Foreign server response received, processing...');

    // 🎯 CRITICAL: Check if foreign server indicates completion
    let foreignServerCompletionStatus = { isComplete: false, hasContent: false };
    if (foreignResponse.ok) {
      try {
        // We'll parse this again later, but need to check completion status first
        const responseText = await foreignResponse.text();
        const responseData = JSON.parse(responseText);
        
        // Check for completion indicators in foreign server response
        foreignServerCompletionStatus = {
          isComplete: responseData.status === 'complete' || responseData.status === 'done' || responseData.complete === true,
          hasContent: responseData.content && responseData.content.length > 0,
          responseText: responseText  // Store for later use
        };
        
        console.log('🔍 Foreign server completion status:', foreignServerCompletionStatus);
      } catch {
        console.log('⚠️ Could not parse foreign server response for completion check, proceeding normally');
        foreignServerCompletionStatus = { isComplete: false, hasContent: false };
      }
    }

    // 🎯 CRITICAL: Check RabbitMQ queue with completion awareness
    console.log('🔍 Foreign server responded - checking RabbitMQ queue for remaining messages...');
    
    // 🎯 SHORTENED WAIT: If foreign server completed, give much less time for queue processing
    if (foreignServerCompletionStatus.isComplete) {
      console.log('🎯 Foreign server indicated completion - will use aggressive timeouts for queue processing');
    }
    
    // Check queue and handle remaining messages
    const handleQueueAfterForeignResponse = async () => {
      return new Promise((resolve) => {
        let queueCheckTimeout = null;
        let messagesProcessed = 0;
        let completionReceived = false;
        
        // 🎯 SMART TIMEOUT: Much shorter if foreign server indicates completion
        const timeoutDuration = foreignServerCompletionStatus.isComplete ? 1500 : 5000;
        console.log(`⏰ Setting queue timeout to ${timeoutDuration}ms (foreign server completion: ${foreignServerCompletionStatus.isComplete})`);
        
        queueCheckTimeout = setTimeout(() => {
          console.log(`⏰ Queue check timeout (${timeoutDuration}ms) - stopping streaming`);
          if (!isStreamingComplete) {
            isStreamingComplete = true;
            if (!res.headersSent) {
              res.write(JSON.stringify({
                "type": "complete",
                "timestamp": new Date().toISOString(),
                "reason": foreignServerCompletionStatus.isComplete ? "foreign_server_completed" : "timeout"
              }) + '\n');
              res.end();
            }
          }
          resolve();
        }, timeoutDuration);
        
        // Set up consumer to check for any remaining messages
        rabbitmq.consumeQueue(rabbitmq.queues.chat, async (message) => {
          try {
            if (isStreamingComplete) {
              console.log('⏹️ Streaming marked complete, ignoring message:', message);
              return;
            }
            
            console.log('📨 Processing message after foreign response:', message);
            messagesProcessed++;
            
            // Check for various completion signal formats
            const isCompletionMessage = message && (
              message.content === 'COMPLETION' || 
              message.type === 'complete' || 
              message.type === 'completion' ||
              message.status === 'done' ||
              (message.content && typeof message.content === 'string' && message.content.toLowerCase().includes('completion'))
            );
            
            if (isCompletionMessage) {
              console.log('✅ Received completion signal from RabbitMQ:', JSON.stringify(message));
              completionReceived = true;
              clearTimeout(queueCheckTimeout);
              
              // Wait a brief moment to see if any final content messages arrive
              setTimeout(() => {
                if (!isStreamingComplete) {
                  isStreamingComplete = true;
                  if (!res.headersSent) {
                    res.write(JSON.stringify({
                      "type": "complete",
                      "timestamp": new Date().toISOString()
                    }) + '\n');
                    res.end();
                  }
                }
                resolve();
              }, 100); // Small delay for any final messages
              return;
            }
            
            // Process and stream content messages
            if (message && message.content && typeof message.content === 'string' && !res.headersSent) {
              const sessionKey = `${user_id}_${session_id}`;
              const modelName = getModelNameFromId(llm_model_id);
              const mainContent = processStreamingThinking(message.content, sessionKey, res, modelName);
              
              // Stream main content if available
              if (mainContent && mainContent.trim()) {
                res.write(JSON.stringify({
                  "type": "stream",
                  "content": mainContent,
                  "timestamp": new Date().toISOString()
                }) + '\n');
                console.log('📤 Streamed content after foreign response:', mainContent.substring(0, 50) + '...');
              }
            }
            
          } catch (error) {
            console.error('❌ Error processing queue message:', error);
          }
        }).then(consumer => {
          rabbitConsumer = consumer;
          console.log('🔄 Queue consumer started after foreign response - processing messages...');
          
          // 🎯 ENHANCED: Immediate completion check with foreign server awareness
          const immediateCheckDelay = foreignServerCompletionStatus.isComplete ? 300 : 1000;
          console.log(`⏰ Setting immediate check delay to ${immediateCheckDelay}ms based on foreign server completion`);
          
          setTimeout(() => {
            if (messagesProcessed === 0 && !completionReceived && !isStreamingComplete) {
              if (foreignServerCompletionStatus.isComplete) {
                console.log('🎯 IMMEDIATE COMPLETION: Foreign server completed and no RabbitMQ messages found');
              } else {
                console.log('📭 No messages found in queue after delay - queue appears empty');
              }
              
              clearTimeout(queueCheckTimeout);
              isStreamingComplete = true;
              if (!res.headersSent) {
                res.write(JSON.stringify({
                  "type": "complete",
                  "timestamp": new Date().toISOString(),
                  "reason": foreignServerCompletionStatus.isComplete ? "foreign_complete_no_queue" : "no_queue_messages"
                }) + '\n');
                res.end();
              }
              resolve();
            }
          }, immediateCheckDelay);
          
        }).catch(error => {
          console.error('❌ Error setting up queue consumer:', error);
          clearTimeout(queueCheckTimeout);
          if (!isStreamingComplete) {
            isStreamingComplete = true;
            if (!res.headersSent) {
              res.end();
            }
          }
          resolve();
        });
      });
    };
    
    // Execute queue handling
    await handleQueueAfterForeignResponse();

    // Process foreign server response with detailed logging
    console.log('📡 Processing foreign server /chat response...');
    if (foreignResponse.ok) {
      // Use the already parsed response data or parse if not available
      let responseData;
      if (foreignServerCompletionStatus.responseText) {
        responseData = JSON.parse(foreignServerCompletionStatus.responseText);
      } else {
        responseData = await foreignResponse.json();
      }
      console.log('✅ Foreign server /chat response:', JSON.stringify(responseData, null, 2));
      
      // 🎯 HANDLE SESSION NAME FROM FOREIGN SERVER (for new sessions with chat_id = 1)
      if (chat_id === "1" && responseData.SESSION_NAME) {
        console.log('🆕 New session detected - updating session name from foreign server');
        console.log('📝 Foreign server provided SESSION_NAME:', responseData.SESSION_NAME);
        
        // 🌐 FETCH SESSION NAMES FROM FOREIGN SERVER (ONLY when chat_id === 1)
        console.log('🌐 First chat detected (chat_id === 1) - fetching updated session names from foreign server...');
        const sessionNamesFetched = await fetchSessionNamesFromForeignServer(user_id);
        if (sessionNamesFetched) {
          console.log('✅ Session names updated from foreign server for first chat');
        } else {
          console.log('⚠️ Could not fetch session names from foreign server, proceeding with existing data');
        }
        
        // Find and update the session in globalSessionNames
        const sessionIndex = globalSessionNames.findIndex(s => 
          s.session_id === session_id && s.user_id === user_id
        );
        
        if (sessionIndex !== -1) {
          const oldTitle = globalSessionNames[sessionIndex].title;
          globalSessionNames[sessionIndex].title = responseData.SESSION_NAME;
          globalSessionNames[sessionIndex].title_updated_from_server = true; // Mark for frontend refresh
          console.log('✅ Updated session title in globalSessionNames:');
          console.log(`   Old: "${oldTitle}"`);
          console.log(`   New: "${responseData.SESSION_NAME}"`);
        } else {
          console.log('⚠️ Session not found in globalSessionNames for title update');
        }
        
        // 🎯 NEW SESSION FIFO RE-SYNC: Ensure frontend matches foreign server's 10-session FIFO order
        // This prevents session history mismatches when foreign server discards oldest sessions
        console.log('🔄 NEW SESSION CREATED: Re-syncing to match foreign server FIFO order...');
        
        // Call foreign server session_name to trigger latest 10 sessions preparation
        try {
          const sessionNameUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/session_name`;
          console.log('📡 Re-sync call to foreign server:', sessionNameUrl);
          
          const resyncPayload = {
            user_id: String(user_id)
          };
          
          // Setup AbortController for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort();
          }, 10000); // 10 second timeout for session_name calls
          
          const resyncResponse = await fetch(sessionNameUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': req.headers.authorization || ''
            },
            body: JSON.stringify(resyncPayload),
            agent: httpsAgent,
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (resyncResponse.ok) {
            const _resyncData = await resyncResponse.json();
            console.log('✅ Re-sync call successful - foreign server will publish latest sessions to RabbitMQ');
            console.log('📌 GlobalSessionNames will be updated when user next clicks "Chat History"');
            console.log('🎯 FIFO consistency maintained: Frontend will match foreign server session order');
            
            // Note: The actual RabbitMQ consumption and globalSessionNames update 
            // will happen when user next clicks "Chat History" button
            // This ensures we don't add overhead to the current chat response
            
          } else {
            console.warn('⚠️ Re-sync call failed, continuing with current session data');
            console.warn('⚠️ Session history may be inconsistent until next "Chat History" click');
          }
          
        } catch (error) {
          console.error('❌ Re-sync call error (non-critical):', error.message);
          console.error('❌ Session history may be inconsistent until next "Chat History" click');
          // Don't fail the chat response if re-sync fails
        }
        
        console.log('✅ NEW SESSION HANDLING COMPLETE: Title updated + FIFO re-sync triggered');
      }

    } else {
      // Handle foreign server error response
      const errorText = await foreignResponse.text();
      console.log('❌ Foreign server /chat error response:', errorText);
      
      // Even on error, check for any remaining queue messages before ending
      console.log('🔍 Foreign server error - still checking for remaining RabbitMQ messages...');
      
      // Set up a quick drain for any messages that might have been sent before the error
      let queueDrained = false;
      const errorDrainTimeout = setTimeout(() => {
        queueDrained = true;
      }, 2000); // Shorter timeout for error case
      
      try {
        const errorDrainPromise = new Promise((resolve) => {
          setTimeout(() => {
            if (!queueDrained) {
              queueDrained = true;
              clearTimeout(errorDrainTimeout);
              resolve();
            }
          }, 2000);
          
          // Quick check for any remaining messages
          rabbitmq.consumeQueue(rabbitmq.queues.chat, async (message) => {
            if (queueDrained) return;
            
            console.log('📨 Processing message during error state:', message);
            if (message && message.content && !res.headersSent) {
              // Process thinking content and get main content
              const sessionKey = `${user_id}_${session_id}`;
              const modelName = getModelNameFromId(llm_model_id);
              const mainContent = processStreamingThinking(message.content, sessionKey, res, modelName);
              
              // Stream main content if available
              if (mainContent) {
                res.write(JSON.stringify({
                  "type": "stream",
                  "content": mainContent,
                  "timestamp": new Date().toISOString()
                }) + '\n');
              }
            }
          }).catch(() => {
            // Ignore consumer setup errors during error state
            resolve();
          });
        });
        
        await errorDrainPromise;
      } catch (drainError) {
        console.error('❌ Error during queue drain in error state:', drainError);
      }
      
      // End streaming with error
      if (!isStreamingComplete) {
        isStreamingComplete = true;
        
        // Cleanup RabbitMQ consumer
        await cleanupConsumer();
        
        // Send error and end response
        if (!res.headersSent) {
          res.write(JSON.stringify({
            "type": "error",
            "content": `Foreign server error: ${errorText}`,
            "timestamp": new Date().toISOString()
          }) + '\n');
          res.end();
          console.log('❌ Stream ended with error after checking queue');
        }
      }
    }

    // Note: Streaming completion is now handled when foreign server responds
    // The response will either end immediately (if queue is empty) or after draining remaining messages
  } catch (error) {
    console.error('❌ Chat endpoint error:', error);
    
    // Cleanup consumer on error
    await cleanupConsumer();
    
    const errorData = {
      type: 'error',
      content: `Server error: ${error.message}`,
      timestamp: new Date().toISOString()
    };
    res.write(JSON.stringify(errorData) + '\n');
    res.end();
  }
});

// TASK 2: /sessionhistory Endpoint (Foreign Server + RabbitMQ Flow)
// 🎯 FLOW: Called ONLY when user clicks "Chat History" button - THIS IS THE ONLY FOREIGN SERVER CALL
// 🚫 NEVER called during regular chat operations - ensures ZERO overhead
// Step 1: Call foreign server /session_name with user_id
// Step 2: Foreign server publishes latest 10 sessions to RabbitMQ (FIFO order)
// Step 3: Consume from RabbitMQ and update globalSessionNames variable
// Step 4: Return sessions to frontend, subsequent calls use globalSessionNames (no RabbitMQ calls)
router.post('/sessionName', async (req, res) => {
  // Always use the stored user ID from login - no fallbacks
  const user_id = getCurrentUserId();
  
  if (!user_id) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated. Please login first.'
    });
  }
  
  console.log('🔄 SessionHistory using stored user ID from login:', user_id);

  const { page = 1, limit = 10 } = req.body;

  // RabbitMQ consumer management for on-demand consumption
  let rabbitConsumer = null;
  let isStreamingComplete = false;

  // Function to cleanup RabbitMQ consumer
  const cleanupConsumer = async () => {
    if (rabbitConsumer && !isStreamingComplete) {
      console.log('🛑 Stopping RabbitMQ consumption for sessionhistory:', user_id);
      // Safely cancel the consumer without closing the channel
      try {
        const cancelled = await rabbitmq.cancelConsumer(rabbitConsumer);
        if (cancelled) {
          console.log('✅ Consumer cancelled successfully - Channel remains open for foreign server');
        } else {
          console.log('⚠️ Consumer cleanup skipped - may have been already cancelled');
        }
      } catch (error) {
        console.error('❌ Error cancelling consumer:', error);
      }
      rabbitConsumer = null;
      isStreamingComplete = true;
    }
  };

  try {
    console.log('🚀 Session history endpoint hit - Starting on-demand consumption for user:', user_id);

    // DEBUG: Check what's in globalSessionNames
    console.log('🔍 DEBUG: Total globalSessionNames count:', globalSessionNames.length);
    console.log('🔍 DEBUG: First few globalSessionNames entries:', globalSessionNames.slice(0, 3).map(s => ({
      session_id: s.session_id,
      user_id: s.user_id,
      title: s.title
    })));
    console.log('🔍 DEBUG: Looking for user_id:', user_id, 'type:', typeof user_id);

    // FIRST CHECK GLOBAL SESSION NAMES ARRAY
    const userGlobalSessions = globalSessionNames.filter(session => {
      const match = session.user_id === user_id;
      if (!match && globalSessionNames.length > 0) {
        console.log('🔍 DEBUG: No match - session.user_id:', session.user_id, 'type:', typeof session.user_id, 'vs user_id:', user_id, 'type:', typeof user_id);
      }
      return match;
    });
    console.log('🔍 DEBUG: Found', userGlobalSessions.length, 'sessions for user:', user_id);
    
    // Check if we have foreign server data in cache
    const hasForeignServerData = userGlobalSessions.some(session => session.source === 'rabbitmq');
    const hasLocalSessionsOnly = userGlobalSessions.length > 0 && !hasForeignServerData;
    
    console.log('🔍 Cache analysis:');
    console.log('   - Total sessions in cache:', userGlobalSessions.length);
    console.log('   - Has foreign server data:', hasForeignServerData);  
    console.log('   - Has local sessions only:', hasLocalSessionsOnly);
    
    // RETURN FROM CACHE only if we have foreign server data (complete picture)
    if (userGlobalSessions.length > 0 && hasForeignServerData) {
      console.log('⚡ OPTIMIZATION: Fast return from cache - found', userGlobalSessions.length, 'sessions with foreign server data');
      
      // Sort by session_id (highest/latest session ID first) 
      const sortedSessions = userGlobalSessions.sort((a, b) => {
        const aSessionNum = parseInt(a.session_id.replace(/\D/g, '')) || 0;
        const bSessionNum = parseInt(b.session_id.replace(/\D/g, '')) || 0;
        return bSessionNum - aSessionNum; // Highest session ID first
      });
      
      const formattedSessions = sortedSessions.map(session => {
        const sessionChatHistory = globalChatHistory[`${user_id}_${session.session_id}`] || [];
        const lastMessage = sessionChatHistory.length > 0 ? sessionChatHistory[sessionChatHistory.length - 1] : null;
        
        return {
          S_id: session.session_id,
          title: session.title,
          created_at: session.created_at,
          updated_at: session.updated_at,
          C_id: null,
          source: session.source || 'global_memory',
          message_count: sessionChatHistory.length,
          last_message: lastMessage ? {
            content: lastMessage.content || lastMessage.response,
            timestamp: lastMessage.timestamp,
            role: lastMessage.role
          } : null
        };
      });
      
      // Update cache timestamp for this user
      sessionCacheTimestamp.set(user_id, Date.now());
      
      return res.json({
        success: true,
        sessions: formattedSessions.slice(0, limit),
        total: formattedSessions.length,
        page: parseInt(page),
        limit: parseInt(limit),
        hasMore: formattedSessions.length > limit,
        source: 'complete_cache_with_foreign_data',
        cached: true,
        cache_timestamp: sessionCacheTimestamp.get(user_id)
      });
    }

    // FETCH FROM FOREIGN SERVER if:
    // 1. No sessions in cache (fresh login), OR
    // 2. Has local sessions but no foreign server data (need to get complete picture)
    if (hasLocalSessionsOnly) {
      console.log('📡 Local sessions exist but missing foreign server data - fetching to get complete picture');
    } else {
      console.log('📡 No sessions found in cache - fresh login detected, fetching from foreign server');
    }

    // STEP 1: START RabbitMQ consumer FIRST (before calling foreign server)
    console.log('📡 Step 1: Setting up RabbitMQ consumer FIRST (before foreign server call)');
    
    // Start RabbitMQ consumption BEFORE calling foreign server (so consumer is ready when message arrives)
    const sessionDataPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(async () => {
        console.log('⏰ Timeout reached - cleaning up consumer');
        await cleanupConsumer();
        resolve([]); // Return empty array if timeout
      }, 30000); // 30 second timeout

      // Set up consumer BEFORE foreign server call
      rabbitmq.consumeQueue(rabbitmq.queues.chatsession, async (message) => {
        try {
          if (isStreamingComplete) {
            console.log('⏹️  Streaming complete, ignoring RabbitMQ message');
            return;
          }
          
          console.log('📨 Received message from RabbitMQ chatsession queue:', message);
          console.log('📊 Message type:', typeof message, 'Array?', Array.isArray(message));
          console.log('📋 Message content:', JSON.stringify(message, null, 2));
          
          // Process message - handle both direct array and object with sessions property
          let transformedSessions = [];
          
          console.log('🔍 Debug: message is array?', Array.isArray(message));
          console.log('🔍 Debug: message length:', message.length);
          console.log('🔍 Debug: message[0] type:', typeof message[0]);
          console.log('🔍 Debug: message[0].user_id exists?', message[0]?.user_id !== undefined);
          console.log('🔍 Debug: message[0].sessions exists?', message[0]?.sessions !== undefined);
          
          if (Array.isArray(message) && message.length > 0 && Array.isArray(message[0])) {
            // Direct array format: [["s010", "New test session"], ["s003", "Document analysis"]]
            console.log('🔍 Processing direct array format');
            transformedSessions = message.map(sessionArray => ({
              S_id: sessionArray[0], // session_id
              title: sessionArray[1], // session title
              created_at: new Date().toISOString(),
              C_id: null, // chat_id not available from RabbitMQ
              source: 'rabbitmq'
            }));
          } else if (Array.isArray(message) && message.length > 0 && message[0].user_id && message[0].sessions) {
            // Array with object format: [{ user_id: "atul", sessions: [{ s_id: "1", s_name: "Login session" }] }]
            console.log('🔍 Processing array with object format - new structure');
            const userSession = message.find(item => item.user_id === user_id);
            if (userSession && userSession.sessions) {
              transformedSessions = userSession.sessions.map(session => ({
                S_id: session.s_id,
                title: session.s_name,
                created_at: session.created_at || new Date().toISOString(),
                C_id: null,
                source: 'rabbitmq'
              }));
            }
          } else if (message.user_id === user_id && message.sessions) {
            // Object format with user_id: {user_id: "...", sessions: [...]}
            console.log('🔍 Processing object format with user_id filter');
            if (Array.isArray(message.sessions[0])) {
              // Sessions as arrays: [["s010", "title"], ["s011", "title2"]]
              transformedSessions = message.sessions.map(sessionArray => ({
                S_id: sessionArray[0],
                title: sessionArray[1],
                created_at: message.timestamp || new Date().toISOString(),
                C_id: null,
                source: 'rabbitmq'
              }));
            } else {
              // Sessions as objects: [{ s_id: "1", s_name: "Login session" }]
              transformedSessions = message.sessions.map(session => ({
                S_id: session.s_id,
                title: session.s_name,
                created_at: session.created_at || new Date().toISOString(),
                C_id: null,
                source: 'rabbitmq'
              }));
            }
          }

          console.log('✨ Transformed sessions:', transformedSessions.length, 'sessions');
          console.log('📄 Session details:', JSON.stringify(transformedSessions, null, 2));

          // 🎯 ALWAYS RESOLVE - Even if no sessions found
          if (transformedSessions.length > 0) {
            // 🎯 ENHANCED DEDUPLICATION LOGIC - Prioritize RabbitMQ session names (they are correct from foreign server LLM)
            console.log('🔄 Updating globalSessionNames with RabbitMQ data using RabbitMQ title prioritization...');
            
            // Get current sessions for this user (both local and existing rabbitmq)
            const currentUserSessions = globalSessionNames.filter(session => session.user_id === user_id);
            console.log('📊 Current user sessions before deduplication:', currentUserSessions.length);
            
            // Create a Map to track unique sessions by session_id
            const sessionMap = new Map();
            
            // First, add existing sessions to the map
            currentUserSessions.forEach(session => {
              sessionMap.set(session.session_id, {
                ...session,
                originalSource: session.source, // Track original source
                originalTitle: session.title    // Track original title
              });
            });
            
            // Then, add/update with RabbitMQ sessions (RabbitMQ titles have priority!)
            transformedSessions.forEach(session => {
              const sessionId = session.S_id;
              
              if (!sessionMap.has(sessionId)) {
                // New session from RabbitMQ - add it
                sessionMap.set(sessionId, {
                  session_id: sessionId,
                  title: session.title, // Use RabbitMQ title (correct one from foreign server LLM)
                  user_id: user_id,
                  current_chat_id: null,
                  total_chats: 0,
                  created_at: session.created_at,
                  updated_at: session.created_at,
                  source: 'rabbitmq',
                  titleSource: 'rabbitmq' // Track where title came from
                });
                console.log('➕ Added new RabbitMQ session:', sessionId, 'with title:', `"${session.title}"`);
              } else {
                // Session exists - ALWAYS update title with RabbitMQ version (it's correct from foreign server LLM)
                const existing = sessionMap.get(sessionId);
                const oldTitle = existing.title;
                const oldSource = existing.originalSource || existing.source;
                
                sessionMap.set(sessionId, {
                  ...existing,
                  title: session.title, // ✅ ALWAYS use RabbitMQ title (foreign server LLM updated via first chat response)
                  updated_at: session.created_at,
                  source: oldSource === 'local' ? 'local_updated_from_rabbitmq' : 'rabbitmq',
                  titleSource: 'rabbitmq', // Mark that title came from RabbitMQ (foreign server LLM)
                  titleUpdated: oldTitle !== session.title // Flag if title was updated
                });
                
                if (oldTitle !== session.title) {
                  console.log('🔄 Updated session', sessionId, 'title (RabbitMQ priority):');
                  console.log(`   Old (${oldSource}): "${oldTitle}"`);
                  console.log(`   New (RabbitMQ/LLM): "${session.title}"`);
                  console.log('   ✅ Foreign server LLM title is now displayed');
                } else {
                  console.log('📌 Session', sessionId, 'title unchanged:', `"${session.title}"`);
                }
              }
            });
            
            // Convert Map back to array
            const deduplicatedSessions = Array.from(sessionMap.values());
            
            // ⚡ PARALLEL OPTIMIZATION: Resolve promise IMMEDIATELY with fresh data
            clearTimeout(timeoutId);
            const responseData = deduplicatedSessions.map(session => ({
              S_id: session.session_id,
              title: session.title,
              created_at: session.created_at,
              C_id: session.current_chat_id,
              source: session.source,
              titleSource: session.titleSource
            }));
            
            console.log(`⚡ FAST RESPONSE: Sending ${deduplicatedSessions.length} sessions immediately to UI`);
            resolve(responseData); // ✅ Send response FIRST (fast UI)
            
            // 🔄 BACKGROUND UPDATE: Update globalSessionNames asynchronously (non-blocking)
            (async () => {
              try {
                // Remove old sessions for this user and add deduplicated ones
                globalSessionNames = globalSessionNames.filter(session => session.user_id !== user_id);
                globalSessionNames.unshift(...deduplicatedSessions);
                
                console.log('✅ BACKGROUND DEDUPLICATION COMPLETE:');
                console.log('   - Original RabbitMQ sessions:', transformedSessions.length);
                console.log('   - Existing user sessions:', currentUserSessions.length);
                console.log('   - Final deduplicated sessions:', deduplicatedSessions.length);
                console.log('   - Total globalSessionNames:', globalSessionNames.length);
                
                // Cleanup consumer after background update
                await cleanupConsumer();
                console.log('✅ Background global state update complete');
              } catch (error) {
                console.error('❌ Error in background globalSessionNames update:', error);
                await cleanupConsumer();
              }
            })(); // Immediately invoked async function
          } else {
            // 🎯 SIMPLE FIX: No sessions found in RabbitMQ - return existing sessions or empty array
            console.log('📭 No sessions found in RabbitMQ message - checking existing sessions');
            const existingSessions = globalSessionNames.filter(session => session.user_id === user_id);
            
            clearTimeout(timeoutId);
            await cleanupConsumer();
            
            console.log('📤 Returning existing sessions since RabbitMQ had no data:', existingSessions.length);
            resolve(existingSessions.map(session => ({
              S_id: session.session_id,
              title: session.title,
              created_at: session.created_at,
              C_id: session.current_chat_id,
              source: session.source || 'existing'
            })));
          }
        } catch (error) {
          console.error('❌ Error processing RabbitMQ session message:', error);
        }
      }).then(consumer => {
        rabbitConsumer = consumer;
        console.log('✅ Sequential consumer created for \'chatsession\'');
      }).catch(error => {
        console.error('❌ Error setting up RabbitMQ consumer:', error);
        clearTimeout(timeoutId);
        reject(error);
      });
    });

    // STEP 2: NOW call foreign server (consumer is already listening)
    console.log('🌐 Step 2: Calling foreign server /session_name endpoint for user:', user_id);
    
    try {
      const sessionNameUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/session_name`;
      console.log('📡 Sending request to foreign server:', sessionNameUrl);
      
      const foreignServerPayload = {
        user_id: String(user_id)
      };
      
      console.log('📤 Foreign server payload:', JSON.stringify(foreignServerPayload, null, 2));
      
      // Setup AbortController for timeout
      const controller = new AbortController();
      const fetchTimeoutId = setTimeout(() => {
        controller.abort();
      }, 30000); // 30 second timeout for session_name calls
      
      const foreignResponse = await fetch(sessionNameUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers.authorization || ''
        },
        body: JSON.stringify(foreignServerPayload),
        agent: httpsAgent,
        signal: controller.signal
      });
      
      clearTimeout(fetchTimeoutId);
      
      console.log('🌐 Foreign server response status:', foreignResponse.status);
      
      if (!foreignResponse.ok) {
        const errorText = await foreignResponse.text();
        console.log('❌ Foreign server error:', errorText);
        // Continue to RabbitMQ consumption even if foreign server fails
      } else {
        const responseData = await foreignResponse.json();
        console.log('✅ Foreign server /session_name call successful:', responseData);
      }
      
    } catch (error) {
      console.error('❌ Error calling foreign server /session_name:', error);

      // If foreign server times out or fails and we have local sessions, return them
      if (hasLocalSessionsOnly && userGlobalSessions.length > 0) {
        console.log('⚠️ Foreign server failed but local sessions exist - returning local sessions as fallback');
        const paginatedSessions = userGlobalSessions.slice(0, limit);
        return res.json({
          success: true,
          sessions: paginatedSessions,
          total: userGlobalSessions.length,
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: userGlobalSessions.length > limit,
          source: 'local_fallback',
          cached: true,
          warning: 'Foreign server unavailable - showing local sessions only'
        });
      }
      // Continue to RabbitMQ consumption even if foreign server fails
    }

    // STEP 3: Wait for RabbitMQ data (consumer will receive message published by foreign server)
    console.log('⏳ Waiting for RabbitMQ session data...');
    const sessionData = await sessionDataPromise;
    
    console.log('✅ Session data retrieval completed');
    
    // // 🆕 NEW: Add delay to ensure globalSessionNames is fully populated
    // console.log('⏳ Waiting additional 1.5s for globalSessionNames to be populated...');
    //await new Promise(resolve => setTimeout(resolve, 1500));
    // console.log(`✅ Delay complete. globalSessionNames now contains ${globalSessionNames.length} sessions`);
    // console.log(`📊 Sessions for current user: ${globalSessionNames.filter(s => s.user_id === user_id).length}`);
    
    // Return session data
    return res.json({
      success: true,
      sessions: sessionData.slice(0, limit),
      total: sessionData.length,
      page: parseInt(page),
      limit: parseInt(limit),
      hasMore: sessionData.length > limit,
      source: 'foreign_server_rabbitmq', // 🆕 Always from foreign server
      cached: false
    });

  } catch (error) {
    console.error('❌ Session history error:', error);
    
    // Cleanup consumer on error
    await cleanupConsumer();
    
    return res.status(500).json({
      success: false,
      error: `Server error: ${error.message}`,
      stack: error.stack,
      source: 'error'
    });
  }
});

// TASK 3: /sessionchathistory Endpoint 
// 🎯 FLOW: Called ONLY when user navigates from homepage to chatpage AND clicks on a session
// Step 1: Check if session chat history exists in globalChatHistory
// Step 2: If NOT found, call foreign server with user_id and session_id
// Step 3: Foreign server publishes session chat history to RabbitMQ sessionhistory queue
// Step 4: Consume from RabbitMQ and store in globalChatHistory variable
// Step 5: Return chat messages to load in main chat area
router.post('/sessionhistory', async (req, res) => {
  // Always use the stored user ID from login - no fallbacks
  const user_id = getCurrentUserId();
  const { session_id } = req.body;
  
  if (!user_id) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated. Please login first.'
    });
  }
  
  console.log('🔄 SessionChatHistory using stored user ID from login:', user_id);
  console.log('🔍 RECEIVED session_id:', session_id, 'type:', typeof session_id);

  if (!session_id) {
    return res.status(400).json({
      success: false,
      error: 'session_id is required'
    });
  }

  // RabbitMQ consumer management
  let rabbitConsumer = null;
  let isStreamingComplete = false;

  const cleanupConsumer = async () => {
    if (rabbitConsumer && !isStreamingComplete) {
      console.log('🛑 Stopping RabbitMQ consumption for sessionchathistory:', user_id, session_id);
      try {
        const cancelled = await rabbitmq.cancelConsumer(rabbitConsumer);
        if (cancelled) {
          console.log('✅ Consumer cancelled successfully');
        }
      } catch (error) {
        console.error('❌ Error cancelling consumer:', error);
      }
      rabbitConsumer = null;
      isStreamingComplete = true;
    }
  };

  try {
    console.log('🚀 SessionChatHistory endpoint hit for session:', { user_id, session_id });

    // STEP 1: CHECK GLOBAL CHAT HISTORY FIRST
    const historyKey = `${user_id}_${session_id}`;
    console.log('🔍 Looking for historyKey:', historyKey);
    
    if (globalChatHistory[historyKey] && globalChatHistory[historyKey].length > 0) {
      console.log('✅ FAST RETURN: Found', globalChatHistory[historyKey].length, 'messages in globalChatHistory');
      
      const globalMessages = globalChatHistory[historyKey].map(msg => {
        const messageData = {
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          message_type: msg.message_type,
          chat_id: msg.chat_id,
          source: 'global_memory'
        };
        
        // Include thinking content if available
        if (msg.thinkingContent) {
          messageData.thinkingContent = msg.thinkingContent;
        }
        
        // Include temp file name if available (for pin icon display)
        if (msg.temp_file_name) {
          messageData.temp_file_name = msg.temp_file_name;
        }
        
        return messageData;
      });
      
      return res.json({
        success: true,
        messages: globalMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
        session_id,
        total: globalMessages.length,
        source: 'global_memory'
      });
    }

    // STEP 2: CALL FOREIGN SERVER
    console.log('🌐 No cached data found - calling foreign server for session chat history');
    
    try {
      const sessionChatUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/session_history`;
      console.log('📡 Sending request to foreign server:', sessionChatUrl);
      
      const foreignServerPayload = {
        user_id: String(user_id),
        session_id: String(session_id)
      };
      
      console.log('📤 Foreign server payload:', JSON.stringify(foreignServerPayload, null, 2));
      
      // Setup AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 15000); // 15 second timeout for session history calls
      
      const foreignResponse = await fetch(sessionChatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers.authorization || ''
        },
        body: JSON.stringify(foreignServerPayload),
        agent: httpsAgent,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      console.log('🌐 Foreign server response status:', foreignResponse.status);
      
      if (foreignResponse.ok) {
        const _responseData = await foreignResponse.json();
        console.log('✅ Foreign server session chat history call successful');
      } else {
        const errorText = await foreignResponse.text();
        console.log('❌ Foreign server error:', errorText);
      }
      
    } catch (error) {
      console.error('❌ Error calling foreign server for session chat history:', error);
    }

    // STEP 3: 🎯 FIXED RABBITMQ CONSUMPTION WITH PROPER RESPONSE HANDLING
    console.log('📡 Starting RabbitMQ consumption with FIXED response handling...');
    
    const sessionChatHistoryPromise = new Promise((resolve, reject) => {
      let timeoutId;
      
      // 🎯 KEY FIX: Capture session-specific variables in closure
      const currentSessionId = session_id;
      const currentUserId = user_id;
      const currentHistoryKey = `${currentUserId}_${currentSessionId}`;
      
      console.log('🔒 CLOSURE: Captured session-specific variables:', {
        currentSessionId,
        currentUserId,
        currentHistoryKey
      });
      
      const setupTimeout = () => {
        timeoutId = setTimeout(async () => {
          console.log('⏰ Timeout reached for session:', currentSessionId, '- cleaning up consumer');
          await cleanupConsumer();
          console.log('🔍 TIMEOUT: No data received from RabbitMQ within 10 seconds for session:', currentSessionId);
          resolve([]); // Resolve with empty array on timeout
        }, 10000);
      };
      
      setupTimeout();

      // 🎯 KEY FIX: Set up consumer with session-specific context and unique consumer tag
      const sessionConsumerTag = `sessionhistory_${currentUserId}_${currentSessionId}_${Date.now()}`;
      console.log('🏷️ Creating session-specific consumer with tag:', sessionConsumerTag);
      
      rabbitmq.consumeQueue(rabbitmq.queues.sessionhistory, async (message) => {
        try {
          if (isStreamingComplete) {
            console.log('⏹️ Streaming complete, ignoring RabbitMQ message for session:', currentSessionId);
            return;
          }
          
          console.log('📨 🎯 FIXED: Received session chat history for SESSION:', currentSessionId, 'from RabbitMQ:', typeof message, Array.isArray(message));
          
          let sessionChatMessages = [];
          
          // Process message based on format
          if (Array.isArray(message) && message.length > 0) {
            console.log('🔍 RabbitMQ returned direct chat messages array for session:', currentSessionId, 'count:', message.length);
            sessionChatMessages = message;
          } else if (message && typeof message === 'object') {
            console.log('🔍 RabbitMQ returned single message object for session:', currentSessionId);
            sessionChatMessages = [message];
          }

          if (sessionChatMessages.length > 0) {
            console.log('✅ 🎯 PROCESSING', sessionChatMessages.length, 'messages for session:', currentSessionId, 'globalChatHistory storage');
            
            // Transform messages
            const transformedMessages = [];
            
            sessionChatMessages.forEach(msg => {
              if (msg.prompt && msg.response) {
                // User message
                const userMessage = {
                  role: 'user',
                  content: msg.prompt,
                  timestamp: msg.timestamp || msg.created_at || new Date().toISOString(),
                  message_type: 'prompt',
                  chat_id: msg.chat_id || msg.c_id || null,
                  session_id: currentSessionId, // 🎯 USE CLOSURE VARIABLE
                  user_id: currentUserId,       // 🎯 USE CLOSURE VARIABLE
                  source: 'foreign_server_rabbitmq'
                };
                
                // Include temp file name if available (for pin icon display)
                if (msg.temp_file_name) {
                  userMessage.temp_file_name = msg.temp_file_name;
                }
                
                transformedMessages.push(userMessage);
                
                // Assistant response
                transformedMessages.push({
                  role: 'assistant',
                  content: msg.response,
                  timestamp: msg.timestamp || msg.created_at || new Date().toISOString(),
                  message_type: 'response',
                  chat_id: msg.chat_id || msg.c_id || null,
                  session_id: currentSessionId, // 🎯 USE CLOSURE VARIABLE
                  user_id: currentUserId,       // 🎯 USE CLOSURE VARIABLE
                  source: 'foreign_server_rabbitmq'
                });
              } else if (msg.role && msg.content) {
                const standardMessage = {
                  role: msg.role,
                  content: msg.content,
                  timestamp: msg.timestamp || msg.created_at || new Date().toISOString(),
                  message_type: msg.message_type || (msg.role === 'user' ? 'prompt' : 'response'),
                  chat_id: msg.chat_id || msg.c_id || null,
                  session_id: currentSessionId, // 🎯 USE CLOSURE VARIABLE
                  user_id: currentUserId,       // 🎯 USE CLOSURE VARIABLE
                  source: 'foreign_server_rabbitmq'
                };
                
                // Include temp file name if available (for pin icon display)
                if (msg.temp_file_name) {
                  standardMessage.temp_file_name = msg.temp_file_name;
                }
                
                transformedMessages.push(standardMessage);
              }
            });

            // 🎯 KEY FIX: STORE IN CORRECT GLOBAL VARIABLE KEY
            console.log('💾 🎯 STORING', transformedMessages.length, 'messages in globalChatHistory[' + currentHistoryKey + '] for session:', currentSessionId);
            globalChatHistory[currentHistoryKey] = transformedMessages;
            
            console.log('✅ 🎯 VERIFICATION: globalChatHistory stored messages for session:', currentSessionId, '- count:', globalChatHistory[currentHistoryKey]?.length);
            console.log('📊 GlobalChatHistory total keys:', Object.keys(globalChatHistory).length);
            
            // Cleanup consumer BEFORE resolving
            clearTimeout(timeoutId);
            await cleanupConsumer();
            
            console.log('✅ 🎯 RESOLVING with', transformedMessages.length, 'messages for UI - session:', currentSessionId);
            resolve(transformedMessages);
            
          } else {
            console.log('⚠️ No chat messages found for session:', currentSessionId);
            clearTimeout(timeoutId);
            await cleanupConsumer();
            resolve([]);
          }
        } catch (error) {
          console.error('❌ Error processing RabbitMQ session chat history message for session:', currentSessionId, error);
          clearTimeout(timeoutId);
          await cleanupConsumer();
          resolve([]);
        }
      }, sessionConsumerTag).then(consumer => {
        rabbitConsumer = consumer;
        console.log('✅ 🎯 RabbitMQ consumer started successfully for session chat history - session:', currentSessionId);
      }).catch(error => {
        console.error('❌ Error setting up RabbitMQ consumer for session chat history - session:', currentSessionId, error);
        clearTimeout(timeoutId);
        reject(error);
      });
    });

    // STEP 4: 🎯 WAIT FOR RABBITMQ DATA AND SEND RESPONSE
    console.log('⏳ 🎯 WAITING for RabbitMQ session chat history data...');
    const chatMessages = await sessionChatHistoryPromise;
    
    console.log('✅ 🎯 RECEIVED', chatMessages.length, 'messages from Promise resolution');
    
    // 🎯 CRITICAL: FORCE CLEANUP CONSUMER IMMEDIATELY AFTER PROMISE RESOLUTION
    console.log('🧹 🎯 FORCING IMMEDIATE CONSUMER CLEANUP for session:', session_id);
    await cleanupConsumer();
    console.log('✅ 🎯 CONSUMER CLEANUP COMPLETE for session:', session_id);
    
    // STEP 5: 🎯 DOUBLE-CHECK GLOBAL STORAGE BEFORE SENDING RESPONSE
    const verifyKey = `${user_id}_${session_id}`;
    const storedMessages = globalChatHistory[verifyKey];
    
    console.log('🔍 🎯 VERIFICATION BEFORE UI RESPONSE:');
    console.log('   - Promise returned:', chatMessages.length, 'messages');
    console.log('   - GlobalChatHistory contains:', storedMessages?.length, 'messages');
    console.log('   - Key used:', verifyKey);
    
    // Send response to UI
    const finalMessages = chatMessages.map(msg => {
      const messageData = {
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        message_type: msg.message_type,
        chat_id: msg.chat_id,
        source: 'foreign_server_rabbitmq'
      };
      
      // Include thinking content if available
      if (msg.thinkingContent) {
        messageData.thinkingContent = msg.thinkingContent;
      }
      
      // Include temp file name if available (for pin icon display)
      if (msg.temp_file_name) {
        messageData.temp_file_name = msg.temp_file_name;
      }
      
      return messageData;
    });

    console.log('📤 🎯 SENDING TO UI:', finalMessages.length, 'messages');

    return res.json({
      success: true,
      messages: finalMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
      session_id,
      total: finalMessages.length,
      source: 'foreign_server_rabbitmq',
      stored_in_global: true,
      verification: {
        promise_messages: chatMessages.length,
        global_messages: storedMessages?.length || 0,
        key_used: verifyKey
      }
    });

  } catch (error) {
    console.error('❌ Session chat history error:', error);
    await cleanupConsumer();
    
    return res.status(500).json({
      success: false,
      error: `Server error: ${error.message}`,
      session_id,
      source: 'error'
    });
  }
});

// TASK 4: Create new chat session endpoint with 10-session sliding window
router.post('/chatsession', async (req, res) => {
  console.log('🎯 /chatsession POST endpoint HIT!');
  
  let { user_id, title } = req.body;

  // Use stored user ID from login instead of JWT extraction
  if (!user_id || user_id === 'default_user') {
    user_id = getCurrentUserId();
    console.log('🔄 Using stored user ID from login for new session:', user_id);
  }

  try {
    // STEP 0: Get current session count from global variables
    const userSessions = globalSessionNames.filter(session => session.user_id === user_id);
    const currentSessionCount = userSessions.length;
    console.log('📊 Current session count for user:', user_id, '=', currentSessionCount);
    
    // STEP 1: Check and manage 10-session sliding window BEFORE creating new session
    console.log('🪟 CHECKING 10-session window before creating new session...');
    const windowResult = await manageSessionWindow(user_id);
    
    // STEP 2: Generate incremental session ID using foreign server session count as starting point
    const sessionId = getNextSessionId(user_id);
    console.log('🆔 Generated new session ID:', sessionId, 'for user:', user_id);

    // STEP 3: Create session title if not provided
    const sessionTitle = title || `Chat Session ${sessionId}`;

    // STEP 4: Store session locally in globalSessionNames - Don't send to foreign server as it doesn't support /chatsession
    console.log('📝 Creating session locally:', {
      session_id: sessionId,
      user_id: user_id,
      title: sessionTitle
    });
    
    // Add the new session to globalSessionNames
    const newSession = {
      session_id: sessionId,
      title: sessionTitle,
      user_id: user_id,
      created_at: new Date().toISOString(),
      source: 'local',
      total_chats: 0
    };
    
    globalSessionNames.unshift(newSession);
    console.log('📝 Added new session to globalSessionNames:', sessionTitle);

    // STEP 5: Return success with new session info + window management notification
    const response = {
      success: true,
      session_id: sessionId,
      user_id: user_id,
      title: sessionTitle,
      message: 'Chat session created successfully',
      created_at: new Date().toISOString(),
      session_count: windowResult.sessionCount || (currentSessionCount + 1) // Send actual session count to UI
    };
    
    // Add window management info if there are notifications
    if (windowResult.shouldNotifyUser) {
      response.window_management = {
        is_warning: windowResult.isWarning,
        deleted_session: windowResult.deletedSession,
        notification: windowResult.message,
        action: windowResult.isWarning ? 'session_limit_warning' : 'oldest_session_deleted_automatically',
        current_session_count: windowResult.sessionCount
      };
      
      if (windowResult.isWarning) {
        console.log('⚠️ NOTIFYING USER: 10th session created - warning about auto-deletion');
      } else {
        console.log('🔔 NOTIFYING USER: Oldest session deleted due to 10-session limit');
      }
    }
    
    res.json(response);

  } catch (error) {
    console.error('❌ Error creating chat session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create chat session',
      details: error.message
    });
  }
});

// DELETE SESSION ENDPOINT - Delete specific session with foreign server integration
router.delete('/deletesession/:sessionId', async (req, res) => {
  console.log('🗑️ DELETE SESSION endpoint hit');
  
  const { sessionId } = req.params;
  
  // Always use the stored user ID from login
  const user_id = getCurrentUserId();
  
  if (!user_id) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated. Please login first.'
    });
  }
  
  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Session ID is required'
    });
  }
  
  console.log('🗑️ Deleting session:', sessionId, 'for user:', user_id);
  
  try {
    // STEP 1: Check if session exists in global variables
    const sessionExists = globalSessionNames.find(session => 
      session.user_id === user_id && session.session_id === sessionId
    );
    
    if (!sessionExists) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
        session_id: sessionId
      });
    }
    
    // STEP 2: Call foreign server to delete session from database
    let foreignDeleteResult = null;
    try {
      const deleteUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/delete_session`;
      console.log('📡 Calling foreign server delete session:', deleteUrl);
      
      const payload = {
        user_id: String(user_id),
        session_id: String(sessionId)
      };
      
      console.log('📤 Foreign server delete payload:', JSON.stringify(payload, null, 2));
      
      // Setup AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 10000); // 10 second timeout for delete calls
      
      const response = await fetch(deleteUrl, {
        method: 'POST', // or DELETE depending on foreign server API
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers.authorization || ''
        },
        body: JSON.stringify(payload),
        agent: httpsAgent,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      console.log('🌐 Foreign server delete response status:', response.status);
      
      if (response.ok) {
        const responseData = await response.json();
        foreignDeleteResult = responseData;
        console.log('✅ Foreign server session deleted successfully:', responseData);
      } else {
        const errorText = await response.text();
        console.log('❌ Foreign server delete error:', errorText);
        foreignDeleteResult = { error: errorText, status: response.status };
      }
      
    } catch (foreignError) {
      console.error('❌ Error calling foreign server delete:', foreignError);
      foreignDeleteResult = { error: foreignError.message };
    }
    
    // STEP 3: Delete session from local global variables (regardless of foreign server result)
    console.log('🧹 Cleaning up local session data...');
    
    // Remove from globalSessionNames
    const beforeCount = globalSessionNames.length;
    globalSessionNames = globalSessionNames.filter(session => 
      !(session.user_id === user_id && session.session_id === sessionId)
    );
    const sessionsRemoved = beforeCount - globalSessionNames.length;
    
    // Remove from globalChatHistory
    const historyKey = `${user_id}_${sessionId}`;
    let messagesRemoved = 0;
    if (globalChatHistory[historyKey]) {
      messagesRemoved = globalChatHistory[historyKey].length;
      delete globalChatHistory[historyKey];
      console.log('🗑️ Deleted', messagesRemoved, 'messages from globalChatHistory');
    }
    
    // Remove from sessionMessageCounts
    const sessionKey = `${user_id}_${sessionId}`;
    let messageCountRemoved = false;
    if (sessionMessageCounts.has(sessionKey)) {
      sessionMessageCounts.delete(sessionKey);
      messageCountRemoved = true;
      console.log('🗑️ Cleared session message count');
    }
    
    console.log('✅ LOCAL CLEANUP COMPLETE:');
    console.log('   - Sessions removed from globalSessionNames:', sessionsRemoved);
    console.log('   - Messages removed from globalChatHistory:', messagesRemoved);
    console.log('   - Message count cleared:', messageCountRemoved);
    
    // STEP 4: Return success response
    const response = {
      success: true,
      message: 'Session deleted successfully',
      session_id: sessionId,
      user_id: user_id,
      local_cleanup: {
        sessions_removed: sessionsRemoved,
        messages_removed: messagesRemoved,
        message_count_cleared: messageCountRemoved
      },
      foreign_server_result: foreignDeleteResult,
      timestamp: new Date().toISOString()
    };
    
    console.log('✅ SESSION DELETION COMPLETE:', sessionId);
    res.json(response);
    
  } catch (error) {
    console.error('❌ Error deleting session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete session',
      details: error.message,
      session_id: sessionId
    });
  }
});

// TASK 5: User session cleanup function - Called by auth.js logout endpoint
export const clearUserSessionData = async (user_id) => {
  console.log('=== CLEARUSERSESSIONDATA FUNCTION CALLED ===');
  console.log('User ID to clear:', user_id);
  console.log('Current globalSessionNames count:', globalSessionNames.length);
  console.log('Current globalChatHistory keys count:', Object.keys(globalChatHistory).length);
  console.log('=== STARTING CLEANUP ===');
  console.log('�️ Clearing session data for user:', user_id);
  
  try {
  console.log('🗑️ DETAILED DEBUG: globalSessionNames before filtering:');
  globalSessionNames.forEach((session, index) => {
    console.log(`  [${index}] user_id: "${session.user_id}" (type: ${typeof session.user_id}), session_id: "${session.session_id}"`);
    console.log(`       Match with "${user_id}"? ${session.user_id === user_id}`);
  });
  
  // Clear user's sessions from globalSessionNames
  const beforeCount = globalSessionNames.length;
  const userSessions = globalSessionNames.filter(session => session.user_id === user_id);
  console.log('🔍 Found', userSessions.length, 'sessions matching user_id:', user_id);
  
  globalSessionNames = globalSessionNames.filter(session => session.user_id !== user_id);
  const afterCount = globalSessionNames.length;
  const removedCount = beforeCount - afterCount;    console.log('🗑️ Removed', removedCount, 'sessions from globalSessionNames for user:', user_id);

    // Clear user's chat history from globalChatHistory variable (KEY REQUIREMENT - flush on logout)
    const chatHistoryKeys = Object.keys(globalChatHistory);
    console.log('🗑️ DETAILED DEBUG: All globalChatHistory keys:');
    chatHistoryKeys.forEach(key => {
      console.log(`  Key: "${key}" - starts with "${user_id}_"? ${key.startsWith(`${user_id}_`)}`);
    });
    
    const userChatKeys = chatHistoryKeys.filter(key => key.startsWith(`${user_id}_`));
    
    console.log('🗑️ FLUSHING globalChatHistory for user:', user_id);
    console.log('📊 Found', userChatKeys.length, 'session chat histories to flush:', userChatKeys);
    
    userChatKeys.forEach(key => {
      const messageCount = globalChatHistory[key] ? globalChatHistory[key].length : 0;
      console.log('🗑️ Flushing', messageCount, 'messages from globalChatHistory key:', key);
      delete globalChatHistory[key];
    });
    
    console.log('✅ FLUSH COMPLETE: Removed', userChatKeys.length, 'chat history sessions from globalChatHistory');
    console.log('📊 globalChatHistory is now ready for fresh data when user returns from homepage→chatpage');

    // Clear session message counts for this user
    const sessionKeys = Array.from(sessionMessageCounts.keys());
    const userSessionKeys = sessionKeys.filter(key => key.startsWith(`${user_id}_`));
    
    userSessionKeys.forEach(key => {
      sessionMessageCounts.delete(key);
    });
    
    console.log('🗑️ Cleared', userSessionKeys.length, 'session message counts for user:', user_id);

    // Clear foreign last session ID and session counter for this user
    delete foreignLastSessionIds[user_id];
    delete sessionCounters[user_id];
    
    // Clear current user ID if it matches the logging out user
    if (currentUserId === user_id) {
      currentUserId = null;
      console.log('🗑️ Cleared current user ID');
    }
    
    console.log('🗑️ Cleared foreign last session ID and session counter for user:', user_id);

    console.log('✅ USER CLEANUP COMPLETE: All chat data cleared for user:', user_id);
    console.log('📊 System state - globalSessionNames:', globalSessionNames.length, 'globalChatHistory keys:', Object.keys(globalChatHistory).length);

    return {
      success: true,
      cleared: {
        sessions: removedCount,
        chatHistories: userChatKeys.length,
        messageCounts: userSessionKeys.length
      }
    };

  } catch (error) {
    console.error('❌ Error during user session cleanup:', error);
    throw error;
  }
};

// COMPLETE SYSTEM FLUSH: Clear ALL global variables on logout
const flushAllGlobalVariables = async () => {
  console.log('=== COMPLETE SYSTEM FLUSH STARTED ===');
  console.log('🧨 FLUSHING ALL GLOBAL VARIABLES - COMPLETE SYSTEM RESET');
  
  try {
    // Store counts before clearing for logging
    const beforeCounts = {
      globalSessionNames: globalSessionNames.length,
      globalChatHistory: Object.keys(globalChatHistory).length,
      sessionMessageCounts: sessionMessageCounts.size,
      foreignLastSessionIds: Object.keys(foreignLastSessionIds).length,
      sessionCounters: Object.keys(sessionCounters).length
    };
    
    // console.log('📊 BEFORE FLUSH:');
    // console.log('   globalSessionNames:', beforeCounts.globalSessionNames);
    // console.log('   globalChatHistory keys:', beforeCounts.globalChatHistory);
    // console.log('   sessionMessageCounts:', beforeCounts.sessionMessageCounts);
    // console.log('   foreignLastSessionIds:', beforeCounts.foreignLastSessionIds);
    // console.log('   sessionCounters:', beforeCounts.sessionCounters);
    
    // 1. COMPLETELY CLEAR globalSessionNames array
    globalSessionNames.length = 0; // Clear array efficiently
    //console.log('🧨 FLUSHED globalSessionNames - now empty array');
    
    // 2. COMPLETELY CLEAR globalChatHistory object
    Object.keys(globalChatHistory).forEach(key => {
      delete globalChatHistory[key];
    });
    //console.log('🧨 FLUSHED globalChatHistory - now empty object');
    
    // 3. COMPLETELY CLEAR sessionMessageCounts Map
    sessionMessageCounts.clear();
    //console.log('🧨 FLUSHED sessionMessageCounts - now empty Map');
    
    // 4. COMPLETELY CLEAR sessionCacheTimestamp Map
    sessionCacheTimestamp.clear();
    //console.log('🧨 FLUSHED sessionCacheTimestamp - now empty Map');
    
    // 5. COMPLETELY CLEAR foreignLastSessionIds object
    Object.keys(foreignLastSessionIds).forEach(key => {
      delete foreignLastSessionIds[key];
    });
    //console.log('🧨 FLUSHED foreignLastSessionIds - now empty object');
    
    // 6. COMPLETELY CLEAR sessionCounters object
    Object.keys(sessionCounters).forEach(key => {
      delete sessionCounters[key];
    });
    //console.log('🧨 FLUSHED sessionCounters - now empty object');
    
    // 7. CLEAR currentUserId
    currentUserId = null;
    //console.log('🧨 FLUSHED currentUserId - now null');
    
    // 8. CLEAR thinkingContentBuffer object
    Object.keys(thinkingContentBuffer).forEach(key => {
      delete thinkingContentBuffer[key];
    });
    //console.log('🧨 FLUSHED thinkingContentBuffer - now empty object');
    
    // 9. CLEAR globalModelList array
    globalModelList.length = 0;
    //console.log('🧨 FLUSHED globalModelList - now empty array');
    
    // 10. CLEAR modelListCacheTimestamp
    modelListCacheTimestamp = null;
   // console.log('🧨 FLUSHED modelListCacheTimestamp - now null');
    
    // 11. CLEAR globalPersonalizedFiles object
    Object.keys(globalPersonalizedFiles).forEach(key => {
      delete globalPersonalizedFiles[key];
    });
    //console.log('🧨 FLUSHED globalPersonalizedFiles - now empty object');
    
    // Verify everything is cleared
    const afterCounts = {
      globalSessionNames: globalSessionNames.length,
      globalChatHistory: Object.keys(globalChatHistory).length,
      sessionMessageCounts: sessionMessageCounts.size,
      foreignLastSessionIds: Object.keys(foreignLastSessionIds).length,
      sessionCounters: Object.keys(sessionCounters).length
    };
    
    console.log('📊 AFTER COMPLETE FLUSH:');
    console.log('   globalSessionNames:', afterCounts.globalSessionNames);
    console.log('   globalChatHistory keys:', afterCounts.globalChatHistory);
    console.log('   sessionMessageCounts:', afterCounts.sessionMessageCounts);
    console.log('   foreignLastSessionIds:', afterCounts.foreignLastSessionIds);
    console.log('   sessionCounters:', afterCounts.sessionCounters);
    console.log('   currentUserId:', currentUserId);
    
    console.log('🎯 COMPLETE SYSTEM FLUSH SUCCESSFUL - ALL GLOBAL VARIABLES CLEARED');
    console.log('✅ System is now in FRESH STATE - ready for new user login');
    console.log('=== COMPLETE SYSTEM FLUSH COMPLETED ===');
    
    return {
      success: true,
      flushed: beforeCounts,
      verified_empty: afterCounts,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('❌ Error during complete system flush:', error);
    throw error;
  }
};

// Get current session count for UI
router.get('/sessioncount', async (req, res) => {
  const user_id = getCurrentUserId();
  
  if (!user_id) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated. Please login first.'
    });
  }
  
  try {
    // Get current session count from global variables
    const userSessions = globalSessionNames.filter(session => session.user_id === user_id);
    const sessionCount = userSessions.length;
    
    console.log('📊 Session count requested for user:', user_id, '=', sessionCount);
    
    res.json({
      success: true,
      session_count: sessionCount,
      user_id: user_id,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting session count:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get session count',
      details: error.message
    });
  }
});

// Get next chat ID endpoint - now requires session_id
router.post('/nextchatid', async (req, res) => {
  //console.log('🎯 /nextchatid POST endpoint HIT!');
  
  const { session_id } = req.body;
  
  // Always use the stored user ID from login - no fallbacks
  const user_id = getCurrentUserId();
  
  if (!user_id) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated. Please login first.'
    });
  }

  //console.log('🔄 Getting next chat ID for user:', user_id, 'session:', session_id);

  if (!session_id) {
    return res.status(400).json({
      success: false,
      error: 'session_id is required'
    });
  }

  try {
    // Generate incremental chat ID for this specific session
    const chatId = await getNextChatId(user_id, session_id);
    //console.log('🆔 Generated new chat ID:', chatId, 'for user:', user_id, 'session:', session_id);

    res.json({
      success: true,
      chat_id: chatId,
      user_id: user_id,
      session_id: session_id
    });

  } catch (error) {
    console.error('❌ Error getting next chat ID:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get next chat ID',
      details: error.message
    });
  }
});

// SOCKET.IO STREAMING CREDENTIALS ENDPOINT FOR FOREIGN SERVER
router.post('/socket-credentials', async (req, res) => {
  //console.log('🔌 Socket credentials endpoint hit for foreign server');
  
  const { user_id, session_id, chat_id, room_id } = req.body;
  
  // Always use the stored user ID from login, or fallback to user_id from request body
  const finalUserId = user_id || getCurrentUserId();
  
  if (!finalUserId) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated. Please login first.'
    });
  }
  
  try {
    // Generate or validate room_id (typically: chat_${user_id}_${session_id}_${chat_id})
    const finalRoomId = room_id || `chat_${finalUserId}_${session_id}_${chat_id}`;
    
    // Prepare Socket.IO streaming credentials for foreign server
    const socketCredentials = {
      success: true,
      socketio_config: {
        // Socket.IO server connection details
        server_url: `http:// 10.66.10.103:3000`, // Using default port from .env
        namespace: '/', // Default namespace
        room_id: finalRoomId,
        
        // Connection options
        connection_options: {
          transports: ['websocket', 'polling'],
          timeout: 30000,
          reconnection: true,
          reconnectionDelay: 1000,
          reconnectionAttempts: 5
        },
        
        // Authentication (if needed)
        auth: {
          token: req.headers.authorization || '',
          user_id: finalUserId
        },
        
        // Event names to use
        events: {
          join_room: 'join-chat-room',
          stream_token: 'chat-stream',
          completion: 'chat-stream'
        },
        
        // Room join payload
        room_join_payload: {
          roomId: finalRoomId,
          userId: finalUserId,
          sessionId: session_id,
          chatId: chat_id
        },
        
        // Token streaming format
        token_message_format: {
          type: 'token',
          content: '{{TOKEN_TEXT}}', // Replace with actual token
          chat_id: chat_id,
          session_id: session_id,
          token_number: '{{TOKEN_COUNT}}', // Replace with token number
          timestamp: '{{TIMESTAMP}}' // Replace with timestamp
        },
        
        // Completion message format
        completion_message_format: {
          type: 'complete',
          content: 'Stream completed',
          chat_id: chat_id,
          session_id: session_id,
          timestamp: '{{TIMESTAMP}}'
        }
      },
      
      // Instructions for foreign server
      instructions: {
        step1: "Connect to Socket.IO server using the server_url and connection_options",
        step2: "After connection, emit 'join-chat-room' event with room_join_payload",
        step3: "For each token, emit 'chat-stream' event to room_id with token_message_format",
        step4: "When LLM completes, emit 'chat-stream' event to room_id with completion_message_format",
        step5: "Disconnect from Socket.IO server"
      },
      
      // Example Python code for foreign server
      python_example: `
import socketio
import time

# Create Socket.IO client
sio = socketio.Client()

@sio.event
def connect():
    print('Connected to AIPB Backend Socket.IO server')
    # Join the chat room
    sio.emit('join-chat-room', ${JSON.stringify({
      roomId: finalRoomId,
      userId: finalUserId,
      sessionId: session_id,
      chatId: chat_id
    }, null, 8)})

@sio.event
def disconnect():
    print('Disconnected from AIPB Backend Socket.IO server')

# Connect to server
sio.connect('http:// 10.66.10.103:3000')

# Stream tokens (example)
tokens = ['Hello', ' world', '!']
for i, token in enumerate(tokens, 1):
    sio.emit('chat-stream', {
        'type': 'token',
        'content': token,
        'chat_id': '${chat_id}',
        'session_id': '${session_id}',
        'token_number': i,
        'timestamp': time.time()
    }, room='${finalRoomId}')
    time.sleep(0.1)  # Small delay between tokens

# Send completion
sio.emit('chat-stream', {
    'type': 'complete',
    'content': 'Stream completed',
    'chat_id': '${chat_id}',
    'session_id': '${session_id}',
    'timestamp': time.time()
}, room='${finalRoomId}')

# Disconnect
sio.disconnect()
`
    };
    
    console.log('✅ Socket.IO credentials generated for room:', finalRoomId);
    res.json(socketCredentials);
    
  } catch (error) {
    console.error('❌ Error generating socket credentials:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate socket credentials',
      details: error.message
    });
  }
});

// DEBUG ENDPOINT: View Global Variables
router.get('/debug/global-data', (req, res) => {
  console.log('🔍 Debug endpoint hit - returning global data');
  
  res.json({
    success: true,
    globalSessionNames: {
      count: globalSessionNames.length,
      sessions: globalSessionNames.map(session => ({
        session_id: session.session_id,
        title: session.title,
        user_id: session.user_id,
        current_chat_id: session.current_chat_id,
        total_chats: session.total_chats,
        created_at: session.created_at,
        updated_at: session.updated_at
      }))
    },
    globalChatHistory: {
      sessionCount: Object.keys(globalChatHistory).length,
      sessions: Object.keys(globalChatHistory).map(key => ({
        key,
        messageCount: globalChatHistory[key].length,
        chatIds: [...new Set(globalChatHistory[key].map(msg => msg.chat_id).filter(id => id))], // Unique chat_ids in this session
        firstMessage: {
          role: globalChatHistory[key][0]?.role,
          chat_id: globalChatHistory[key][0]?.chat_id,
          session_id: globalChatHistory[key][0]?.session_id,
          message_type: globalChatHistory[key][0]?.message_type,
          timestamp: globalChatHistory[key][0]?.timestamp
        },
        lastMessage: {
          role: globalChatHistory[key][globalChatHistory[key].length - 1]?.role,
          chat_id: globalChatHistory[key][globalChatHistory[key].length - 1]?.chat_id,
          session_id: globalChatHistory[key][globalChatHistory[key].length - 1]?.session_id,
          message_type: globalChatHistory[key][globalChatHistory[key].length - 1]?.message_type,
          timestamp: globalChatHistory[key][globalChatHistory[key].length - 1]?.timestamp
        }
      }))
    },
    timestamp: new Date().toISOString()
  });
});

// DEBUG ENDPOINT: Test global variable cleanup
router.post('/debug/test-cleanup', async (req, res) => {
  const { user_id } = req.body;
  console.log('🧪 DEBUG: Testing cleanup for user:', user_id);
  
  console.log('📊 BEFORE cleanup:');
  console.log('   globalSessionNames:', globalSessionNames.length, 'sessions');
  console.log('   globalChatHistory:', Object.keys(globalChatHistory).length, 'keys');
  
  try {
    const result = await clearUserSessionData(user_id);
    
    console.log('📊 AFTER cleanup:');
    console.log('   globalSessionNames:', globalSessionNames.length, 'sessions');
    console.log('   globalChatHistory:', Object.keys(globalChatHistory).length, 'keys');
    
    res.json({
      success: true,
      result,
      afterCleanup: {
        globalSessionNames: globalSessionNames.length,
        globalChatHistory: Object.keys(globalChatHistory).length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// STOP GENERATION ENDPOINT
router.post('/stop', async (req, res) => {
  try {
    const { user_id, session_id, chat_id, instance_id } = req.body; // 🆕 CRITICAL: Extract instance_id
    
    // Use stored user ID from login instead of JWT extraction
    const finalUserId = user_id || getCurrentUserId();
    
    console.log('🛑 Stop generation request received for user:', finalUserId, 'session:', session_id, 'chat:', chat_id, 'instance:', instance_id);
    console.log('🔑 Authorization header received:', req.headers.authorization ? 'YES' : 'NO');
    if (req.headers.authorization) {
      console.log('🔑 Token preview:', req.headers.authorization.substring(0, 20) + '...');
    }
    
    // Call foreign server stop endpoint with both user_id and session_id
    try {
      const stopUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/stop`;
      console.log('📡 Calling foreign server stop endpoint:', stopUrl);
      
      // Setup AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 100000); // 100 second timeout for stop calls (foreign server can be slow)
      
      const response = await fetch(stopUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers.authorization || '' // Add Authorization header
        },
        body: JSON.stringify({
          user_id: finalUserId,
          session_id: session_id || ""  // Foreign server expects both user_id and session_id
        }),
        agent: httpsAgent,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Foreign server stop successful:', data);
        
        // 🆕 COMPLETE STOP CLEANUP after foreign server confirms stop
        if (session_id) {
          // 🆕 CRITICAL FIX: Include instance_id in room targeting to differentiate old vs new chats
          const roomId = instance_id 
            ? `chat_${finalUserId}_${session_id}_${chat_id}_${instance_id}` // Specific chat instance room
            : (chat_id 
              ? `chat_${finalUserId}_${session_id}_${chat_id}` // Fallback to chat room (backward compatibility)
              : `chat_${finalUserId}_${session_id}`); // Fallback to session room
          
          console.log('🧹 Starting complete stop cleanup for room:', roomId, '(targeted instance:', instance_id || 'all', 'chat:', chat_id || 'all', ')');
          
          // 1. CRITICAL: Cleanup RabbitMQ consumer first (prevents message conflicts)
          console.log('🛑 STOP: Cleaning up RabbitMQ consumer for session:', session_id, 'chat:', chat_id, 'instance:', instance_id);
          const consumerCleaned = await forceCleanupConsumerForSession(finalUserId, session_id, chat_id);
          console.log(`✅ STOP: Consumer cleanup ${consumerCleaned ? 'successful' : 'not needed'}`);
          
          // 2. Send completion signal to frontend (like natural completion)
          console.log('📤 STOP: Sending completion signal to frontend');
          io.to(roomId).emit('chat-stream', {
            type: 'complete',
            content: 'Generation stopped by user',
            session_id: session_id,
            chat_id: chat_id,
            instance_id: instance_id, // 🆕 Include instance_id so frontend knows which chat was stopped
            completion_type: 'user_stopped',
            total_tokens: 0,
            timestamp: new Date().toISOString()
          });
          
          // 3. Send socket cleanup signal (frontend will clean up timeouts/intervals)
          console.log('🧹 STOP: Sending socket cleanup signal');
          io.to(roomId).emit('cleanup-generation', {
            userId: finalUserId,
            sessionId: session_id,
            chatId: chat_id,
            instanceId: instance_id, // 🆕 Include instance_id for targeted cleanup
            reason: 'stop_requested'
          });
          
          // 🔧 FIX: DON'T force-leave-room! Let socket stay to receive late messages
          // The frontend will ignore them based on instance_id matching
          console.log('✅ STOP: Cleanup complete - socket remains in room to handle late responses');
          
          console.log('✅ STOP: Complete cleanup finished - ready for fresh chat');
        }
        
        // Handle foreign server response format: { status: "success"/"info", message: "..." }
        res.json({
          success: true,
          status: data.status || 'success',
          message: data.message || 'Generation stopped successfully',
          foreign_response: data,
          cleanup_completed: true  // 🆕 NEW: Indicate cleanup was done
        });
      } else {
        console.error('❌ Foreign server stop failed with status:', response.status);
        res.status(500).json({
          success: false,
          error: 'Failed to stop generation on foreign server',
          status: response.status
        });
      }
    } catch (error) {
      console.error('❌ Error calling foreign server stop endpoint:', error);
      
      // 🆕 CRITICAL FIX: Even if foreign server times out, cleanup locally!
      console.log('⚠️ Foreign server timeout - performing LOCAL cleanup anyway');
      
      if (session_id) {
        const roomId = instance_id 
          ? `chat_${finalUserId}_${session_id}_${chat_id}_${instance_id}`
          : (chat_id 
            ? `chat_${finalUserId}_${session_id}_${chat_id}`
            : `chat_${finalUserId}_${session_id}`);
        
        console.log('🧹 FALLBACK: Cleaning up local resources for room:', roomId);
        
        // 1. Cleanup RabbitMQ consumer locally
        console.log('🛑 FALLBACK: Cleaning up RabbitMQ consumer');
        try {
          await forceCleanupConsumerForSession(finalUserId, session_id, chat_id);
          console.log('✅ FALLBACK: Consumer cleanup successful');
        } catch (cleanupError) {
          console.error('❌ FALLBACK: Consumer cleanup failed:', cleanupError);
        }
        
        // 2. Send completion signal to frontend anyway
        console.log('📤 FALLBACK: Sending completion signal to frontend');
        io.to(roomId).emit('chat-stream', {
          type: 'complete',
          content: 'Generation stopped (server timeout)',
          session_id: session_id,
          chat_id: chat_id,
          instance_id: instance_id,
          completion_type: 'timeout_stopped',
          total_tokens: 0,
          timestamp: new Date().toISOString()
        });
        
        // 3. Send cleanup signal
        console.log('🧹 FALLBACK: Sending socket cleanup signal');
        io.to(roomId).emit('cleanup-generation', {
          userId: finalUserId,
          sessionId: session_id,
          chatId: chat_id,
          instanceId: instance_id,
          reason: 'stop_timeout'
        });
        
        console.log('✅ FALLBACK: Local cleanup complete despite foreign server timeout');
      }
      
      // Return success to frontend (local cleanup succeeded even if foreign server timed out)
      res.json({
        success: true,
        status: 'timeout_cleanup',
        message: 'Foreign server timed out, but local cleanup completed',
        cleanup_completed: true,
        warning: 'Foreign server stop endpoint timed out'
      });
      
      return; // Exit early after fallback cleanup
    }
    
  } catch (error) {
    console.error('❌ Stop generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// MODEL LIST ENDPOINT - Fetch once and cache
router.get('/modelList', async (req, res) => {
  try {
    console.log('📋 Model list endpoint hit - checking cache...');

    // Always fetch from foreign server to check for updates, but compare with cache
    console.log('� Fetching fresh model data from foreign server to compare with cache...');
    
    try {
      const modelListUrl = `${FOREIGN_SERVER_CONFIG.baseUrl}/model_list`;
      console.log('📡 Calling foreign server:', modelListUrl);
      
      // Setup AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 10000); // 10 second timeout for model list calls
      
      const response = await fetch(modelListUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        },
        agent: httpsAgent,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        console.log('✅ Foreign server model list response:', data);
        
        // Extract models from various possible structures
        let modelsArray = null;
        
        if (data.model_list && Array.isArray(data.model_list)) {
          // Format: { model_list: [...], response: 'success' }
          modelsArray = data.model_list;
          console.log('📋 Found models in data.model_list (direct array)');
        } else if (data.model_list && data.model_list.Models && Array.isArray(data.model_list.Models)) {
          // Format: { model_list: { Models: [...] } }
          modelsArray = data.model_list.Models;
          console.log('📋 Found models in data.model_list.Models');
        } else if (data.models && Array.isArray(data.models)) {
          // Format: { models: [...] }
          modelsArray = data.models;
          console.log('📋 Found models in data.models');
        } else if (Array.isArray(data)) {
          // Format: direct array [...]
          modelsArray = data;
          console.log('📋 Found models as direct array');
        }
        
        console.log('🔍 Detected format - modelsArray length:', modelsArray?.length);
        
        if (modelsArray && Array.isArray(modelsArray)) {
          // Transform fresh data to compare format
          const freshModelList = modelsArray.map(model => ({
            id: model.id || model.model_id,
            name: model.name || model.model_name || model.display_name,
            description: model.description || model.desc || 'No description available'
          }));
          
          // Compare with existing cache
          let shouldUpdateCache = false;
          let cacheStatus = 'unchanged';
          
          if (globalModelList.length === 0) {
            // No cache exists
            shouldUpdateCache = true;
            cacheStatus = 'first_fetch';
            console.log('📊 Cache status: First time fetching models');
          } else if (freshModelList.length !== globalModelList.length) {
            // Different number of models
            shouldUpdateCache = true;
            cacheStatus = 'count_changed';
            console.log('� Cache status: Model count changed -', globalModelList.length, '→', freshModelList.length);
          } else {
            // Compare model details (names, descriptions, etc.)
            const hasChanges = freshModelList.some((freshModel, index) => {
              const cachedModel = globalModelList[index];
              const changed = !cachedModel || 
                freshModel.id !== cachedModel.id ||
                freshModel.name !== cachedModel.name ||
                freshModel.description !== cachedModel.description;
              
              if (changed && cachedModel) {
                console.log('🔄 Model change detected:');
                console.log('   Old:', JSON.stringify(cachedModel));
                console.log('   New:', JSON.stringify(freshModel));
              }
              
              return changed;
            });
            
            if (hasChanges) {
              shouldUpdateCache = true;
              cacheStatus = 'data_changed';
              console.log('� Cache status: Model data has changed');
            } else {
              console.log('📊 Cache status: No changes detected - using existing cache');
            }
          }
          
          if (shouldUpdateCache) {
            // Update cache with fresh data
            globalModelList = freshModelList;
            modelListCacheTimestamp = Date.now();
            
            console.log('💾 Cache updated with', freshModelList.length, 'models');
            console.log('🔄 Update reason:', cacheStatus);
            console.log('📋 Model list sample:', freshModelList.slice(0, 2));
            
            return res.json({
              success: true,
              models: globalModelList,
              total: globalModelList.length,
              cached: false,
              cache_status: cacheStatus,
              cache_timestamp: modelListCacheTimestamp,
              updated: true
            });
          } else {
            // Return existing cache (no changes)
            console.log('⚡ Using existing cache - no changes detected');
            return res.json({
              success: true,
              models: globalModelList,
              total: globalModelList.length,
              cached: true,
              cache_status: 'unchanged',
              cache_timestamp: modelListCacheTimestamp,
              updated: false
            });
          }
        } else {
          console.warn('⚠️ Invalid model list format from foreign server');
          console.warn('🔍 Expected formats:');
          console.warn('   - { model_list: [...] } (direct array)');
          console.warn('   - { model_list: { Models: [...] } } (nested)');
          console.warn('   - { models: [...] } (alternative)');
          console.warn('   - [...] (direct array)');
          console.warn('🔍 Received structure:', Object.keys(data));
          console.warn('🔍 model_list type:', typeof data.model_list, Array.isArray(data.model_list) ? '(array)' : '(not array)');
          return res.status(500).json({
            success: false,
            error: 'Invalid model list format from foreign server'
          });
        }
      } else {
        console.error('❌ Foreign server model list failed with status:', response.status);
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch model list from foreign server',
          status: response.status
        });
      }
    } catch (error) {
      console.error('❌ Error calling foreign server model list:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to communicate with foreign server',
        details: error.message
      });
    }
    
  } catch (error) {
    console.error('❌ Model list endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

export { globalSessionNames, globalChatHistory, setForeignLastSessionId, setCurrentUserId, getCurrentUserId, flushAllGlobalVariables, setPersonalizedFiles, getPersonalizedFiles, addPersonalizedFile, removePersonalizedFile, MODEL_TYPES };
export default router;