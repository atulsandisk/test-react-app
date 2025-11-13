import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Import NFS manager for dynamic root path
let nfsManager;

// Async function to get NFS manager (avoid circular imports)
async function getNFSManager() {
  if (!nfsManager) {
    nfsManager = (await import('./nfsManager.js')).default;
  }
  return nfsManager;
}

/**
 * Get the current filesystem root (NFS user-specific path ONLY)
 */
export async function getFilesystemRoot() {
  const manager = await getNFSManager();
  const status = manager.getStatus();
  
  // Try to get current user ID from auth context
  let currentUser = status.currentUsername;
  if (!currentUser) {
    try {
      const { getCurrentUserId } = await import('./chat.js');
      currentUser = getCurrentUserId();
    } catch (error) {
      console.warn('Could not get current user from auth context:', error.message);
    }
  }
  
  // ONLY return user-specific path - no fallbacks to generic mount points
  if (!currentUser) {
    console.warn('No user context available - filesystem requires user-specific NFS path');
    return null;
  }
  
  // If NFS is mounted and we have a user, return the mount point (X:)
  // Since we mount user-specific path directly to X:
  if (status.isNFSMounted && currentUser) {
    return status.nfsMountPoint; // X: is the user's directory
  }
  
  // If NFS is not mounted but we have a user, return null (NFS should be mounted during login only)
  console.warn(`NFS not mounted for user (${currentUser}) - NFS must be mounted during login`);
  return null;
}

export const ensureDirectoryExists = async (dirPath) => {
  if (!dirPath || typeof dirPath !== 'string' || dirPath.trim() === '') {
    throw new Error('Invalid directory path provided');
  }
  
  // Normalize the path to handle any path resolution issues
  const normalizedPath = path.resolve(dirPath);
  console.log('Ensuring directory exists:', normalizedPath);
  
  try {
    // Check if path seems invalid
    if (normalizedPath.includes('\\?') || normalizedPath.length < 3) {
      throw new Error(`Invalid directory path: ${normalizedPath}`);
    }
    
    await fs.access(normalizedPath);
    console.log('Directory already exists:', normalizedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('Creating directory:', normalizedPath);
      await fs.mkdir(normalizedPath, { recursive: true });
      console.log('Directory created successfully:', normalizedPath);
    } else {
      throw error;
    }
  }
};

export const validatePath = async (userPath) => {
  const filesystemRoot = await getFilesystemRoot();
  
  if (!userPath || userPath === '' || userPath === '/') {
    return filesystemRoot;
  }
  
  const cleanPath = userPath.replace(/\.\./g, '').replace(/^\/+/, '');
  const safePath = path.resolve(filesystemRoot, cleanPath);
  console.log('validatePath:', { userPath, cleanPath, safePath, filesystemRoot });
  
  return safePath.startsWith(path.resolve(filesystemRoot)) ? safePath : null;
};

// For backward compatibility, also export as a getter property
export const getFilesystemRootPath = async () => await getFilesystemRoot();

// Export FILESYSTEM_ROOT_PATH for compatibility
export async function FILESYSTEM_ROOT_PATH() {
  return await getFilesystemRoot();
}

/**
 * Get filesystem status
 */
export async function getFilesystemStatus() {
  const manager = await getNFSManager();
  return manager.getStatus();
}