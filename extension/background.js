// Background service worker for Raindrop.io bookmarks sync

// Debug logging system
const DEBUG_MODE = false; // Set to true for development
const Logger = {
  debug: (...args) => DEBUG_MODE && console.log('[DEBUG]', ...args),
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
};

// Constants
const CONSTANTS = {
  MAX_AUTO_BACKUPS: 10,
  BATCH_CHUNK_SIZE: 50,
  MAX_RETRIES: 5,
  MIN_RETRY_DELAY: 1000,
  BOOKMARKS_PER_PAGE: 100,
  DEFAULT_SYNC_INTERVAL: 5
};

// Smart Defaults - Applied on first install for better UX
const SMART_DEFAULTS = {
  // Sync Settings
  syncEnabled: true,
  syncIntervalMinutes: 15, // Balanced: not too frequent, not too slow
  twoWayMode: 'additions_only', // Safest: won't delete anything

  // Target Settings
  targetFolderId: '1', // Bookmarks Bar (most common)
  useSubfolder: false, // Direct to bar (simpler)

  // OAuth Settings
  managedOAuth: true, // Easiest setup (no client ID/secret needed)
  managedOAuthBaseUrl: 'https://rdoauth.daiquiri.dev',

  // Collection Settings
  collectionMode: 'parentOnly', // Safer: no deep nesting
  collectionsSort: 'alpha_asc', // Predictable ordering
  bookmarksSort: 'created_desc', // Recent first

  // Rate Limiting
  rateLimitRpm: 60, // Conservative

  // Features
  autoBackupEnabled: true, // Safety first!
  createBackupBeforeSync: true, // Extra safety

  // UI Preferences
  hasSeenWelcome: false, // Show welcome on first run
  interfaceMode: 'simple' // Start with simple mode
};

class GoogleDriveSync {
  constructor() {
    this.SYNC_ALARM_NAME = 'googleDriveSync';
    this.DEFAULT_SYNC_MINUTES = 15;
    this.driveAPI = new DriveAPI();
  }

  async initialize() {
    const { syncIntervalMinutes } = await chrome.storage.sync.get(['syncIntervalMinutes']);
    const minutes = Math.max(1, Number(syncIntervalMinutes) || this.DEFAULT_SYNC_MINUTES);

    await chrome.alarms.clear(this.SYNC_ALARM_NAME);
    chrome.alarms.create(this.SYNC_ALARM_NAME, { periodInMinutes: minutes });

    const token = await this.driveAPI.getAuthToken();
    if (token) {
      await this.syncBookmarks();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.syncIntervalMinutes) {
        const newMinutes = Math.max(1, Number(changes.syncIntervalMinutes.newValue) || this.DEFAULT_SYNC_MINUTES);
        chrome.alarms.clear(this.SYNC_ALARM_NAME).then(() => {
          chrome.alarms.create(this.SYNC_ALARM_NAME, { periodInMinutes: newMinutes });
        });
      }
    });
  }

  async syncBookmarks() {
    if (this._syncInProgress) {
      Logger.debug('Sync already in progress, skipping...');
      return;
    }

    this._syncInProgress = true;
    Logger.info('Starting Google Drive sync...');

    try {
      const token = await this.driveAPI.getAuthToken(true);
      if (!token) {
        throw new Error('Authentication required');
      }

      let syncData = await this.driveAPI.getSyncData();
      if (!syncData) {
        syncData = { lastSync: null, bookmarks: [] };
      }

      // Reconcile bookmarks
      const localBookmarks = await this.getAllBookmarksRecursively();
      const newSyncData = this.reconcile(localBookmarks, syncData.bookmarks);
      
      await this.driveAPI.saveSyncData({
        lastSync: new Date().toISOString(),
        bookmarks: newSyncData
      });

      Logger.info('Google Drive sync completed successfully');
    } catch (error) {
      Logger.error('Google Drive sync failed:', error);
    } finally {
      this._syncInProgress = false;
    }
  }

  reconcile(local, remote) {
    // This is a simplified reconciliation logic.
    // A real implementation would be more complex, handling merges, conflicts, etc.
    // For now, we'll just merge the two lists and remove duplicates.
    const all = [...local, ...remote];
    const byUrl = new Map();
    for (const bm of all) {
      if (bm.url) {
        byUrl.set(bm.url, bm);
      }
    }
    return Array.from(byUrl.values());
  }

  async getAllBookmarksRecursively() {
    try {
      const tree = await chrome.bookmarks.getTree();
      const bookmarks = [];
      function extractBookmarks(nodes) {
        for (const node of nodes) {
          if (node.url) {
            bookmarks.push({ id: node.id, url: node.url, title: node.title, parentId: node.parentId, dateAdded: node.dateAdded });
          } else if (node.children) {
            extractBookmarks(node.children);
          }
        }
      }
      extractBookmarks(tree);
      return bookmarks;
    } catch (error) {
      console.error('Error getting all bookmarks:', error);
      return [];
    }
  }
}

// Initialize the sync manager
const syncManager = new GoogleDriveSync();

// Event listeners
chrome.runtime.onStartup.addListener(() => {
  syncManager.initialize();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    Logger.info('First install detected - applying smart defaults');
    await chrome.storage.sync.set(SMART_DEFAULTS);
  }
  syncManager.initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === syncManager.SYNC_ALARM_NAME) {
    syncManager.syncBookmarks();
  }
});

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'syncNow') {
    syncManager.syncBookmarks()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
  return false;
});

// Initialize the sync manager
const syncManager = new RaindropSync();

// Event listeners
chrome.runtime.onStartup.addListener(() => {
  syncManager.initialize();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  // Apply smart defaults on fresh install
  if (details.reason === 'install') {
    Logger.info('First install detected - applying smart defaults');

    // Check if settings already exist (shouldn't on fresh install)
    const existing = await chrome.storage.sync.get(Object.keys(SMART_DEFAULTS));
    const needsDefaults = Object.keys(existing).length === 0;

    if (needsDefaults) {
      await chrome.storage.sync.set(SMART_DEFAULTS);
      Logger.info('Smart defaults applied successfully');
    }
  }

  // Initialize sync manager
  syncManager.initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === syncManager.SYNC_ALARM_NAME) {
    syncManager.syncBookmarks();
  }
});

// Message handler for options page communication
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background: Received message:', request.action);

  if (request.action === 'syncNow') {
    syncManager.syncBookmarks()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }

  if (request.action === 'getAuthStatus') {
    console.log('🔐 Background: getAuthStatus request received');
    chrome.storage.sync.get(['accessToken'])
      .then(({ accessToken }) => {
        const isAuthenticated = !!accessToken;
        console.log(`🔐 Background: Token exists: ${!!accessToken}, responding with authenticated: ${isAuthenticated}`);
        sendResponse({ authenticated: isAuthenticated });
      })
      .catch((error) => {
        console.error('🔐 Background: getAuthStatus error:', error);
        sendResponse({ authenticated: false, error: error.message });
      });
    return true;
  }

  if (request.action === 'cleanupDuplicates') {
    syncManager.getTargetRootId()
      .then((rootFolderId) => {
        console.log('cleanupDuplicates: got rootFolderId:', rootFolderId);
        return syncManager.cleanupAllDuplicates(rootFolderId);
      })
      .then((duplicatesRemoved) => {
        console.log('cleanupDuplicates: completed, removed:', duplicatesRemoved);
        sendResponse({ success: true, duplicatesRemoved: duplicatesRemoved || 0 });
      })
      .catch((error) => {
        console.error('cleanupDuplicates error:', error);
        sendResponse({ success: false, error: error?.message || 'Cleanup operation failed' });
      });
    return true; // Keep message channel open for async response
  }

  if (request.action === 'clearAllBookmarks') {
    syncManager.clearAllSyncedBookmarks()
      .then((result) => {
        console.log('clearAllBookmarks: completed, result:', result);
        const bookmarksDeleted = result?.bookmarksDeleted || 0;
        sendResponse({ success: true, bookmarksDeleted });
      })
      .catch((error) => {
        console.error('clearAllBookmarks error:', error);
        sendResponse({ success: false, error: error?.message || 'Clear operation failed' });
      });
    return true; // Keep message channel open for async response
  }
});
// Temporarily disable Managed OAuth flow in background
const MANAGED_OAUTH_ENABLED = true;
