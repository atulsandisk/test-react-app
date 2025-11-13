import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import archiver from 'archiver';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import nfsManager from './nfsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// Configure multer for file uploads with dynamic path
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const requestedPath = req.body.path || '';
    const mountPath = getMountPath();
    const fullPath = path.resolve(mountPath, requestedPath.replace(/^\/+/, ''));
    cb(null, fullPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 10, // Max 10 files at once
  },
  fileFilter: (req, file, cb) => {
    // Quick file validation
    if (file.originalname && file.originalname.length > 0) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file name'), false);
    }
  }
});

// Function to get the current mount path from NFS Manager
const getMountPath = () => {
  const status = nfsManager.getStatus();
  if (status.isNFSMounted && status.currentUsername) {
    // With the new structure, X: directly maps to the user's directory
    // No need for subdirectories - X: IS the user's home directory
    console.log(`📁 Using NFS mount point directly: ${status.nfsMountPoint}`);
    return status.nfsMountPoint; // X: is the user's directory
  }
  
  // No fallback - require proper NFS mounting
  console.error(`❌ ERROR: NFS not mounted for user (${status.currentUsername || 'unknown'}) - NFS must be mounted during login`);
  throw new Error('NFS not mounted. Please ensure you are logged in properly.');
};

// Enhanced security validation with defense-in-depth patterns
const SECURITY_CONFIG = {
  MAX_PATH_DEPTH: 50,
  MAX_FILENAME_LENGTH: 255,
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
  BLOCKED_EXTENSIONS: ['.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.msi', '.dll', '.sys', '.vbs', '.jar', '.app', '.sh', '.ps1'],
  DANGEROUS_PATTERNS: [
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i, // Windows reserved names
    /\.\./,                                     // Directory traversal
    /[<>:"|?*]/,                              // Invalid filename characters
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x80-\x9f]/,                  // Control characters
    /^-/                                      // Files starting with dash
  ]
};

class SecurityError extends Error {
  constructor(message, type = 'SECURITY_VIOLATION', details = {}) {
    super(message);
    this.name = 'SecurityError';
    this.type = type;
    this.details = details;
    this.status = 403;
  }
}

// Enhanced path validation with comprehensive security checks
const validatePath = async (requestedPath) => {
  const mountPath = getMountPath();
  
  if (!requestedPath) {
    return mountPath;
  }
  
  // Input type validation
  if (typeof requestedPath !== 'string') {
    throw new SecurityError('Path must be a string', 'INVALID_INPUT');
  }
  
  // Check for path injection patterns
  const pathInjectionPatterns = [
    /\.\./,                    // Directory traversal
    /\/\.\./,                  // Unix directory traversal
    /\\\.\./,                  // Windows directory traversal
    /[<>:"|?*]/,              // Invalid path characters
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x80-\x9f]/,   // Control characters
    /^[a-zA-Z]:\\/,           // Absolute Windows paths
    /^\//                      // Absolute Unix paths
  ];
  
  for (const pattern of pathInjectionPatterns) {
    if (pattern.test(requestedPath)) {
      throw new SecurityError(
        'Path contains invalid characters or patterns', 
        'PATH_INJECTION',
        { path: requestedPath, pattern: pattern.toString() }
      );
    }
  }
  
  // Normalize and validate path depth
  const normalized = path.normalize(requestedPath.replace(/^\/+/, ''));
  const pathParts = normalized.split(path.sep).filter(part => part && part !== '.');
  
  if (pathParts.length > SECURITY_CONFIG.MAX_PATH_DEPTH) {
    throw new SecurityError(
      `Path depth exceeds maximum allowed (${SECURITY_CONFIG.MAX_PATH_DEPTH})`,
      'PATH_TOO_DEEP',
      { path: requestedPath, depth: pathParts.length }
    );
  }
  
  // Validate each path component
  pathParts.forEach(part => validateFilename(part));
  
  const fullPath = path.resolve(mountPath, normalized);
  
  // Ensure the path is within the mount directory (path traversal protection)
  if (!fullPath.startsWith(path.resolve(mountPath))) {
    throw new SecurityError(
      'Path traversal attempt detected',
      'PATH_TRAVERSAL',
      { requestedPath, mountPath, resolvedPath: fullPath }
    );
  }
  
  return fullPath;
};

// Enhanced filename validation
const validateFilename = (filename) => {
  if (!filename || typeof filename !== 'string') {
    throw new SecurityError('Filename must be a non-empty string', 'INVALID_FILENAME');
  }
  
  if (filename.length > SECURITY_CONFIG.MAX_FILENAME_LENGTH) {
    throw new SecurityError(
      `Filename exceeds maximum length (${SECURITY_CONFIG.MAX_FILENAME_LENGTH})`,
      'FILENAME_TOO_LONG',
      { filename, length: filename.length }
    );
  }
  
  // Check dangerous patterns
  for (const pattern of SECURITY_CONFIG.DANGEROUS_PATTERNS) {
    if (pattern.test(filename)) {
      throw new SecurityError(
        'Filename contains dangerous patterns',
        'DANGEROUS_FILENAME',
        { filename, pattern: pattern.toString() }
      );
    }
  }
  
  // Check blocked extensions
  const extension = path.extname(filename).toLowerCase();
  if (extension && SECURITY_CONFIG.BLOCKED_EXTENSIONS.includes(extension)) {
    throw new SecurityError(
      'File extension is not allowed',
      'BLOCKED_EXTENSION',
      { filename, extension }
    );
  }
};

// File size validation (reserved for future use)
const _validateFileSize = (size) => {
  if (typeof size !== 'number' || size < 0) {
    throw new SecurityError('Invalid file size', 'INVALID_FILE_SIZE', { size });
  }
  
  if (size > SECURITY_CONFIG.MAX_FILE_SIZE) {
    throw new SecurityError(
      `File size exceeds maximum allowed (${SECURITY_CONFIG.MAX_FILE_SIZE} bytes)`,
      'FILE_TOO_LARGE',
      { size, maxSize: SECURITY_CONFIG.MAX_FILE_SIZE }
    );
  }
};

// Security audit logging (reserved for future use)
const _logSecurityEvent = (event, details = {}, severity = 'medium', req = null) => {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    severity,
    details,
    userAgent: req?.get('User-Agent') || 'unknown',
    ip: req?.ip || 'unknown',
    userId: req?.user?.id || 'unknown'
  };
  
  console.warn('🔒 Security Event:', logEntry);
  
  // In production, send to security monitoring service
  // securityMonitoring.log(logEntry);
};

// Helper function to get file stats with additional metadata
const getFileStats = async (filePath, relativePath) => {
  try {
    const stats = await fs.stat(filePath);
    const extname = path.extname(filePath).toLowerCase();
    
    // Determine file type
    let fileType = 'file';
    let mimeType = 'application/octet-stream';
    
    if (stats.isDirectory()) {
      fileType = 'folder';
      mimeType = 'inode/directory';
    } else {
      // Determine file type based on extension
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp'];
      const videoExts = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'];
      const audioExts = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma'];
      const documentExts = ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.xls', '.xlsx', '.csv'];
      const archiveExts = ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'];
      
      if (imageExts.includes(extname)) {
        fileType = 'image';
        mimeType = `image/${extname.slice(1)}`;
      } else if (videoExts.includes(extname)) {
        fileType = 'video';
        mimeType = `video/${extname.slice(1)}`;
      } else if (audioExts.includes(extname)) {
        fileType = 'audio';
        mimeType = `audio/${extname.slice(1)}`;
      } else if (documentExts.includes(extname)) {
        fileType = 'document';
        mimeType = 'application/pdf';
      } else if (archiveExts.includes(extname)) {
        fileType = 'archive';
        mimeType = 'application/zip';
      }
    }
    
    return {
      name: path.basename(filePath),
      path: relativePath,
      type: fileType,
      mimeType,
      size: stats.size,
      isDirectory: stats.isDirectory(),
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime,
      permissions: stats.mode & parseInt('777', 8),
      extension: extname
    };
  } catch (error) {
    // Skip files that can't be accessed instead of failing entire directory listing
    console.warn(`⚠️ Skipping inaccessible file: ${filePath}`, error.message);
    return null;
  }
};

// Get directory contents
router.get('/browse', async (req, res) => {
  try {
    const requestedPath = req.query.path || '';
    const fullPath = await validatePath(requestedPath);
    
    console.log(`📁 Browsing MyDrive path: ${fullPath}`);
    
    // Check if path exists and is accessible
    try {
      await fs.access(fullPath);
    } catch {
      return res.status(404).json({
        success: false,
        error: 'Path not found or inaccessible',
        path: requestedPath
      });
    }

    // Get personalized files for the current user
    let personalizedFiles = [];
    let userId = null;
    try {
      const { getPersonalizedFiles } = await import('./chat.js');
      const { extractUserIdFromToken } = await import('./auth.js');
      
      const authHeader = req.headers.authorization;
      userId = extractUserIdFromToken(authHeader);
      personalizedFiles = userId ? getPersonalizedFiles(userId) : [];
      
      console.log('🔍 MyDrive personalized files check:', {
        userId,
        personalizedCount: personalizedFiles.length,
        personalizedFiles: personalizedFiles
      });
    } catch (error) {
      console.warn('⚠️ Could not load personalized files for MyDrive:', error.message);
    }

    const items = await fs.readdir(fullPath);
    
    // Early exit for empty directories
    if (items.length === 0) {
      return res.json({
        success: true,
        path: requestedPath,
        items: [],
        count: 0,
        timestamp: Date.now()
      });
    }
    
    // Process all files in parallel for better performance
    const fileListPromises = items.map(async (item) => {
      const itemPath = path.join(fullPath, item);
      const mountPath = getMountPath();
      const relativePath = path.relative(mountPath, itemPath);
      const fileInfo = await getFileStats(itemPath, relativePath);
      
      if (!fileInfo) return null;
      
      // Add personalized file checking
      if (!fileInfo.isDirectory && personalizedFiles.length > 0) {
        // Construct the expected personalized file path format
        const expectedPersonalizedPath = `X:/${relativePath.replace(/\\/g, '/')}`;
        const isPersonalized = personalizedFiles.some(pFile => {
          // Check multiple possible path formats
          const pFileNormalized = pFile.replace(/\\/g, '/');
          const match = pFileNormalized === expectedPersonalizedPath || 
                       pFileNormalized.endsWith(`/${fileInfo.name}`) ||
                       pFile.endsWith(fileInfo.name);
          
          return match;
        });
        
        fileInfo.isPersonalized = isPersonalized;
      } else {
        fileInfo.isPersonalized = false;
      }
      
      return fileInfo;
    });
    
    // Wait for all file operations to complete
    const fileListResults = await Promise.all(fileListPromises);
    const fileList = fileListResults.filter(item => item !== null);
    
    // Sort: directories first, then files alphabetically
    fileList.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    // Disable cache headers for real-time updates
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    res.json({
      success: true,
      path: requestedPath,
      items: fileList,
      count: fileList.length,
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('Error browsing MyDrive:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create new folder
router.post('/folder/create', async (req, res) => {
  try {
    const { path: requestedPath, name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Folder name is required'
      });
    }
    
    const trimmedName = name.trim();
    
    // Validate folder name for invalid characters (Windows file system restrictions)
    const invalidChars = /[\\/:*?"<>|]/;
    if (invalidChars.test(trimmedName)) {
      return res.status(400).json({
        success: false,
        error: 'A file name can\'t contain any of the following characters: \\ / : * ? " < > |'
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
    
    const parentPath = await validatePath(requestedPath);
    const newFolderPath = path.join(parentPath, trimmedName);
    
    // Check if folder already exists
    try {
      await fs.access(newFolderPath);
      return res.status(409).json({
        success: false,
        error: 'Folder already exists'
      });
    } catch {
      // Folder doesn't exist, continue with creation
    }
    
    await fs.mkdir(newFolderPath);
    
    console.log(`📁 Created folder: ${newFolderPath}`);
    
    res.json({
      success: true,
      message: 'Folder created successfully',
      path: path.relative(getMountPath(), newFolderPath)
    });
    
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Upload files
router.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const uploadPath = req.body.path || '';
    const targetPath = await validatePath(uploadPath);
    const folderPaths = req.body.folderPaths ? (Array.isArray(req.body.folderPaths) ? req.body.folderPaths : [req.body.folderPaths]) : [];
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files uploaded'
      });
    }
    
    const uploadedFiles = [];
    
    // Process files efficiently with folder structure support
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const folderPath = folderPaths[i] || file.originalname; // Use folder path if available, otherwise just filename
      
      try {
        // Join target path with folder path to preserve structure
        const finalPath = path.join(targetPath, folderPath);
        
        // Ensure parent directories exist
        const parentDir = path.dirname(finalPath);
        await fs.mkdir(parentDir, { recursive: true });
        
        // Move file to final location
        await fs.rename(file.path, finalPath);
        
        const relativePath = path.relative(getMountPath(), finalPath);
        const fileInfo = await getFileStats(finalPath, relativePath);
        
        if (fileInfo) {
          uploadedFiles.push(fileInfo);
        }
      } catch (fileError) {
        console.warn(`Failed to process file ${file.originalname}:`, fileError.message);
        // Continue with other files instead of failing entire upload
      }
    }
    
    console.log(`📤 Uploaded ${uploadedFiles.length} files to: ${targetPath}`);
    
    res.json({
      success: true,
      message: `Successfully uploaded ${uploadedFiles.length} file(s)`,
      files: uploadedFiles
    });
    
  } catch (error) {
    console.error('Error uploading files:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Download file
router.get('/download', async (req, res) => {
  try {
    const requestedPath = req.query.path;
    
    if (!requestedPath) {
      return res.status(400).json({
        success: false,
        error: 'File path is required'
      });
    }
    
    const fullPath = await validatePath(requestedPath);
    
    // Check if file exists
    try {
      const stats = await fs.stat(fullPath);
      
      if (stats.isDirectory()) {
        // For directories, create a zip archive
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        res.attachment(`${path.basename(fullPath)}.zip`);
        archive.pipe(res);
        
        archive.directory(fullPath, false);
        await archive.finalize();
        
        console.log(`📦 Downloaded directory as zip: ${fullPath}`);
      } else {
        // For files, send directly
        res.download(fullPath, path.basename(fullPath));
        console.log(`📥 Downloaded file: ${fullPath}`);
      }
      
    } catch {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete files/folders
router.delete('/delete', async (req, res) => {
  try {
    const { paths } = req.body;
    
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Paths array is required'
      });
    }
    
    const deletedItems = [];
    const errors = [];
    
    for (const requestedPath of paths) {
      try {
        const fullPath = await validatePath(requestedPath);
        const stats = await fs.stat(fullPath);
        
        if (stats.isDirectory()) {
          await fs.rmdir(fullPath, { recursive: true });
        } else {
          await fs.unlink(fullPath);
        }
        
        deletedItems.push(requestedPath);
        console.log(`🗑️ Deleted: ${fullPath}`);
        
      } catch (error) {
        errors.push({
          path: requestedPath,
          error: error.message
        });
      }
    }
    
    res.json({
      success: errors.length === 0,
      deleted: deletedItems,
      errors: errors,
      message: `Successfully deleted ${deletedItems.length} item(s)`
    });
    
  } catch (error) {
    console.error('Error deleting items:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Rename file/folder
router.put('/rename', async (req, res) => {
  try {
    const { path: requestedPath, newName } = req.body;
    
    if (!requestedPath || !newName) {
      return res.status(400).json({
        success: false,
        error: 'Path and new name are required'
      });
    }
    
    // Validate new name for invalid characters (Windows file system restrictions)
    const invalidChars = /[\\/:*?"<>|]/;
    if (invalidChars.test(newName)) {
      return res.status(400).json({
        success: false,
        error: 'A file name can\'t contain any of the following characters: \\ / : * ? " < > |'
      });
    }
    
    // Additional validation for newName
    const trimmedName = newName.trim();
    if (trimmedName.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'File name cannot be empty'
      });
    }
    
    if (trimmedName.endsWith('.')) {
      return res.status(400).json({
        success: false,
        error: 'File name cannot end with a period'
      });
    }
    
    // Check for reserved Windows names
    const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    const nameWithoutExt = trimmedName.split('.')[0];
    if (reservedNames.test(nameWithoutExt)) {
      return res.status(400).json({
        success: false,
        error: 'This is a reserved system name and cannot be used'
      });
    }
    
    const fullPath = await validatePath(requestedPath);
    const parentDir = path.dirname(fullPath);
    const newPath = path.join(parentDir, trimmedName);
    
    // Check if target already exists
    try {
      await fs.access(newPath);
      return res.status(409).json({
        success: false,
        error: 'A file or folder with this name already exists'
      });
    } catch {
      // Target doesn't exist, continue with rename
    }
    
    await fs.rename(fullPath, newPath);
    
    const relativePath = path.relative(getMountPath(), newPath);
    const fileInfo = await getFileStats(newPath, relativePath);
    
    console.log(`✏️ Renamed: ${fullPath} -> ${newPath}`);
    
    res.json({
      success: true,
      message: 'Item renamed successfully',
      item: fileInfo
    });
    
  } catch (error) {
    console.error('Error renaming item:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Copy files/folders
router.post('/copy', async (req, res) => {
  try {
    const { sources, destination } = req.body;
    
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Sources array is required'
      });
    }
    
    const destPath = await validatePath(destination);
    const copiedItems = [];
    const errors = [];
    
    for (const sourcePath of sources) {
      try {
        const fullSourcePath = await validatePath(sourcePath);
        const itemName = path.basename(fullSourcePath);
        const fullDestPath = path.join(destPath, itemName);
        
        const stats = await fs.stat(fullSourcePath);
        
        if (stats.isDirectory()) {
          await fs.cp(fullSourcePath, fullDestPath, { recursive: true });
        } else {
          await fs.copyFile(fullSourcePath, fullDestPath);
        }
        
        const relativePath = path.relative(getMountPath(), fullDestPath);
        const fileInfo = await getFileStats(fullDestPath, relativePath);
        
        if (fileInfo) {
          copiedItems.push(fileInfo);
        }
        
        console.log(`📋 Copied: ${fullSourcePath} -> ${fullDestPath}`);
        
      } catch (error) {
        errors.push({
          path: sourcePath,
          error: error.message
        });
      }
    }
    
    res.json({
      success: errors.length === 0,
      copied: copiedItems,
      errors: errors,
      message: `Successfully copied ${copiedItems.length} item(s)`
    });
    
  } catch (error) {
    console.error('Error copying items:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Move files/folders
router.put('/move', async (req, res) => {
  try {
    const { sources, destination } = req.body;
    
    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Sources array is required'
      });
    }
    
    const destPath = await validatePath(destination);
    const movedItems = [];
    const errors = [];
    
    for (const sourcePath of sources) {
      try {
        const fullSourcePath = await validatePath(sourcePath);
        const itemName = path.basename(fullSourcePath);
        const fullDestPath = path.join(destPath, itemName);
        
        await fs.rename(fullSourcePath, fullDestPath);
        
        const relativePath = path.relative(getMountPath(), fullDestPath);
        const fileInfo = await getFileStats(fullDestPath, relativePath);
        
        if (fileInfo) {
          movedItems.push(fileInfo);
        }
        
        console.log(`📦 Moved: ${fullSourcePath} -> ${fullDestPath}`);
        
      } catch (error) {
        errors.push({
          path: sourcePath,
          error: error.message
        });
      }
    }
    
    res.json({
      success: errors.length === 0,
      moved: movedItems,
      errors: errors,
      message: `Successfully moved ${movedItems.length} item(s)`
    });
    
  } catch (error) {
    console.error('Error moving items:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get storage information
router.get('/storage', async (req, res) => {
  try {
    const requestedPath = req.query.path || '';
    const fullPath = await validatePath(requestedPath);
    
    // For Unix-like systems, we can use statvfs, but for cross-platform compatibility
    // we'll implement a basic version using available Node.js APIs
    
    // Get directory size (this is a simplified version)
    let totalSize = 0;
    let fileCount = 0;
    let folderCount = 0;
    
    const calculateSize = async (dirPath) => {
      try {
        const items = await fs.readdir(dirPath);
        
        for (const item of items) {
          const itemPath = path.join(dirPath, item);
          const itemStats = await fs.stat(itemPath);
          
          if (itemStats.isDirectory()) {
            folderCount++;
            await calculateSize(itemPath);
          } else {
            fileCount++;
            totalSize += itemStats.size;
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    };
    
    await calculateSize(fullPath);
    
    res.json({
      success: true,
      storage: {
        path: requestedPath,
        totalSize,
        fileCount,
        folderCount,
        lastUpdated: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Error getting storage info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Search files
router.get('/search', async (req, res) => {
  try {
    const { query, path: searchPath = '', type = 'all' } = req.query;
    
    if (!query || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Search query is required'
      });
    }
    
    const fullPath = await validatePath(searchPath);
    const results = [];
    
    const searchRecursive = async (dirPath, depth = 0) => {
      // Limit search depth to prevent excessive recursion
      if (depth > 10) return;
      
      try {
        const items = await fs.readdir(dirPath);
        
        for (const item of items) {
          const itemPath = path.join(dirPath, item);
          const relativePath = path.relative(getMountPath(), itemPath);
          
          // Check if item name matches search query
          if (item.toLowerCase().includes(query.toLowerCase())) {
            const fileInfo = await getFileStats(itemPath, relativePath);
            
            if (fileInfo && (type === 'all' || fileInfo.type === type)) {
              results.push(fileInfo);
            }
          }
          
          // Continue searching in subdirectories
          try {
            const itemStats = await fs.stat(itemPath);
            if (itemStats.isDirectory()) {
              await searchRecursive(itemPath, depth + 1);
            }
          } catch {
            // Skip inaccessible items
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    };
    
    await searchRecursive(fullPath);
    
    res.json({
      success: true,
      query,
      results,
      count: results.length
    });
    
  } catch (error) {
    console.error('Error searching files:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
