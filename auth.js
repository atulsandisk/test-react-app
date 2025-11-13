import express from 'express';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { Buffer } from 'buffer';
import process from 'process';
import { exec } from 'child_process';
import { promisify } from 'util';
import { setForeignLastSessionId, setCurrentUserId, setPersonalizedFiles } from './chat.js';
import nfsManager from './nfsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

// Promisify exec for async/await usage
const execAsync = promisify(exec);

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Load CA certificate for HTTPS requests
let httpsAgent;
try {
  // Use absolute path to ensure CA cert is found regardless of working directory
  const caCertPath = path.join(__dirname, 'ca-certificate.pem');
  const caCert = fs.readFileSync(caCertPath);
  console.log('CA certificate loaded successfully from', caCertPath);
  httpsAgent = new https.Agent({
    ca: caCert,
    rejectUnauthorized: true // Keep true for security
  });
} catch (error) {
  console.warn('CA certificate not found, using fallback SSL configuration:', error.message);
  // Fallback: disable SSL verification (NOT recommended for production)
  httpsAgent = new https.Agent({
    rejectUnauthorized: false
  });
}

export { httpsAgent };

// Utility to decode JWT and extract user info (without verification for user ID extraction)
export function extractUserIdFromToken(token) {
  try {
    if (!token) return null;
    
    // Remove 'Bearer ' prefix if present
    const cleanToken = token.startsWith('Bearer ') ? token.substring(7) : token;
    
    // Decode JWT payload (base64 decode the middle part)
    const parts = cleanToken.split('.');
    if (parts.length !== 3) return null;
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    console.log('🔍 JWT payload:', payload);
    
    // Extract user ID - check user_id first, then user_name, then fallback to email extraction
    if (payload.user_id) {
      return payload.user_id;
    }
    
    if (payload.user_name) {
      return payload.user_name;
    }
  
    
    return null;
  } catch (error) {
    console.error('Error extracting user ID from JWT:', error);
    return null;
  }
}

// Middleware to extract user ID from authorization header or stored user ID
export function extractUserFromRequest(req) {
  // Check if we have a stored user ID from login (via getCurrentUserId)
  // We'll keep JWT extraction as primary method for now to avoid circular imports
  
  // Extract from JWT token
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const userId = extractUserIdFromToken(authHeader);
    if (userId) {
      console.log('✅ Extracted user ID from JWT:', userId);
      return userId;
    }
  }
  
  // Fallback to user_id in request body
  if (req.body.user_id && req.body.user_id !== 'default_user') {
    console.log('✅ Using user ID from request body:', req.body.user_id);
    return req.body.user_id;
  }
  
  console.log('⚠️ No valid user ID found');
  return null;
}

//const JWT_SECRET = jwt; // Change to env var in production

router.post('/register', async (req, res) => {
  console.log('Register request received:', req.body);
  
  try {
    // Extract username from request
    const { user_name } = req.body;
    
    if (!user_name) {
      return res.status(400).json({ error: 'Username is required for registration' });
    }
    
    // First, try to register with the foreign server
    const response = await fetch('https://192.168.7.22:5000/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      agent: httpsAgent // Use the custom HTTPS agent
    });
    
    console.log('Foreign server response status:', response.status);
    
    const text = await response.text();
    console.log('Foreign server response text:', text);
    
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.error('Failed to parse JSON from foreign server:', e);
      result = { error: 'Invalid JSON from foreign server', details: text };
    }
    
    // Registration successful - NFS will be mounted on login, not signup
    if (response.status === 200 || response.status === 201) {
      console.log(`✅ User '${user_name}' registered successfully. NFS will be mounted on first login.`);
      result.registration_complete = true;
    }
    
    res.status(response.status).json(result);
  } catch (error) {
    console.error('Register proxy error:', error);
    res.status(500).json({ error: 'Register proxy failed', details: error.message });
  }
});




router.post('/login', async (req, res) => {
  console.log('=== 🔑 Login request received ===');
  
  const { user_name, password } = req.body;
  if (!user_name || !password) {
    console.log('❌ Missing username or password');
    return res.status(400).json({ error: 'Username and password required.' });
  }

  try {
    // 🔧 STEP 0: Ensure device is unmounted before fresh login
    console.log('🔧 Running unmount command before login to ensure clean state...');
    try {
      await execAsync('umount X:');
      console.log('✅ Unmount command completed successfully');
    } catch (unmountError) {
      // Don't fail login if unmount fails - device might not be mounted
      console.log('ℹ️ Unmount command result:', unmountError.message);
      console.log('📝 This is normal if device was not previously mounted');
    }
    // 🚀 IMMEDIATE NFS MOUNTING - Start mounting as soon as sign-in is initiated
    console.log(`🚀 Starting immediate NFS mount for user: ${user_name}`);
    const nfsMountPromise = (async () => {
      try {
        console.log(`📁 Initializing NFS for user: ${user_name}`);
        const startTime = Date.now();
        const currentRoot = await nfsManager.initializeNFSForUser(user_name);
        const mountTime = Date.now() - startTime;
        console.log(`✅ NFS mount completed for user '${user_name}' in ${mountTime}ms`);
        console.log(`📁 NFS filesystem root: ${currentRoot}`);
        console.log(`📁 User directory: ${nfsManager.getStatus().userPath || 'Not set'}`);
        return { success: true, currentRoot, mountTime };
      } catch (nfsError) {
        console.error(`❌ NFS mount failed for user '${user_name}':`, nfsError.message);
        console.error(`🔍 NFS Error details:`, nfsError);
        return { success: false, error: nfsError.message };
      }
    })();

    // Step 2: Proceed with login to foreign server (in parallel with NFS mounting)
    console.log('🔍 Original request body received from frontend:', req.body);
    
    let foreignServerBody = req.body;
    console.log('🌐 Attempting login with user_name format:', foreignServerBody);

    const response = await fetch('https://192.168.7.22:5000/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(foreignServerBody),
      agent: httpsAgent
    });
    
    console.log('Foreign server response status:', response.status);
    
    const text = await response.text();
    console.log('Foreign server response text:', text);
    
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.error('Failed to parse JSON from foreign server:', e);
      result = { error: 'Invalid JSON from foreign server', details: text };
    }
    
    // If login was successful, wait for NFS mounting to complete and finalize session
    if (response.status === 200 && result.message === 'Login successful') {
      // Extract BOTH token and user_id from foreign server response
      const token = result.token;
      const userId = result.user_id;
      
      console.log('🔢 Processing session management for successful login');
      console.log('🎫 Token from foreign server:', token ? 'Present' : 'Missing');
      console.log('🆔 User ID from foreign server:', userId);
      
      // Wait for NFS mounting to complete (should be fast due to parallel execution)
      console.log('⏳ Waiting for NFS mount to complete...');
      const nfsResult = await nfsMountPromise;
      if (nfsResult.success) {
        console.log(`✅ NFS mount successful in ${nfsResult.mountTime}ms: ${nfsResult.currentRoot}`);
       // console.log(`📁 Final NFS status:`, nfsManager.getStatus());
      } else {
        console.error(`❌ NFS mount failed: ${nfsResult.error}`);
        console.warn(`⚠️ Login will proceed but filesystem access may be limited`);
        // Return error if NFS mount is critical
        return res.status(500).json({ 
          error: 'NFS mount failed', 
          details: nfsResult.error,
          message: 'Filesystem access unavailable' 
        });
      }
      
      if (!userId) {
        console.error('❌ No user_id found in foreign server response!');
        console.log('📋 Available fields in response:', Object.keys(result));
      }
      
      if (!token) {
        console.error('❌ No token found in foreign server response!');
        console.log('📋 Available fields in response:', Object.keys(result));
      }
      
      // Store the current user ID for use throughout the application
      setCurrentUserId(userId);
      
      // Extract and store personalized files from foreign server response
      if (result.personalized_files && Array.isArray(result.personalized_files)) {
        console.log('📂 Extracting personalized files from login response:', result.personalized_files);
        setPersonalizedFiles(userId, result.personalized_files);
      } else {
        console.log('📂 No personalized files found in login response');
        setPersonalizedFiles(userId, []); // Initialize with empty array
      }
      
      // Add token and user_id to the response for frontend to store
      result.token = token;
      result.user_id = userId;
      
      // Get the foreign server's session ID (this is the last/highest session ID)
      const foreignSessionId = result.session_id|| 0;
      console.log('🌐 Foreign server session ID:', foreignSessionId);
      
      // 🎯 NEW APPROACH: Treat session_id as LAST session ID
      // Foreign server now sends the last/highest session ID in their DB
      const foreignLastSessionId = foreignSessionId.toString();
      console.log('🆔 Foreign server LAST session ID:', foreignLastSessionId);
      
      // Store foreign LAST session ID for local session ID generation
      // Local sessions will start from foreignLastSessionId + 1
      setForeignLastSessionId(userId, foreignLastSessionId);
      
      // Get local session count from our globalSessionNames array
      let localSessionCount = 0;
      try {
        const { globalSessionNames } = await import('./chat.js');
        localSessionCount = userId ? globalSessionNames.filter(session => session.user_id === userId).length : 0;
        console.log('📊 Local session count for user', userId, ':', localSessionCount);
      } catch (importError) {
        console.warn('⚠️ Could not import chat.js for session count:', importError.message);
      }
      
      // 🎯 IMPORTANT: Next local session will be foreignLastSessionId + 1
      const nextLocalSessionId = parseInt(foreignLastSessionId) + 1;
      console.log('🆔 Next local session will start from ID:', nextLocalSessionId);
      
      // Return both for frontend information - maintain backward compatibility
      result.session_count = foreignSessionId; // Keep for backward compatibility
      result.last_session_id = foreignLastSessionId;
      result.next_session_id = nextLocalSessionId.toString();
      result.local_session_count = localSessionCount;
      
      console.log('📊 Final session info - Foreign Last ID:', foreignLastSessionId, 'Next Local ID:', nextLocalSessionId, 'Local Count:', localSessionCount);
    }
    
    res.status(response.status).json(result);
  } catch (error) {
    console.error('Login proxy error:', error);
    res.status(500).json({ error: 'Login proxy failed', details: error.message });
  }
});


router.get('/protected', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided.' });
  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid token.' });
    res.json({ message: 'This is protected.', user: decoded });
  });
});

// Logout endpoint - handles both auth and chat cleanup
router.post('/logout', async (req, res) => {
  console.log('🚪 /logout endpoint hit - clearing user session data');
  console.log('🔍 Request body:', req.body);
  console.log('🔍 Authorization header:', req.headers.authorization);
  
  let { user_id } = req.body;

  // Extract user ID from JWT token if not provided
  const jwtUserId = extractUserFromRequest(req);
  console.log('🔍 JWT extracted user ID:', jwtUserId);
  
  if (!user_id || user_id === 'default_user') {
    user_id = jwtUserId || 'default_user';
    console.log('🔄 Logout using extracted user ID:', user_id);
  }
  
  console.log('🎯 FINAL user_id for logout:', user_id);

  try {
    // Step 1: Call foreign server logout (if endpoint exists)
    let foreignLogoutResult = null;
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
      
      if (token) {
        console.log('🌐 Calling foreign server logout...');
        const response = await fetch('https://192.168.7.22:5000/logout', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ user_id }),
          agent: httpsAgent
        });
        
        const text = await response.text();
        console.log('🌐 Foreign server logout response:', response.status, text);
        
        try {
          foreignLogoutResult = JSON.parse(text);
        } catch (parseError) {
          console.warn('⚠️ Could not parse foreign server logout response:', parseError.message);
          foreignLogoutResult = { status: response.status, response: text };
        }
      }
    } catch (foreignError) {
      console.warn('⚠️ Foreign server logout failed (continuing with local cleanup):', foreignError.message);
      foreignLogoutResult = { error: foreignError.message };
    }

    // Step 2: Clean up temporary files
    console.log('🧹 Cleaning up temporary files...');
    let tempCleanupResult = null;
    try {
      const { cleanupTempFiles } = await import('./filesystem.js');
      await cleanupTempFiles();
      tempCleanupResult = { success: true, message: 'Temporary files cleaned up successfully' };
      console.log('✅ Temporary files cleaned up during logout');
    } catch (tempError) {
      console.warn('⚠️ Failed to cleanup temp files during logout:', tempError.message);
      tempCleanupResult = { success: false, error: tempError.message };
    }

    // Step 3: COMPLETE SYSTEM FLUSH (clear ALL global variables - not just current user)
    console.log('🧨 PERFORMING COMPLETE SYSTEM FLUSH - clearing ALL global variables');
    const { flushAllGlobalVariables } = await import('./chat.js');
    const flushResult = await flushAllGlobalVariables();

    // Step 4: Unmount NFS - wait for completion to ensure proper cleanup
    console.log('🔄 Starting NFS unmount...');
    let nfsUnmountResult = null;
    try {
      await nfsManager.gracefulShutdown();
      nfsUnmountResult = { success: true, message: 'NFS unmounted successfully' };
      console.log('✅ NFS unmounted successfully');
    } catch (nfsError) {
      console.error('❌ NFS unmounting failed:', nfsError.message);
      nfsUnmountResult = { success: false, error: nfsError.message };
      // Don't fail the logout if NFS unmount fails - just log it
    }

    console.log('✅ LOGOUT COMPLETE: Complete system flush performed - ALL global variables cleared');

    res.json({
      success: true,
      message: 'Logout successful - COMPLETE system flush performed',
      user_id: user_id,
      flushed: flushResult.flushed,
      verified_empty: flushResult.verified_empty,
      temp_cleanup: tempCleanupResult,
      nfs_unmount: nfsUnmountResult,
      foreign_logout: foreignLogoutResult,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error during logout:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to logout user',
      details: error.message
    });
  }
});

// NFS status endpoint for frontend to check mount progress
router.get('/nfs-status', (req, res) => {
  try {
    const status = nfsManager.getStatus();
    res.json({
      success: true,
      nfs_status: status,
      is_ready: status.isNFSMounted && status.isNFSAvailable
    });
  } catch (error) {
    console.error('Error getting NFS status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get NFS status',
      details: error.message
    });
  }
});

export default router;

// Note: Don't apply authenticateToken to auth routes (login/register)
// Apply to other routes that need authentication
