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

      console.log('\n=== HOST TO JETSON COPY RESULTS ===');
      console.log('Total files:', results.length);
      console.log('Successfully copied to Jetson:', successCount);
      console.log('Failed to copy:', failureCount);
      console.log('Detailed results:', results);

      const response = {
        success: successCount > 0,
        operation: 'host-to-jetson-copy',
        totalFiles: results.length,
        successfulCopies: successCount,
        failedCopies: failureCount,
        files: results,
        message: successCount === results.length 
          ? 'All files copied successfully from host to Jetson filesystem'
          : successCount > 0 
          ? `${successCount} of ${results.length} files copied successfully to Jetson`
          : 'All file copies to Jetson failed',
        timestamp: new Date().toISOString()
      };

      // Return 200 if any files succeeded, 400 if all failed
      res.status(successCount > 0 ? 200 : 400).json(response);

    } catch (error) {
      console.error('Host-to-Jetson copy endpoint error:', error);
      
      // Clean up any uploaded files on error
      if (req.files) {
        for (const file of req.files) {
          try {
            await fs.unlink(file.path);
          } catch (cleanupError) {
            console.error('Failed to cleanup temp file:', file.path, cleanupError);
          }
        }
      }
      
      res.status(500).json({
        success: false,
        operation: 'host-to-jetson-copy',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });
});

router.get('/download', async (req, res) => {
  try {
    const userPath = req.query.path || '';
    const safePath = await validatePath(userPath);
    if (!safePath) return res.status(400).json({ success: false, error: 'Invalid path' });
    const stats = await fs.stat(safePath);
    if (!stats.isFile()) return res.status(400).json({ success: false, error: 'Path is not a file' });
    const filename = path.basename(safePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const fileStream = createReadStream(safePath);
    fileStream.pipe(res);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/delete', async (req, res) => {
  try {
    const userPath = req.body.path || '';
    const safePath = await validatePath(userPath);
    if (!safePath) return res.status(400).json({ success: false, error: 'Invalid path' });
    const stats = await fs.stat(safePath);
    if (stats.isDirectory()) await fs.rmdir(safePath, { recursive: true });
    else await fs.unlink(safePath);
    res.json({ success: true, message: `${stats.isDirectory() ? 'Directory' : 'File'} deleted successfully` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/mkdir', async (req, res) => {
  const userPath = req.body.path || '';
  console.log('mkdir request:', { userPath, body: req.body });
  
  let safePath;
  try {
    // Validate the folder name from the path
    const folderName = path.basename(userPath);
    
    // Validate folder name for invalid characters (Windows file system restrictions)
    const invalidChars = /[\\/:*?"<>|]/;
    if (invalidChars.test(folderName)) {
      return res.status(400).json({ 
        success: false, 
        error: 'A file name can\'t contain any of the following characters: \\ / : * ? " < > |' 
      });
    }
    
    const trimmedName = folderName.trim();
    if (trimmedName.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Folder name cannot be empty' 
      });
    }
    
    if (trimmedName.endsWith('.')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Folder name cannot end with a period' 
      });
    }
    
    // Check for reserved Windows names
    const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    if (reservedNames.test(trimmedName)) {
      return res.status(400).json({ 
        success: false, 
        error: 'This is a reserved system name and cannot be used' 
      });
    }
    
    safePath = await validatePath(userPath);
    console.log('mkdir safePath:', safePath);
    
    if (!safePath) {
      return res.status(400).json({ success: false, error: 'Invalid path' });
    }

    // Check if the directory already exists
    try {
      const stats = await fs.stat(safePath);
      if (stats.isDirectory()) {
        return res.status(400).json({ success: false, error: 'Directory already exists' });
      }
    } catch {
      // Directory doesn't exist, which is what we want
    }

    // Check parent directory permissions before trying to create
    const parentPath = path.dirname(safePath);
    try {
      await fs.access(parentPath, fs.constants.W_OK);
      console.log('Parent directory is writable:', parentPath);
    } catch (permError) {
      console.error('Parent directory not writable:', permError);
      return res.status(403).json({ 
        success: false, 
        error: `No write permissions to parent directory: ${parentPath}. Error: ${permError.message}`
      });
    }

    // Try to create the directory
    await fs.mkdir(safePath, { recursive: true });
    console.log('Directory created successfully:', safePath);
    
    const rootPath = await FILESYSTEM_ROOT_PATH();
    res.json({ 
      success: true, 
      message: 'Directory created successfully', 
      path: path.relative(rootPath, safePath).replace(/\\/g, '/') 
    });
  } catch (error) {
    console.error('mkdir error:', error);
    
    // Provide more specific error messages
    let errorMessage = error.message;
    const rootPath = await FILESYSTEM_ROOT_PATH();
    
    if (error.code === 'EPERM') {
      errorMessage = `Permission denied. The NFS mount at ${rootPath} may not have write permissions. Please check NFS server export settings and remount with proper permissions.`;
    } else if (error.code === 'EACCES') {
      errorMessage = `Access denied. Check NFS mount permissions for ${rootPath}.`;
    } else if (error.code === 'ENOENT') {
      errorMessage = `Path not found. The NFS mount at ${rootPath} may not be properly mounted.`;
    }
    
    res.status(500).json({ 
      success: false, 
      error: `Failed to create directory: ${errorMessage}`,
      code: error.code,
      path: safePath || userPath,
      suggestion: error.code === 'EPERM' ? 'NFS server may need to be configured with proper write permissions (no_root_squash, rw)' : null
    });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const rootPath = await FILESYSTEM_ROOT_PATH();
    if (!rootPath) {
      return res.status(503).json({
        success: false,
        error: 'NFS is not mounted. File stats cannot be displayed.',
        stats: null,
        rootPath: null
      });
    }
    
    // OPTIMIZED: Check if fast mode is requested (skip recursive calculation)
    const fastMode = req.query.fast === 'true';
    
    if (fastMode) {
      // OPTIMIZED: Fast stats - just get basic directory info without recursion
      try {
        const items = await fs.readdir(rootPath, { withFileTypes: true });
        const fileCount = items.filter(item => !item.isDirectory()).length;
        const dirCount = items.filter(item => item.isDirectory()).length;
        
        res.json({
          success: true,
          stats: {
            totalSize: 0, // Skip size calculation for speed
            fileCount: fileCount,
            directoryCount: dirCount,
            rootPath: rootPath,
            timeframe: 'Fast stats (current directory only)',
            fastMode: true,
            readable: {
              size: 'Not calculated (fast mode)',
              files: fileCount,
              directories: dirCount
            }
          }
        });
        return;
      } catch (error) {
        console.warn('Fast stats calculation failed:', error.message);
        // Fall through to error response
      }
    }
    
    // OPTIMIZED: Original recursive calculation - now optional
    const calculateAllItems = async (dirPath, maxDepth = 3, currentDepth = 0) => {
      let totalSize = 0, fileCount = 0, dirCount = 0;
      
      // OPTIMIZED: Limit recursion depth to prevent long delays
      if (currentDepth >= maxDepth) {
        return { size: totalSize, files: fileCount, directories: dirCount };
      }
      
      try {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        
        // OPTIMIZED: Process in smaller batches with timeout
        const BATCH_SIZE = 20;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE);
          
          for (const item of batch) {
            const itemPath = path.join(dirPath, item.name);
            try {
              if (item.isDirectory()) {
                dirCount++;
                const subStats = await calculateAllItems(itemPath, maxDepth, currentDepth + 1);
                totalSize += subStats.size;
                fileCount += subStats.files;
                dirCount += subStats.directories;
              } else {
                const stats = await fs.stat(itemPath);
                fileCount++;
                totalSize += stats.size;
              }
            } catch {
              // Skip items with permission issues - don't log to reduce noise
              continue;
            }
          }
        }
      } catch (error) {
        console.warn('Error accessing path during stats calculation:', error.message);
      }
      return { size: totalSize, files: fileCount, directories: dirCount };
    };
    
    const stats = await calculateAllItems(rootPath);
    res.json({
      success: true,
      stats: {
        totalSize: stats.size,
        fileCount: stats.files,
        directoryCount: stats.directories,
        rootPath: rootPath,
        timeframe: 'Total files and folders (limited depth)',
        fastMode: false,
        readable: {
          size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
          files: stats.files,
          directories: stats.directories
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mount NFS endpoint
router.post('/mount', async (req, res) => {
  try {
    // Import NFSManager dynamically to avoid circular dependencies
    const { default: nfsManager } = await import('./nfsManager.js');
    
    // Attempt to mount the NFS drive
    const mountResult = await nfsManager.mountNFS();
    
    if (mountResult) {
      res.json({
        success: true,
        message: 'NFS drive mounted successfully',
        status: nfsManager.getStatus(),
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to mount NFS drive',
        status: nfsManager.getStatus(),
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Error mounting NFS drive:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Unmount NFS endpoint
router.post('/unmount', async (req, res) => {
  try {
    // Import NFSManager dynamically to avoid circular dependencies
    const { default: nfsManager } = await import('./nfsManager.js');
    
    // Attempt to unmount the NFS drive
    await nfsManager.unmountNFS();
    
    res.json({
      success: true,
      message: 'NFS drive unmounted successfully',
      status: nfsManager.getStatus(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error unmounting NFS drive:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Upload-RAG endpoint - handles personalizing existing Jetson files via foreign server
router.post('/upload-rag', async (req, res) => {
  try {
    console.log('\n=== JETSON FILE PERSONALIZATION ENDPOINT ===');
    const { user_id, ingestion_file_paths } = req.body;
    
    // Ensure ingestion_file_paths is an array of absolute paths
    const paths = Array.isArray(ingestion_file_paths)
      ? ingestion_file_paths.map(p => p.startsWith('X:') ? p : `X:/${p.replace(/^[/\\]?/, '')}`)
      : [];

    console.log('Received personalization request:', JSON.stringify(req.body, null, 2));
    console.log('Processed file paths:', paths);

    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(200).json({ 
        success: false, 
        error: 'No file paths provided for personalization',
        operation: 'jetson-file-personalization'
      });
    }

    if (!user_id) {
      return res.status(200).json({ 
        success: false, 
        error: 'User ID is required for personalization',
        operation: 'jetson-file-personalization'
      });
    }

    // File type validation for RAG personalization - allowed extensions
    const allowedRagExtensions = ['.pdf', '.txt', '.md', '.py', '.c', '.java', '.cpp', '.go', '.ts', '.js', '.csv', '.xlsx'];
    const invalidFiles = [];
    
    for (const filePath of paths) {
      const fileExtension = path.extname(filePath).toLowerCase();
      if (!allowedRagExtensions.includes(fileExtension)) {
        invalidFiles.push({
          path: filePath,
          filename: filePath.split(/[/\\]/).pop(),
          extension: fileExtension,
          reason: `File type not allowed for RAG personalization. Allowed types: ${allowedRagExtensions.join(', ')}`
        });
      }
    }
    
    if (invalidFiles.length > 0) {
      console.log('❌ Invalid file types detected for RAG personalization:', invalidFiles);
      return res.status(400).json({
        success: false,
        error: 'Some files have invalid file types for RAG personalization',
        invalidFiles: invalidFiles,
        allowedExtensions: allowedRagExtensions,
        operation: 'jetson-file-personalization'
      });
    }

    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : null;

    if (!token) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authorization token is required for foreign server access. Please login first.',
        operation: 'jetson-file-personalization'
      });
    }

    // Forward to foreign server for AI personalization
    const foreignUrl = 'https://192.168.7.22:5000/ingestion';
    const headers = { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    const payload = { user_id, ingestion_file_paths: paths };
    console.log('Sending personalization payload to foreign server:', JSON.stringify(payload, null, 2));

    // Create AbortController for timeout handling - 30 seconds should be enough
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000000); // 5 minutes timeout

    let response;
    let responseText = '';
    try {
      console.log('🚀 Initiating fetch request to foreign server...');
      const fetchStartTime = Date.now();
      
      response = await fetch(foreignUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'Connection': 'close' // Force connection to close after response
        },
        body: JSON.stringify(payload),
        agent: httpsAgent,
        signal: controller.signal
      });
      
      const fetchDuration = Date.now() - fetchStartTime;
      console.log(`✅ Fetch request completed in ${fetchDuration}ms`);
      console.log(`📡 Response status: ${response.status} ${response.statusText}`);
      console.log(`📡 Response headers:`, Object.fromEntries(response.headers.entries()));
      
      clearTimeout(timeoutId); // Clear timeout if request completes
      
      // Read response body with its own timeout
      console.log('📥 Reading response body...');
      const bodyStartTime = Date.now();
      
      // Set a new timeout for reading the body
      const bodyTimeout = setTimeout(() => {
        console.error('⏰ Response body read timeout - forcing empty response');
        responseText = '';
      }, 10000); // 10 seconds to read body
      
      try {
        responseText = await response.text();
        clearTimeout(bodyTimeout);
        const bodyDuration = Date.now() - bodyStartTime;
        console.log(`✅ Response body read successfully in ${bodyDuration}ms, length:`, responseText.length);
      } catch (bodyError) {
        clearTimeout(bodyTimeout);
        console.error('❌ Error reading response body:', bodyError.message);
        // Continue with empty response
        responseText = '';
      }
      
    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ Fetch request failed:', fetchError.name, fetchError.message);
      console.error('❌ Full error:', fetchError);
      
      if (fetchError.name === 'AbortError') {
        console.error('❌ Foreign server request timed out after 5 minutes');
        return res.status(408).json({
          success: false,
          operation: 'jetson-file-personalization',
          error: 'Request timeout: AI personalization service took too long to respond (>5 minutes)',
          details: 'The foreign server AI service is overloaded or the file is too complex to process',
          files: paths.map(path => ({
            path: path,
            filename: path.split(/[/\\]/).pop(),
            status: 'timeout',
            error: 'Request timed out'
          }))
        });
      }
      
      // Re-throw other network errors
      throw fetchError;
    }
    console.log('📊 Foreign server response details:', {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      bodyLength: responseText.length,
      bodyPreview: responseText.length > 0 ? responseText.substring(0, 500) : '(empty)',
      isEmpty: responseText.length === 0
    });
    
    // Handle authentication errors from foreign server
    if (response.status === 401) {
      console.error('❌ Authentication failed with foreign server (401)');
      return res.status(401).json({ 
        success: false, 
        operation: 'jetson-file-personalization',
        error: 'Authentication failed with foreign server. Please check your credentials.',
        details: 'The AI personalization service rejected your authorization token'
      });
    }
    
    // Handle duplicate files (status 208)
    if (response.status === 208) {
      console.log('⚠️ Foreign server returned 208 - duplicate files detected');
      let duplicateDetails = {};
      
      if (responseText.length > 0) {
        try {
          duplicateDetails = JSON.parse(responseText);
          console.log('Parsed duplicate response:', duplicateDetails);
        } catch (e) {
          console.warn('Could not parse 208 response as JSON:', e.message);
          duplicateDetails = { message: responseText.substring(0, 200) };
        }
      } else {
        duplicateDetails = { message: 'Empty response from server' };
      }
      
      return res.status(200).json({ 
        success: false, 
        operation: 'jetson-file-personalization',
        error: 'Some or all files already exist in the personalization system',
        code: 'DUPLICATE_FILES',
        files: paths.map(path => ({
          path: path,
          filename: path.split(/[/\\]/).pop(),
          status: 'duplicate',
          message: 'File already exists in personalization system'
        })),
        foreignResponse: duplicateDetails
      });
    }

    // Handle 504 Gateway Timeout specifically
    if (response.status === 504) {
      console.error('❌ Foreign server 504 Gateway Timeout');
      
      let timeoutDetails;
      try {
        timeoutDetails = responseText.length > 0 ? JSON.parse(responseText) : {};
      } catch {
        timeoutDetails = { rawError: responseText };
      }
      
      return res.status(408).json({ 
        success: false, 
        operation: 'jetson-file-personalization',
        error: 'AI personalization service timed out',
        details: 'The foreign server AI service took too long to process your files. This usually happens when:\n1. The AI service is overloaded\n2. Files are too large or complex\n3. Network connectivity issues',
        suggestions: [
          'Try again in a few minutes when the AI service is less busy',
          'If the problem persists, try with smaller files',
          'Contact administrator if the issue continues'
        ],
        files: paths.map(path => ({
          path: path,
          filename: path.split(/[/\\]/).pop(),
          status: 'timeout',
          error: 'AI service timeout (504 Gateway Timeout)'
        })),
        foreignResponse: timeoutDetails,
        timestamp: new Date().toISOString()
      });
    }

    // Handle other non-200 responses
    if (!response.ok) {
      console.error('❌ Foreign server error - non-OK response:', response.status, responseText.substring(0, 300));
      return res.status(200).json({ 
        success: false, 
        operation: 'jetson-file-personalization',
        error: `AI personalization service returned error ${response.status}`,
        details: responseText.length > 0 ? responseText.substring(0, 300) : 'Empty response',
        files: paths.map(path => ({
          path: path,
          filename: path.split(/[/\\]/).pop(),
          status: 'failed',
          error: `Server error: ${response.status}`
        }))
      });
    }
    
    // Parse successful response - handle empty responses gracefully
    console.log('✅ Foreign server returned OK status (200), parsing response...');
    let result;
    if (responseText.length === 0) {
      console.warn('⚠️ Foreign server returned empty response for successful request');
      result = { message: 'Success - empty response from foreign server' };
    } else {
      try {
        result = JSON.parse(responseText);
        console.log('✅ Successfully parsed JSON response:', JSON.stringify(result, null, 2));
      } catch (e) {
        console.error('❌ Foreign server returned non-JSON response:', {
          error: e.message,
          responseLength: responseText.length,
          responsePreview: responseText.substring(0, 500)
        });
        return res.status(502).json({ 
          success: false, 
          operation: 'jetson-file-personalization',
          error: 'AI personalization service returned invalid response format',
          details: `JSON parse error: ${e.message}`,
          rawResponsePreview: responseText.substring(0, 200)
        });
      }
    }

    // Update global personalized files list for the user
    console.log('🔄 Updating global personalized files list...');
    try {
      const { addPersonalizedFile } = await import('./chat.js');
      const { extractUserIdFromToken } = await import('./auth.js');
      
      // Get user ID from token
      const userId = extractUserIdFromToken(authHeader);
      if (userId) {
        // Add all successfully personalized files to the global list
        paths.forEach(filePath => {
          addPersonalizedFile(userId, filePath);
        });
        console.log('✅ Updated global personalized files list for user:', userId);
      } else {
        console.warn('⚠️ Could not extract user ID from token to update personalized files list');
      }
    } catch (updateError) {
      console.error('❌ Error updating personalized files list:', updateError.message);
      // Don't fail the request if we can't update the list
    }

    // Enhanced success response with detailed file information
    const fileResults = paths.map(filePath => ({
      path: filePath,
      filename: filePath.split(/[/\\]/).pop(),
      status: 'personalized',
      message: 'Successfully sent to AI personalization service'
    }));

    const enhancedResponse = {
      success: true,
      operation: 'jetson-file-personalization',
      totalFiles: paths.length,
      personalizedFiles: paths.length,
      files: fileResults,
      message: `${paths.length} Jetson file(s) successfully sent for AI personalization`,
      foreignServerResponse: result,
      timestamp: new Date().toISOString()
    };

    console.log('\n=== PERSONALIZATION SUCCESS ===');
    console.log('Files processed:', paths.length);
    console.log('Foreign server response:', result);
    
    res.json(enhancedResponse);
    
  } catch (err) {
    console.error('Jetson file personalization endpoint error:', err);
    res.status(500).json({ 
      success: false, 
      operation: 'jetson-file-personalization',
      error: `Personalization failed: ${err.message}`,
      timestamp: new Date().toISOString()
    });
  }
});

// Temporary file upload endpoint - for RAG purposes
router.post('/upload-temp', (req, res) => {
  console.log('\n=== TEMP FILE UPLOAD ENDPOINT ===');
  // Use multer to handle multiple files for temp uploads
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
      console.log('Files received for temp upload:', req.files ? req.files.length : 0);
      
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'No files provided for temp upload. Use form field name "files"' 
        });
      }

      // File type validation for temp uploads - allowed extensions including images
      const allowedTempExtensions = [
        '.pdf', '.txt', '.md', '.c', '.cpp', '.go', '.js', '.java', '.py', // Documents & Code
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.ico' // Images
      ];
      const invalidFiles = [];
      
      for (const file of req.files) {
        const fileExtension = path.extname(file.originalname).toLowerCase();
        if (!allowedTempExtensions.includes(fileExtension)) {
          invalidFiles.push({
            name: file.originalname,
            extension: fileExtension,
            reason: `File type not allowed for temp upload. Allowed types: ${allowedTempExtensions.join(', ')}`
          });
        }
      }
      
      if (invalidFiles.length > 0) {
        console.log('❌ Invalid file types detected for temp upload:', invalidFiles);
        return res.status(400).json({
          success: false,
          error: 'Some files have invalid file types for temp upload',
          invalidFiles: invalidFiles,
          allowedExtensions: allowedTempExtensions,
          operation: 'temp-file-upload'
        });
      }

      // Create global temp folder on Jetson if it doesn't exist
      const tempDir = path.join('X:', 'temp'); // Remove extra backslashes to avoid path issues
      console.log('🔍 Creating temp directory at:', tempDir);
      
      try {
        await ensureDirectoryExists(tempDir);
        console.log('✅ Temp directory ensured:', tempDir);
        
        // Double-check the path is accessible
        const stats = await fs.stat(tempDir);
        console.log(`✅ Temp directory exists and is ${stats.isDirectory() ? 'a directory' : 'NOT a directory'}`);
      } catch (dirError) {
        console.error('❌ Failed to create temp directory:', dirError);
        return res.status(500).json({ 
          success: false, 
          error: `Failed to create temp directory: ${dirError.message}` 
        });
      }

      const results = [];
      
      for (const file of req.files) {
        console.log('\nProcessing file for temp upload:', {
          originalname: file.originalname,
          size: file.size,
          uploadPath: file.path
        });

        try {
          // Simplify the approach: always create a new timestamped file
          // This ensures we don't have conflicts and the file path is predictable
          const timestamp = Date.now();
          const filename = `${timestamp}_${file.originalname}`;
          console.log(`Using filename: ${filename} with timestamp: ${timestamp}`);
          
          // Create a consistent path format
          const jetsonTempPath = path.join(tempDir, filename);
          // Create an absolute path for LLM in a consistent format
          const absoluteLLMPath = `X:/temp/${filename}`;
          
          console.log('Target Jetson temp path:', jetsonTempPath);
          console.log('Absolute LLM path:', absoluteLLMPath);
          console.log('Source file path:', file.path);
          
          // Make sure temp directory exists
          await ensureDirectoryExists(tempDir);
          
          // Copy file to Jetson temp folder
          await fs.copyFile(file.path, jetsonTempPath);
          
          // Verify the file was copied successfully
          const fileExists = await fs.stat(jetsonTempPath).then(() => true).catch(() => false);
          if (!fileExists) {
            throw new Error(`File was not copied successfully to ${jetsonTempPath}`);
          }
          console.log('✅ File copied successfully to Jetson temp folder');

          // Keep temp file for foreign server access - will be cleaned up on server restart or logout
          console.log('✅ Temp file preserved for foreign server access');
          
          // Add to results with consistent path format
          results.push({
            name: filename,
            originalName: file.originalname,
            absolutePath: absoluteLLMPath, // Use forward slashes for LLM path
            size: file.size,
            timestamp: timestamp
          });
        } catch (fileError) {
          console.error('Error copying file to Jetson temp:', fileError);
          
          // Keep temp file even if copying failed - will be cleaned up on server restart
          console.log('⚠️ Temp file preserved despite copy failure - will be cleaned up on server restart');

          // Provide a more detailed error message and add failed file to results with error info
          console.error('Failed to upload temp file:', file.originalname, fileError.message);
          results.push({
            name: file.originalname,
            originalName: file.originalname,
            error: fileError.message,
            status: 'failed',
            size: file.size
          });
        }
      }

      console.log('\n=== TEMP FILE UPLOAD RESULTS ===');
      console.log('Total files processed:', req.files.length);
      console.log('Successfully uploaded to temp:', results.length);
      console.log('Detailed results:', results);

      // Count successful uploads (those without an error property)
      const successfulUploads = results.filter(file => !file.error);
      const failedUploads = results.filter(file => file.error);
      
      console.log(`Successful uploads: ${successfulUploads.length}, Failed uploads: ${failedUploads.length}`);
      
      if (successfulUploads.length > 0) {
        // Return only the successful uploads in the response
        res.json(successfulUploads);
      } else if (results.length > 0) {
        // Return detailed error information if we have files that failed
        res.status(400).json({ 
          success: false, 
          error: 'All file uploads failed',
          failedFiles: failedUploads.map(file => ({
            filename: file.originalName,
            error: file.error
          }))
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: 'No files could be uploaded to temp folder' 
        });
      }

    } catch (error) {
      console.error('Temp file upload endpoint error:', error);
      
      // Keep uploaded files - will be cleaned up on server restart or logout
      console.log('⚠️ Temp files preserved despite error - will be cleaned up on server restart');
      
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
});

// Delete temporary file endpoint
router.delete('/temp/:filename', async (req, res) => {
  try {
    console.log('\n=== DELETE TEMP FILE ENDPOINT ===');
    const filename = req.params.filename;
    console.log('Filename to delete:', filename);

    if (!filename) {
      return res.status(400).json({ 
        success: false, 
        error: 'Filename is required' 
      });
    }

    // Construct path to temp file on Jetson
    const tempDir = path.join('X:', 'temp'); // Consistent with other usage
    const filePath = path.join(tempDir, filename);
    
    console.log('Full path to delete:', filePath);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      console.log('File not found:', filePath);
      return res.status(404).json({ 
        success: false, 
        error: 'Temp file not found' 
      });
    }

    // Delete the file
    await fs.unlink(filePath);
    console.log('✅ Temp file deleted successfully:', filename);

    res.json({ 
      success: true, 
      message: `Temp file ${filename} deleted successfully` 
    });

  } catch (error) {
    console.error('Delete temp file error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Cleanup temporary files endpoint
router.post('/cleanup-temp', async (req, res) => {
  try {
    console.log('\n=== CLEANUP TEMP FILES ENDPOINT ===');
    await cleanupTempFiles();
    
    res.json({
      success: true,
      message: 'Temporary files cleaned up successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Cleanup temp files endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Permanent delete endpoint - removes files from personalized list and forwards to foreign server
router.post('/permanent_delete', async (req, res) => {
  try {
    console.log('\n=== PERMANENT DELETE ENDPOINT ===');
    const { files } = req.body;
    
    console.log('Files to permanently delete:', files);

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Files array is required for permanent deletion',
        operation: 'permanent-delete'
      });
    }

    // Extract token and user ID for personalized files management
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : null;

    if (!token) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authorization token is required for permanent deletion',
        operation: 'permanent-delete'
      });
    }

    // Get user ID from token
    let userId = null;
    try {
      const { extractUserIdFromToken } = await import('./auth.js');
      userId = extractUserIdFromToken(authHeader);
      if (!userId) {
        console.warn('⚠️ Could not extract user ID from token');
        return res.status(401).json({ 
          success: false, 
          error: 'Could not extract user ID from token',
          operation: 'permanent-delete'
        });
      }
    } catch (error) {
      console.error('❌ Error extracting user ID:', error.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Authentication error',
        operation: 'permanent-delete'
      });
    }

    try {
      // Ensure file paths are absolute paths with X: prefix (similar to upload-rag endpoint)
      const absoluteFilePaths = Array.isArray(files)
        ? files.map(p => {
            const convertedPath = p.startsWith('X:') ? p : `X:/${p.replace(/^[/\\]?/, '')}`;
            console.log(`Converting path: "${p}" -> "${convertedPath}"`);
            return convertedPath;
          })
        : [];

      console.log('Original file paths:', files);
      console.log('Converted to absolute paths:', absoluteFilePaths);

      // Forward to foreign server for AI deletion FIRST
      const foreignUrl = 'https://192.168.7.22:5000/permanent_delete';
      const headers = { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      };

      const payload = { 
        user_id: userId, // Include user_id as required by foreign server
        file_paths: absoluteFilePaths // Use absolute file paths instead of relative filenames
      };
      console.log('Sending permanent delete payload to foreign server:', JSON.stringify(payload, null, 2));

      const response = await fetch(foreignUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        agent: httpsAgent
      });

      const responseText = await response.text();
      console.log('Foreign server permanent delete response:', {
        status: response.status,
        statusText: response.statusText,
        body: responseText
      });
      
      // Handle authentication errors from foreign server
      if (response.status === 401) {
        return res.status(401).json({ 
          success: false, 
          operation: 'permanent-delete',
          error: 'Authentication failed with foreign server',
        details: 'The AI service rejected your authorization token'
      });
    }
    
    // Parse response or handle empty response
    let result;
    if (responseText.length === 0) {
      console.log('Foreign server returned empty response for permanent delete');
      result = { message: 'Permanent deletion completed - empty response from foreign server' };
    } else {
      try {
        result = JSON.parse(responseText);
      } catch (e) {
        console.warn('Could not parse foreign server permanent delete response as JSON:', e.message);
        result = { message: responseText.substring(0, 200) };
      }
    }

    // Only remove from global personalized files if foreign server responded successfully
    if (response.ok) {
      try {
        const { removePersonalizedFile } = await import('./chat.js');
        
        // Remove all files from the global personalized files list
        absoluteFilePaths.forEach(filePath => {
          removePersonalizedFile(userId, filePath);
        });
        console.log('✅ Foreign server deletion successful - Removed files from global personalized files list for user:', userId);
      } catch (removeError) {
        console.error('❌ Error removing files from personalized list after successful foreign deletion:', removeError.message);
        // Continue with success response even if local cleanup fails
      }
    } else {
      console.error('❌ Foreign server deletion failed - NOT removing from personalized files list');
      return res.status(response.status).json({
        success: false,
        operation: 'permanent-delete',
        error: `Foreign server deletion failed: ${result.error || result.message || 'Unknown error'}`,
        foreignServerResponse: result,
        timestamp: new Date().toISOString()
      });
    }

    // Success response
    const enhancedResponse = {
      success: true,
      operation: 'permanent-delete',
      totalFiles: absoluteFilePaths.length,
      deletedFiles: absoluteFilePaths.length,
      files: absoluteFilePaths.map(filePath => ({
        path: filePath,
        filename: filePath.split(/[/\\]/).pop(),
        status: 'permanently_deleted',
        message: 'Successfully removed from AI personalization service'
      })),
      message: `${absoluteFilePaths.length} file(s) permanently deleted from AI personalization service`,
      foreignServerResponse: result,
      timestamp: new Date().toISOString()
    };

    console.log('\n=== PERMANENT DELETE SUCCESS ===');
    console.log('Files permanently deleted:', absoluteFilePaths.length);
    console.log('Foreign server response:', result);
    
    res.json(enhancedResponse);
    
    } catch (updateError) {
      console.error('❌ Error during permanent delete operation:', updateError.message);
      // Return error response if deletion fails
      return res.status(500).json({
        success: false,
        operation: 'permanent-delete',
        error: `Permanent deletion failed: ${updateError.message}`,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (err) {
    console.error('Permanent delete endpoint error:', err);
    res.status(500).json({ 
      success: false, 
      operation: 'permanent-delete',
      error: `Permanent deletion failed: ${err.message}`,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
export { cleanupTempFiles };