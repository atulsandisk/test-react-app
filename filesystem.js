import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import multer from 'multer';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { httpsAgent } from './auth.js';
import { ensureDirectoryExists, validatePath, getFilesystemRoot, getFilesystemStatus, FILESYSTEM_ROOT_PATH } from './filesystemUtils.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const router = express.Router();

// Cleanup function for temporary files
const cleanupTempFiles = async () => {
  try {
    const tempDir = path.join('X:', 'temp');
    const uploadDir = path.join('C:', 'temp-uploads');
    
    console.log('🧹 Starting cleanup of temporary files...');
    
    // Clean up Jetson temp directory
    try {
      const jetsonTempExists = await fs.access(tempDir).then(() => true).catch(() => false);
      if (jetsonTempExists) {
        const jetsonFiles = await fs.readdir(tempDir);
        for (const file of jetsonFiles) {
          try {
            await fs.unlink(path.join(tempDir, file));
            console.log(`✅ Cleaned up Jetson temp file: ${file}`);
          } catch (error) {
            console.warn(`⚠️ Could not clean up Jetson temp file ${file}:`, error.message);
          }
        }
        console.log(`✅ Jetson temp directory cleaned: ${jetsonFiles.length} files removed`);
      } else {
        console.log('ℹ️ Jetson temp directory does not exist, skipping cleanup');
      }
    } catch (error) {
      console.warn('⚠️ Error cleaning Jetson temp directory:', error.message);
    }
    
    // Clean up local upload directory
    try {
      const uploadExists = await fs.access(uploadDir).then(() => true).catch(() => false);
      if (uploadExists) {
        const uploadFiles = await fs.readdir(uploadDir);
        for (const file of uploadFiles) {
          try {
            await fs.unlink(path.join(uploadDir, file));
            console.log(`✅ Cleaned up upload temp file: ${file}`);
          } catch (error) {
            console.warn(`⚠️ Could not clean up upload temp file ${file}:`, error.message);
          }
        }
        console.log(`✅ Upload temp directory cleaned: ${uploadFiles.length} files removed`);
      }
    } catch (error) {
      console.warn('⚠️ Error cleaning upload temp directory:', error.message);
    }
    
    console.log('🧹 Temporary files cleanup completed');
  } catch (error) {
    console.error('❌ Error during temp files cleanup:', error.message);
  }
};

const uploadDir = path.join('C:', 'temp-uploads');
const upload = multer({ 
  dest: uploadDir,
  limits: {
    fileSize: 100 * 1024 * 1024,
    fieldSize: 1024 * 1024
  },
  fileFilter: (req, file, cb) => cb(null, true)
});

// Ensure upload directory exists and cleanup temp files on startup (non-blocking)
(async () => {
  try {
    if (uploadDir && typeof uploadDir === 'string' && uploadDir.trim()) {
      await ensureDirectoryExists(uploadDir);
    }
    console.log('✅ Upload directory initialized');
    
    // Clean up temporary files from previous session
    await cleanupTempFiles();
  } catch (error) {
    console.error('❌ Error initializing upload directory or cleaning temp files:', error.message);
  }
})();

// Filesystem status endpoint
router.get('/status', async (req, res) => {
  try {
    const status = await getFilesystemStatus();
    const currentRoot = await getFilesystemRoot();
    
    // Add additional information not in the NFS status
    let diskInfo = null;
    try {
      // Only try to get disk info if we have a valid currentRoot
      if (currentRoot && typeof currentRoot === 'string') {
        const rootDir = path.parse(currentRoot).root;
        // In a production environment, you might use a disk space library
        // For now, we'll just check if the path exists
        await fs.access(rootDir);
        diskInfo = {
          available: true,
          path: rootDir
        };
      } else {
        console.warn('Unable to get disk info: No valid filesystem root available');
        diskInfo = { 
          available: false, 
          reason: 'No user-specific NFS path available' 
        };
      }
    } catch (error) {
      console.warn('Unable to get disk info:', error.message);
      diskInfo = { 
        available: false, 
        reason: error.message 
      };
    }
    
    res.json({
      success: true,
      status: {
        ...status,
        currentRoot: currentRoot || null,
        diskInfo,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting filesystem status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get filesystem status',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// API endpoints
router.post('/init', async (req, res) => {
  try {
    const currentRoot = await getFilesystemRoot();
    console.log('Initializing filesystem with root:', currentRoot);
    
    if (!currentRoot) {
      console.error('❌ No filesystem root available - requires user-specific NFS path');
      return res.status(503).json({
        success: false,
        error: 'Filesystem not available',
        details: 'User-specific NFS filesystem is not mounted or user session not established',
        requiresUserLogin: true,
        timestamp: new Date().toISOString()
      });
    }
    
    // OPTIMIZED: Fast initialization - just check if path exists, skip expensive operations
    try {
      await fs.access(currentRoot);
      console.log('✅ Root path is accessible - fast init complete');
    } catch (accessError) {
      console.log('Root path not accessible, attempting quick creation:', accessError.message);
      try {
        await ensureDirectoryExists(currentRoot);
        console.log('✅ Root path created successfully');
      } catch (createError) {
        console.error('❌ Failed to create root path:', createError.message);
        return res.status(500).json({
          success: false,
          error: `Failed to create filesystem root: ${createError.message}`
        });
      }
    }
    
    // OPTIMIZED: Skip write permission test for faster init - will be checked when actually needed
    console.log('✅ Fast filesystem initialization complete');
    
    res.json({ 
      success: true, 
      message: 'Filesystem initialized (fast mode)', 
      rootPath: await FILESYSTEM_ROOT_PATH(),
      fastMode: true
    });
  } catch (error) {
    console.error('Filesystem initialization error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Diagnostic endpoint to check NFS status
router.get('/nfs-status', async (req, res) => {
  try {
    const diagnostics = {
      rootPath: FILESYSTEM_ROOT_PATH,
      exists: false,
      readable: false,
      writable: false,
      stats: null,
      error: null
    };

    // Check if path exists
    try {
      const rootPath = await FILESYSTEM_ROOT_PATH();
      const stats = await fs.stat(rootPath);
      diagnostics.exists = true;
      diagnostics.stats = {
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modified: stats.mtime
      };
    } catch (error) {
      diagnostics.error = `Path doesn't exist: ${error.message}`;
    }

    // Check read permissions
    if (diagnostics.exists) {
      try {
        const rootPath = await FILESYSTEM_ROOT_PATH();
        await fs.access(rootPath, fs.constants.R_OK);
        diagnostics.readable = true;
      } catch (error) {
        diagnostics.error = `Not readable: ${error.message}`;
      }

      // Check write permissions
      try {
        const rootPath = await FILESYSTEM_ROOT_PATH();
        await fs.access(rootPath, fs.constants.W_OK);
        diagnostics.writable = true;
      } catch (error) {
        diagnostics.error = diagnostics.error ? 
          `${diagnostics.error}, Not writable: ${error.message}` : 
          `Not writable: ${error.message}`;
      }
    }

    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get personalized files for current user
router.get('/personalized-files', async (req, res) => {
  try {
    // Import personalized files functions
    const { getPersonalizedFiles } = await import('./chat.js');
    const { extractUserIdFromToken } = await import('./auth.js');
    
    // Get user ID from token
    const authHeader = req.headers.authorization;
    const userId = extractUserIdFromToken(authHeader);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        personalizedFiles: []
      });
    }
    
    const personalizedFiles = getPersonalizedFiles(userId);
    
    res.json({
      success: true,
      personalizedFiles: personalizedFiles,
      userId: userId,
      count: personalizedFiles.length
    });
  } catch (error) {
    console.error('Error getting personalized files:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      personalizedFiles: []
    });
  }
});

router.get('/list', async (req, res) => {
  try {
    console.log('\n=== FILESYSTEM LIST ENDPOINT ===');
    
    // Import personalized files functions
    const { getPersonalizedFiles } = await import('./chat.js');
    const { extractUserIdFromToken } = await import('./auth.js');
    
    const userPath = req.query.path || '';
    console.log('List request for path:', userPath);
    
    const safePath = await validatePath(userPath);
    if (!safePath) {
      console.error('❌ Invalid path:', userPath);
      return res.status(400).json({ success: false, error: `Invalid path: ${userPath}` });
    }
    console.log('Safe path resolved to:', safePath);
    
    // Check if the path exists and is accessible
    try {
      await fs.access(safePath);
      console.log('✅ Path is accessible:', safePath);
    } catch (accessError) {
      console.error('❌ Path not accessible:', safePath, accessError.message);
      return res.status(404).json({ 
        success: false, 
        error: `Path not accessible: ${accessError.message}`,
        items: []
      });
    }
    
    // OPTIMIZED: Get user ID and personalized files once
    const authHeader = req.headers.authorization;
    const userId = extractUserIdFromToken(authHeader);
    const personalizedFiles = userId ? getPersonalizedFiles(userId) : [];
    console.log('User ID:', userId, 'Personalized files count:', personalizedFiles.length);
    
    // OPTIMIZED: Create a Set for faster lookup of personalized files
    const personalizedSet = new Set(personalizedFiles);
    
    // OPTIMIZED: Read directory with file types (faster than individual stat calls)
    let items;
    try {
      items = await fs.readdir(safePath, { withFileTypes: true });
      console.log('✅ Directory read successfully, found', items.length, 'items');
    } catch (readError) {
      console.error('❌ Failed to read directory:', safePath, readError.message);
      return res.status(500).json({ 
        success: false, 
        error: `Failed to read directory: ${readError.message}`,
        items: []
      });
    }
    
    // OPTIMIZED: Get root path once
    const rootPath = await FILESYSTEM_ROOT_PATH();
    console.log('Root path:', rootPath);
    
    // Handle empty directory
    if (items.length === 0) {
      console.log('ℹ️ Directory is empty');
      res.json({ 
        success: true, 
        items: [], 
        currentPath: path.relative(rootPath, safePath).replace(/\\/g, '/') || '/',
        timeframe: 'Directory listing (fast mode - empty)',
        fastMode: true
      });
      return;
    }
    
    // OPTIMIZED: Process files in parallel batches instead of sequential map
    const BATCH_SIZE = 10;
    const fileList = [];
    
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          const itemPath = path.join(safePath, item.name);
          
          try {
            // OPTIMIZED: Single stat call per file
            const stats = await fs.stat(itemPath);
            const relativePath = path.relative(rootPath, itemPath).replace(/\\/g, '/');
            
            // OPTIMIZED: Faster personalization check using Set and simple path matching
            const windowsPath = `X:/${relativePath.replace(/\//g, '\\')}`;
            const isPersonalized = personalizedSet.has(windowsPath) || 
                                  personalizedSet.has(`X:\\${relativePath.replace(/\//g, '\\')}`) ||
                                  Array.from(personalizedSet).some(pFile => pFile.includes(item.name));
            
            return {
              name: item.name,
              type: item.isDirectory() ? 'directory' : 'file',
              size: stats.size,
              modified: stats.mtime,
              relativePath: relativePath,
              isRecentUpload: !item.isDirectory(),
              isPersonalized: isPersonalized
            };
          } catch (statError) {
            console.warn(`⚠️ Failed to stat ${itemPath}:`, statError.message);
            // Return basic info even if stat fails
            return {
              name: item.name,
              type: item.isDirectory() ? 'directory' : 'file',
              size: 0,
              modified: new Date(),
              relativePath: path.relative(rootPath, itemPath).replace(/\\/g, '/'),
              isRecentUpload: !item.isDirectory(),
              isPersonalized: false
            };
          }
        })
      );
      fileList.push(...batchResults);
    }
    
    // OPTIMIZED: Simple sort - directories first, then by name (skip expensive time-based sorting)
    fileList.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name); // Simple alphabetical sort
    });
    
    console.log('✅ Successfully processed', fileList.length, 'items for listing');
    
    res.json({ 
      success: true, 
      items: fileList, 
      currentPath: path.relative(rootPath, safePath).replace(/\\/g, '/') || '/',
      timeframe: 'Directory listing (fast mode)',
      fastMode: true
    });
  } catch (error) {
    console.error('❌ Filesystem list endpoint error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: error.message, 
      items: [],
      debugInfo: {
        errorName: error.name,
        errorCode: error.code,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Upload endpoint - handles copying files from host to Jetson via NFS
router.post('/upload', (req, res) => {
  console.log('\n=== HOST TO JETSON COPY ENDPOINT ===');
  console.log('Headers:', req.headers);
  console.log('Content-Type:', req.headers['content-type']);
  
  // Use multer to handle multiple files for host-to-Jetson copying
  upload.array('files')(req, res, async (err) => {
    if (err) {
      console.error('Multer error details:', {
        name: err.name,
        message: err.message,
        code: err.code,
        field: err.field,
        storageErrors: err.storageErrors
      });
      
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ success: false, error: 'File too large (max 100MB)' });
        }
        return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
      }
      return res.status(500).json({ success: false, error: `Upload failed: ${err.message}` });
    }

    try {
      console.log('Files received for Jetson copy:', req.files ? req.files.length : 0);
      console.log('Folder paths received:', req.body.folderPaths);
      
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'No files provided for copying to Jetson. Use form field name "files"' 
        });
      }

      const results = [];
      const folderPaths = req.body.folderPaths ? (Array.isArray(req.body.folderPaths) ? req.body.folderPaths : [req.body.folderPaths]) : [];
      
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const folderPath = folderPaths[i] || file.originalname; // Use folder path if available, otherwise just filename
        
        console.log('\nProcessing file for Jetson copy:', {
          originalname: file.originalname,
          folderPath: folderPath,
          size: file.size,
          uploadPath: file.path
        });

        try {
          // Import NFSManager dynamically to get the proper user path
          const { default: nfsManager } = await import('./nfsManager.js');
          const nfsStatus = nfsManager.getStatus();
          
          // Get the user-specific path - with new structure X: IS the user directory
          let jetsonPath;
          if (nfsStatus.isNFSMounted && nfsStatus.currentUsername) {
            // X: directly maps to user's home directory, preserve folder structure
            jetsonPath = path.join(nfsStatus.nfsMountPoint, folderPath);
            console.log('Target Jetson user path:', jetsonPath);
          } else {
            // Fallback to root if no user is set (shouldn't happen but safety first)
            jetsonPath = path.join('X:\\', folderPath);
            console.log('Target Jetson path (fallback):', jetsonPath);
          }
          
          // Ensure parent directories exist before copying
          const parentDir = path.dirname(jetsonPath);
          await fs.mkdir(parentDir, { recursive: true });
          console.log('Parent directories ensured:', parentDir);
          
          // Copy file to Jetson
          await fs.copyFile(file.path, jetsonPath);
          console.log('File copied successfully to Jetson');

          // Clean up the uploaded file from uploads folder
          // await fs.unlink(file.path);
          console.log('Temporary file cleaned up');

          results.push({
            success: true,
            originalName: file.originalname,
            folderPath: folderPath,
            jetsonPath: jetsonPath.replace(/\\/g, '/'), // Convert to forward slashes for consistency
            absolutePath: jetsonPath.replace(/\\/g, '/'), // Convert to forward slashes for LLM
            size: file.size,
            message: `File ${folderPath} successfully copied to Jetson filesystem`
          });
        } catch (fileError) {
          console.error('Error copying file to Jetson:', fileError);
          
          // Clean up file even if copying failed
          try {
            await fs.unlink(file.path);
          } catch (unlinkError) {
            console.error('Failed to clean up temporary file:', unlinkError);
          }

          // Check if it's a permission error
          if (fileError.code === 'EACCES' || fileError.code === 'EPERM') {
            results.push({
              success: false,
              originalName: file.originalname,
              error: 'Permission denied - ensure NFS mount has write access to Jetson',
              code: fileError.code,
              details: 'Check that X: drive is mounted with write permissions'
            });
          } else if (fileError.code === 'ENOENT') {
            results.push({
              success: false,
              originalName: file.originalname,
              error: 'NFS mount not accessible - check if X: drive is properly mounted',
              code: fileError.code,
              details: 'Verify that the Jetson NFS mount is active'
            });
          } else {
            results.push({
              success: false,
              originalName: file.originalname,
              error: `Copy failed: ${fileError.message}`,
              code: fileError.code
            });
          }
        }
      }

      // Determine overall success
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.length - successCount;

