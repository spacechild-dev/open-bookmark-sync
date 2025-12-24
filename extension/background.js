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

class RaindropSync {
  constructor() {
    this.SYNC_ALARM_NAME = 'raindropSync';
    this.API_BASE = 'https://api.raindrop.io/rest/v1';
    this.DEFAULT_SYNC_MINUTES = 15; // Updated to match SMART_DEFAULTS
    this.DEFAULT_TARGET_FOLDER_ID = '1';
    this.SYNC_ROOT_FOLDER_NAME = 'Raindrop.io';
    this.DEFAULT_USE_SUBFOLDER = false;
    this.DEFAULT_TWO_WAY_MODE = 'additions_only';
    this.RATE_LIMIT_RPM_DEFAULT = 60;
    this._lastRequestAt = 0;
    this._syncInProgress = false;
    this.MANAGED_OAUTH_ENABLED = true;
  }

  async initialize() {
    // Read interval from settings, default to 5 minutes
    const { syncIntervalMinutes } = await chrome.storage.sync.get(['syncIntervalMinutes']);
    const minutes = Math.max(1, Number(syncIntervalMinutes) || this.DEFAULT_SYNC_MINUTES);

    // Set up or update alarm
    await chrome.alarms.clear(this.SYNC_ALARM_NAME);
    chrome.alarms.create(this.SYNC_ALARM_NAME, { periodInMinutes: minutes });

    // Initial sync on startup if authenticated
    const { accessToken } = await chrome.storage.sync.get(['accessToken']);
    if (accessToken) {
      await this.syncBookmarks();
    }

    // Watch for settings changes to reschedule alarm
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.syncIntervalMinutes) {
        const newMinutes = Math.max(1, Number(changes.syncIntervalMinutes.newValue) || this.DEFAULT_SYNC_MINUTES);
        chrome.alarms.clear(this.SYNC_ALARM_NAME).then(() => {
          chrome.alarms.create(this.SYNC_ALARM_NAME, { periodInMinutes: newMinutes });
        });
      }
    });
  }

  async syncBookmarks() {
    // Prevent concurrent syncs
    if (this._syncInProgress) {
      Logger.debug('Sync already in progress, skipping...');
      return;
    }

    this._syncInProgress = true;

    try {
      Logger.info('Starting Raindrop sync...');

      // Check if sync is enabled
      const { syncEnabled = true } = await chrome.storage.sync.get(['syncEnabled']);
      if (!syncEnabled) {
        console.log('Sync is disabled, skipping sync');
        return;
      }

      // Check if we have valid credentials
      const config = await chrome.storage.sync.get(['clientId', 'clientSecret', 'accessToken', 'refreshToken']);

      if (!config.accessToken) {
        console.log('No access token, skipping sync');
        return;
      }

      // Ensure we have a valid token
      const validToken = await this.ensureValidToken();
      if (!validToken) {
        console.error('Failed to get valid access token');
        return;
      }

      // Get collections from Raindrop
      let collections = await this.fetchCollections();

      // Filter collections per user settings
      const { topLevelOnly = true, selectedCollectionIds = [], collectionImportMode = 'topLevel' } = await chrome.storage.sync.get(['topLevelOnly','selectedCollectionIds','collectionImportMode']);
      collections = (collections || []).filter(c => c && c._id >= 0);

      // Use new collection import mode system
      const collectionMode = collectionImportMode || (topLevelOnly ? 'topLevel' : 'custom');

      if (collectionMode === 'topLevel') {
        // Top-level only mode: import only parent collections
        collections = collections.filter(c => !this.hasParent(c));
        console.log(`Filtered to ${collections.length} top-level collections`);
      } else if (collectionMode === 'custom' && Array.isArray(selectedCollectionIds) && selectedCollectionIds.length > 0) {
        // Manual selection mode: import only selected collections
        const idSet = new Set(selectedCollectionIds.map(String));
        collections = collections.filter(c => idSet.has(String(c._id)));
        console.log(`Filtered to ${collections.length} manually selected collections`);
      } else if (collectionMode === 'all') {
        // Import all collections including sub-collections
        console.log(`Importing all ${collections.length} collections (including sub-collections)`);
      } else {
        // Fallback: if custom mode but no selections, use top-level only
        collections = collections.filter(c => !this.hasParent(c));
        console.log(`Fallback: No collections selected in custom mode, using ${collections.length} top-level collections`);
      }

      // Apply collections sort preference (for create-order and optional reorder)
      const { collectionsSort = 'alpha_asc', bookmarksSort = 'created_desc' } = await chrome.storage.sync.get(['collectionsSort','bookmarksSort']);

      // Build hierarchical structure if needed
      const hierarchicalCollections = this.buildCollectionHierarchy(collections);
      collections = this.flattenHierarchy(hierarchicalCollections);
      collections = this.sortCollections(collections, collectionsSort);

      // Decide root: direct to selected folder (default: Bookmarks Bar), optional subfolder
      const rootFolderId = await this.getTargetRootId();

      // Check for extension update and cleanup duplicates if needed
      await this.checkForExtensionUpdate(rootFolderId);

      const { twoWayMode } = await chrome.storage.sync.get(['twoWayMode']);
      const syncMode = twoWayMode || this.DEFAULT_TWO_WAY_MODE;

      // Use a unified reconciler for all modes.
      // mode:
      // - mirror: add/update/delete, reorder if requested
      // - additions_only: add missing only, no delete/reorder
      // - off: one-way Raindrop -> Browser (add missing only)
      // - upload_only: one-way Browser -> Raindrop (no local adds)
      await this.syncCollectionsAtRoot(rootFolderId, collections, { collectionsSort, bookmarksSort, syncMode });

      // Update last sync time
      await chrome.storage.sync.set({ lastSyncTime: Date.now() });

      Logger.info('Raindrop sync completed successfully');

    } catch (error) {
      Logger.error('Sync failed:', error);

      // If authentication error, clear tokens
      if (error.message && error.message.includes('401')) {
        await chrome.storage.sync.remove(['accessToken', 'refreshToken']);
      }
    } finally {
      // Always release sync lock
      this._syncInProgress = false;
    }
  }

  async ensureValidToken() {
    const config = await chrome.storage.sync.get(['accessToken', 'refreshToken', 'clientId', 'clientSecret', 'managedOAuth', 'managedOAuthBaseUrl']);

    // Test current token
    try {
      const response = await this.apiFetch(`${this.API_BASE}/user`, {
        headers: {
          'Authorization': `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        return config.accessToken;
      }
    } catch (error) {
      console.log('Token validation failed, attempting refresh');
    }

    // Try to refresh token if we have a refresh token
    if (config.refreshToken) {
      try {
        let refreshResponse;
        if ((config.managedOAuth && this.MANAGED_OAUTH_ENABLED) || (!config.clientSecret && config.managedOAuthBaseUrl)) {
          const base = (config.managedOAuthBaseUrl || 'https://rdoauth.daiquiri.dev').replace(/\/$/, '');
          refreshResponse = await this.apiFetch(base + '/token/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: config.refreshToken })
          });
        } else {
          refreshResponse = await this.apiFetch('https://raindrop.io/oauth/access_token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              refresh_token: config.refreshToken,
              grant_type: 'refresh_token'
            })
          });
        }

        if (refreshResponse.ok) {
          const tokenData = await refreshResponse.json();
          await chrome.storage.sync.set({
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token || config.refreshToken
          });
          return tokenData.access_token;
        }
      } catch (error) {
        console.error('Token refresh failed:', error);
      }
    }

    return null;
  }

  async fetchCollections() {
    const { accessToken } = await chrome.storage.sync.get(['accessToken']);

    // Fetch root collections
    const response = await this.apiFetch(`${this.API_BASE}/collections`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch collections: ${response.status}`);
    }

    const data = await response.json();
    let items = data.items || [];

    // Fetch child collections
    try {
      const childResponse = await this.apiFetch(`${this.API_BASE}/collections/childrens`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (childResponse.ok) {
        const childData = await childResponse.json();
        const childItems = childData.items || [];
        console.log(`Fetched ${items.length} root collections and ${childItems.length} child collections`);

        // Merge root and child collections, removing duplicates
        const mergedItems = [...items, ...childItems];
        // Remove duplicates based on collection ID
        const uniqueItems = new Map();
        mergedItems.forEach(item => {
          if (item && item._id) {
            uniqueItems.set(item._id, item);
          }
        });
        items = Array.from(uniqueItems.values());
        console.log(`After deduplication: ${items.length} unique collections`);
      } else {
        console.warn('Failed to load child collections:', childResponse.status);
      }
    } catch (error) {
      console.warn('Error fetching child collections:', error);
    }

    return items;
  }

  hasParent(c) {
    try {
      if (!c) return false;
      if (c.parentId) return true;
      if (c.parent && (c.parent.$id || c.parent.id)) return true;
      return false;
    } catch (_) { return false; }
  }

  getParentId(c) {
    try {
      // Check various possible parent field formats
      let parentId = null;

      // Check all possible parent field variations
      const possibleFields = [
        c.parent?.$id,
        c.parent?.id,
        c.parent?._id,
        c.parentId,
        c.parent_id,
        c.parent
      ];

      for (const field of possibleFields) {
        if (field && (typeof field === 'number' || typeof field === 'string')) {
          parentId = field;
          break;
        }
      }

      // Convert to number if it's a string number
      if (parentId && typeof parentId === 'string' && !isNaN(parentId)) {
        parentId = parseInt(parentId);
      }

      return parentId;
    } catch (e) {
      console.error('Error getting parent ID:', e);
      return null;
    }
  }

  buildCollectionHierarchy(collections) {
    const itemsById = new Map();
    const roots = [];

    // First pass: create items map
    for (const c of collections) {
      itemsById.set(c._id, { ...c, children: [] });
    }

    // Second pass: build hierarchy
    for (const c of collections) {
      const item = itemsById.get(c._id);
      const parentId = this.getParentId(c);

      if (parentId && itemsById.has(parentId)) {
        itemsById.get(parentId).children.push(item);
      } else {
        roots.push(item);
      }
    }

    return roots;
  }

  flattenHierarchy(hierarchy, level = 0) {
    const result = [];

    for (const item of hierarchy) {
      // Add level information for folder creation
      const flatItem = { ...item, level };
      delete flatItem.children; // Remove children array for clean collection object
      result.push(flatItem);

      // Recursively add children
      if (item.children && item.children.length > 0) {
        result.push(...this.flattenHierarchy(item.children, level + 1));
      }
    }

    return result;
  }

  async fetchRaindrops(collectionId) {
    const { accessToken } = await chrome.storage.sync.get(['accessToken']);

    let page = 0;
    const perPage = 100; // Increased from 50 to 100 for faster loading
    let items = [];
    let total = Infinity;
    while (page * perPage < total) {
      const url = new URL(`${this.API_BASE}/raindrops/${collectionId}`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('perpage', String(perPage));
      // Prefer newest first to minimize later moves when default is created_desc
      url.searchParams.set('sort', '-created');
      const response = await this.apiFetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch raindrops: ${response.status}`);
      }
      const data = await response.json();
      const pageItems = data.items || [];
      items.push(...pageItems);
      total = data.count || pageItems.length;
      page += 1;
      if (pageItems.length === 0) break;
    }
    return items;
  }

  async clearFolderContents(parentFolderId) {
    try {
      const children = await chrome.bookmarks.getChildren(parentFolderId);
      for (const item of children) {
        if (item.children !== undefined) {
          await chrome.bookmarks.removeTree(item.id);
        } else {
          await chrome.bookmarks.remove(item.id);
        }
      }
    } catch (error) {
      console.error('Failed to clear sync folder contents:', error);
    }
  }

  async createCollectionFolder(parentFolderId, collection, { bookmarksSort = 'created_desc' } = {}) {
    try {
      // Skip system collections
      if (collection._id < 0) return;

      // Create folder for collection
      const folder = await chrome.bookmarks.create({
        parentId: parentFolderId,
        title: collection.title
      });

      // Get raindrops (bookmarks) for this collection
      let raindrops = await this.fetchRaindrops(collection._id);
      raindrops = this.sortRaindrops(raindrops, bookmarksSort);

      // Add all raindrops as bookmarks in parallel for faster loading
      const bookmarkPromises = raindrops
        .filter(raindrop => raindrop.link)
        .map(raindrop =>
          chrome.bookmarks.create({
            parentId: folder.id,
            title: raindrop.title || raindrop.link,
            url: raindrop.link
          })
        );

      // Wait for all bookmarks to be created in parallel
      await Promise.all(bookmarkPromises);

    } catch (error) {
      console.error(`Failed to create folder for collection ${collection.title}:`, error);
    }
  }

  async getOrCreateSyncRootFolder(parentIdOverride) {
    const { syncRootFolderName } = await chrome.storage.sync.get(['syncRootFolderName']);
    const parentId = (parentIdOverride && String(parentIdOverride)) || this.DEFAULT_TARGET_FOLDER_ID;
    const rootName = (syncRootFolderName && String(syncRootFolderName).trim()) || this.SYNC_ROOT_FOLDER_NAME;

    // Try to find existing folder with the given name under parent
    try {
      const siblings = await chrome.bookmarks.getChildren(parentId);
      const existing = siblings.find(n => !n.url && n.title === rootName);
      if (existing) return existing.id;
    } catch (e) {
      console.warn('Could not read target parent folder, fallback to Bookmarks Bar:', e);
    }

    // Create it if not found
    const created = await chrome.bookmarks.create({ parentId, title: rootName });
    return created.id;
  }

  async getTargetRootId() {
    console.log('getTargetRootId: Starting...');
    const { targetFolderId, useSubfolder } = await chrome.storage.sync.get(['targetFolderId', 'useSubfolder']);
    const parentId = (targetFolderId && String(targetFolderId)) || this.DEFAULT_TARGET_FOLDER_ID;
    const inSubfolder = (typeof useSubfolder === 'boolean') ? useSubfolder : this.DEFAULT_USE_SUBFOLDER;
    console.log('getTargetRootId: parentId:', parentId, 'inSubfolder:', inSubfolder);

    let finalId;
    if (inSubfolder) {
      finalId = await this.getOrCreateSyncRootFolder(parentId);
    } else {
      finalId = parentId;
    }
    console.log('getTargetRootId: Final result:', finalId);
    return finalId;
  }

  async syncCollectionsAtRoot(rootFolderId, collections, { collectionsSort = 'alpha_asc', bookmarksSort = 'created_desc', syncMode = this.DEFAULT_TWO_WAY_MODE } = {}) {
    try {
      // Load mapping and clean up stale entries
      const mapObj = await chrome.storage.local.get(['rdMapRaindropToBookmark', 'rdMapCollectionToFolder']);
      const rdMap = mapObj.rdMapRaindropToBookmark || {};
      const folderMap = mapObj.rdMapCollectionToFolder || {};
      await this.cleanupMapping(rdMap);
      await this.cleanupFolderMapping(folderMap);

      // Process each collection with hierarchy support
      const createdFolders = new Map(); // Track created folders by collection ID
      const processedCollections = new Set(); // Track processed collections to prevent duplicates
      console.log(`Processing ${collections.length} collections:`, collections.map(c => `${c.title} (${c._id})`));

      for (const collection of collections) {
        if (collection._id < 0) continue; // skip system collections

        // Skip if we've already processed this collection
        if (processedCollections.has(collection._id)) {
          console.log(`Skipping duplicate collection: ${collection.title} (${collection._id})`);
          continue;
        }
        processedCollections.add(collection._id);

        // Determine parent folder ID based on hierarchy
        let parentFolderId = rootFolderId;

        // If this collection has a parent, find the parent folder
        const parentId = this.getParentId(collection);
        if (parentId && createdFolders.has(parentId)) {
          parentFolderId = createdFolders.get(parentId);
        }

        // Try to get folder from collection mapping first, then fallback to title matching
        let folder = null;
        const mappedFolderId = folderMap[String(collection._id)];
        if (mappedFolderId) {
          try {
            const [mappedFolder] = await chrome.bookmarks.get(mappedFolderId);
            if (mappedFolder && !mappedFolder.url) {
              folder = mappedFolder;
              console.log(`Found folder via mapping: ${collection.title} -> ${folder.title} (${folder.id})`);
            }
          } catch (e) {
            // Mapped folder doesn't exist anymore, clean up mapping
            delete folderMap[String(collection._id)];
            console.log(`Cleaned up stale mapping for collection ${collection._id}`);
          }
        }

        // Fallback: Check if we already created this folder in this sync session
        if (!folder && createdFolders.has(collection._id)) {
          const folderId = createdFolders.get(collection._id);
          try {
            const [existingFolder] = await chrome.bookmarks.get(folderId);
            if (existingFolder && !existingFolder.url) {
              folder = existingFolder;
              console.log(`Found folder from current sync session: ${collection.title} -> ${folder.title} (${folder.id})`);
            }
          } catch (e) {
            // Folder was deleted, remove from tracking
            createdFolders.delete(collection._id);
          }
        }

        // CRITICAL FIX: Check for existing folder by title in the current parent
        if (!folder) {
          try {
            const siblingsInParent = await chrome.bookmarks.getChildren(parentFolderId);
            const existingByTitle = siblingsInParent.find(node =>
              !node.url && node.title === collection.title
            );
            if (existingByTitle) {
              folder = existingByTitle;
              console.log(`Found existing folder by title: ${collection.title} (${folder.id}) in parent ${parentFolderId}`);
              // Update mappings to prevent future duplicates
              folderMap[String(collection._id)] = folder.id;
              createdFolders.set(collection._id, folder.id);
            }
          } catch (e) {
            console.warn(`Error checking for existing folder by title: ${e.message}`);
          }
        }

        // Create new folder if not found (hierarchical parent support)
        if (!folder) {
          if (syncMode === 'upload_only') {
            // Do not create local folders in upload-only mode
            continue;
          }
          console.log(`Creating new folder: ${collection.title} in parent ${parentFolderId}`);
          folder = await chrome.bookmarks.create({
            parentId: parentFolderId,
            title: collection.title
          });
          console.log(`Created folder: ${folder.title} (${folder.id})`);
        }

        // Map collection to folder for future reference
        folderMap[String(collection._id)] = folder.id;
        createdFolders.set(collection._id, folder.id);

        await this.reconcileFolderWithCollection(folder.id, collection, rdMap, { bookmarksSort, syncMode });
      }

      // Persist updated mappings
      await chrome.storage.local.set({
        rdMapRaindropToBookmark: rdMap,
        rdMapCollectionToFolder: folderMap
      });

      // Reorder collection folders relative to each other if requested
      if (syncMode === 'mirror' && collectionsSort && collectionsSort !== 'none') {
        const siblings = await chrome.bookmarks.getChildren(rootFolderId);
        const managed = siblings.filter(n => !n.url && collections.some(c => c.title === n.title));
        const desired = this.sortCollections([...collections], collectionsSort)
          .map(c => managed.find(n => n.title === c.title))
          .filter(Boolean);
        await this.applyOrder(rootFolderId, desired.map(n => n.id));
      }

    } catch (error) {
      console.error('Two-way sync failed:', error);
    }
  }

  async reconcileFolderWithCollection(folderId, collection, rdMap, { bookmarksSort = 'created_desc', syncMode = this.DEFAULT_TWO_WAY_MODE } = {}) {

    // Fetch current folder children
    const children = await chrome.bookmarks.getChildren(folderId);
    const bookmarks = children.filter(c => !!c.url);
    const byUrl = new Map();
    const byId = new Map();
    for (const b of bookmarks) { byUrl.set(b.url, b); byId.set(b.id, b); }

    // Remote indexes
    const remote = await this.fetchRaindrops(collection._id);
    const remoteByUrl = new Map();
    const remoteById = new Map();
    for (const r of remote) { remoteByUrl.set(r.link || r.url, r); remoteById.set(String(r._id), r); }

    // 1) Deletions
    if (syncMode === 'mirror') {
      for (const [raindropId, bookmarkId] of Object.entries(rdMap)) {
        const r = remoteById.get(String(raindropId));
        if (!r) continue; // remote already deleted
        if (r.collection && (r.collection.id || r.collection.$id) && String(r.collection.id || r.collection.$id) !== String(collection._id)) {
          continue;
        }
        if (!byId.has(String(bookmarkId))) {
          const url = r.link || r.url;
          const existing = url ? byUrl.get(url) : null;
          if (existing) {
            rdMap[String(raindropId)] = String(existing.id);
          } else {
            await this.deleteRaindrop(raindropId);
            delete rdMap[String(raindropId)];
            remoteById.delete(String(raindropId));
            if (url) remoteByUrl.delete(url);
          }
        }
      }
    }

    // 2) Ensure every remote raindrop exists locally (create/update)
    if (syncMode !== 'upload_only') {
      // Collect all bookmarks that need to be created for batch processing
      const bookmarksToCreate = [];
      const titleUpdates = [];

      for (const r of remote) {
        const url = r.link || r.url;
        if (!url) continue;

        // Check if this raindrop is already mapped to avoid duplicates
        const existingBookmarkId = rdMap[String(r._id)];
        if (existingBookmarkId && byId.has(existingBookmarkId)) {
          // Already mapped and exists, skip creation
          const existingBookmark = byId.get(existingBookmarkId);
          if (syncMode === 'mirror') {
            // Update title if changed (mirror mode only)
            const desiredTitle = r.title || url;
            if (existingBookmark.title !== desiredTitle) {
              await chrome.bookmarks.update(existingBookmark.id, { title: desiredTitle });
            }
          }
          continue;
        }

        let b = byUrl.get(url);
        if (!b) {
          // Double check - search all bookmarks in this folder for the same URL
          const existingByUrl = bookmarks.find(bm => bm.url === url);
          if (existingByUrl) {
            b = existingByUrl;
            byUrl.set(url, b);
          } else {
            // Global duplicate check: Search entire bookmark tree for this URL
            const globalDuplicates = await this.findBookmarksByUrl(url);
            if (globalDuplicates.length > 0) {
              // URL already exists elsewhere, map to existing bookmark to prevent duplicate
              const existingGlobal = globalDuplicates[0];
              b = existingGlobal;
              byUrl.set(url, b);
              byId.set(b.id, b);
              // Update mapping to existing bookmark
              rdMap[String(r._id)] = String(b.id);
              console.log(`Mapped existing bookmark (${b.id}) to prevent duplicate for URL: ${url}`);
            } else {
              // Queue bookmark for batch creation
              bookmarksToCreate.push({
                raindrop: r,
                url: url,
                title: r.title || url
              });
            }
          }
        } else if (syncMode === 'mirror') {
          // Queue title update for batch processing (mirror mode only)
          const desiredTitle = r.title || url;
          if (b.title !== desiredTitle) {
            titleUpdates.push({ id: b.id, title: desiredTitle });
          }
        }
        if (!bookmarksToCreate.some(item => item.raindrop === r)) {
          rdMap[String(r._id)] = String(b.id);
        }
      }

      // Batch create all new bookmarks with chunking for better performance
      if (bookmarksToCreate.length > 0) {
        Logger.debug(`Creating ${bookmarksToCreate.length} bookmarks in batches for faster sync`);

        // Process in chunks to avoid overwhelming the API
        const CHUNK_SIZE = CONSTANTS.BATCH_CHUNK_SIZE;
        const allCreatedBookmarks = [];

        for (let i = 0; i < bookmarksToCreate.length; i += CHUNK_SIZE) {
          const chunk = bookmarksToCreate.slice(i, i + CHUNK_SIZE);
          const createPromises = chunk.map(item =>
            chrome.bookmarks.create({
              parentId: folderId,
              title: item.title,
              url: item.url
            })
          );

          try {
            const createdBookmarks = await Promise.all(createPromises);
            allCreatedBookmarks.push(...createdBookmarks);

            // Update mappings and local indexes for created bookmarks
            createdBookmarks.forEach((bookmark, index) => {
              const item = chunk[index];
              rdMap[String(item.raindrop._id)] = String(bookmark.id);
              byUrl.set(item.url, bookmark);
              byId.set(bookmark.id, bookmark);
            });

            Logger.debug(`Created chunk ${Math.floor(i/CHUNK_SIZE) + 1}/${Math.ceil(bookmarksToCreate.length/CHUNK_SIZE)}: ${createdBookmarks.length} bookmarks`);
          } catch (error) {
            Logger.error('Batch bookmark creation failed for chunk:', error);
            // Fall back to individual creation for this chunk
            for (const item of chunk) {
              try {
                const bookmark = await chrome.bookmarks.create({
                  parentId: folderId,
                  title: item.title,
                  url: item.url
                });
                rdMap[String(item.raindrop._id)] = String(bookmark.id);
                byUrl.set(item.url, bookmark);
                byId.set(bookmark.id, bookmark);
              } catch (individualError) {
                Logger.warn('Failed to create individual bookmark:', item.url, individualError);
              }
            }
          }
        }

        Logger.info(`Successfully created ${allCreatedBookmarks.length} bookmarks total`);
      }

      // Batch update titles for better performance
      if (titleUpdates.length > 0) {
        console.log(`Updating ${titleUpdates.length} bookmark titles in batch`);
        const updatePromises = titleUpdates.map(update =>
          chrome.bookmarks.update(update.id, { title: update.title })
        );

        try {
          await Promise.all(updatePromises);
          console.log(`Successfully updated ${titleUpdates.length} bookmark titles`);
        } catch (error) {
          console.error('Batch title update failed:', error);
          // Fall back to individual updates if batch fails
          for (const update of titleUpdates) {
            try {
              await chrome.bookmarks.update(update.id, { title: update.title });
            } catch (individualError) {
              console.warn('Failed to update individual bookmark title:', update.id, individualError);
            }
          }
        }
      }
    }

    // Additional duplicate prevention: Clean up any unmapped duplicates in this folder
    await this.cleanupUnmappedDuplicates(folderId, rdMap);

    // 3) Local-only bookmarks -> create in Raindrop
    if (syncMode !== 'off') {
      for (const b of bookmarks) {
        // Skip if mapped or matches a remote URL
        if ([...Object.values(rdMap)].includes(String(b.id))) continue;
        if (remoteByUrl.has(b.url)) continue;
        try {
          const created = await this.createRaindrop(collection._id, { title: b.title, link: b.url });
          if (created && created.item && created.item._id) {
            rdMap[String(created.item._id)] = String(b.id);
          }
        } catch (e) {
          console.warn('Failed to create raindrop from local bookmark:', e);
        }
      }
    }

    // 4) Reorder within folder according to preference (mirror mode only)
    if (syncMode === 'mirror' && bookmarksSort && bookmarksSort !== 'none') {
      await this.reorderBookmarksInFolder(folderId, bookmarksSort, remoteByUrl);
    }
  }

  async createRaindrop(collectionId, { title, link }) {
    const token = await this.ensureValidToken();
    if (!token) throw new Error('No valid token');
    const res = await this.apiFetch('https://api.raindrop.io/rest/v1/raindrop', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, link, collection: { "$id": collectionId } })
    });
    if (!res.ok) throw new Error(`Create raindrop failed: ${res.status}`);
    return res.json();
  }

  async deleteRaindrop(raindropId) {
    const token = await this.ensureValidToken();
    if (!token) throw new Error('No valid token');
    const res = await this.apiFetch(`https://api.raindrop.io/rest/v1/raindrop/${raindropId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Delete raindrop failed: ${res.status}`);
    return true;
  }

  // ---------- Helpers: sorting, ordering, rate limiting ----------

  sortCollections(collections, mode = 'alpha_asc') {
    const list = [...(collections || [])];
    const norm = s => (s || '').toString().toLocaleLowerCase();
    switch (mode) {
      case 'alpha_desc':
        return list.sort((a,b) => norm(b.title).localeCompare(norm(a.title)));
      case 'raindrop':
        return list.sort((a,b) => (a.sort ?? a.order ?? 0) - (b.sort ?? b.order ?? 0));
      case 'alpha_asc':
      default:
        return list.sort((a,b) => norm(a.title).localeCompare(norm(b.title)));
    }
  }

  sortRaindrops(raindrops, mode = 'created_desc') {
    const list = [...(raindrops || [])];
    const norm = s => (s || '').toString().toLocaleLowerCase();
    const ts = d => (d ? new Date(d).getTime() : 0);
    const domain = url => {
      try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; }
    };
    switch (mode) {
      case 'created_asc':
        return list.sort((a,b) => ts(a.created) - ts(b.created));
      case 'alpha_asc':
        return list.sort((a,b) => norm(a.title || a.link).localeCompare(norm(b.title || b.link)));
      case 'alpha_desc':
        return list.sort((a,b) => norm(b.title || b.link).localeCompare(norm(a.title || a.link)));
      case 'domain_asc':
        return list.sort((a,b) => domain(a.link || a.url).localeCompare(domain(b.link || b.url)));
      case 'created_desc':
      default:
        return list.sort((a,b) => ts(b.created) - ts(a.created));
    }
  }

  async reorderBookmarksInFolder(folderId, bookmarksSort, remoteByUrl) {
    const children = await chrome.bookmarks.getChildren(folderId);
    const folders = children.filter(c => !c.url);
    const bookmarks = children.filter(c => !!c.url);

    const norm = s => (s || '').toString().toLocaleLowerCase();
    const ts = d => (d ? new Date(d).getTime() : 0);
    const domain = url => { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; } };

    let ordered = [...bookmarks];
    switch (bookmarksSort) {
      case 'alpha_asc':
        ordered.sort((a,b) => norm(a.title).localeCompare(norm(b.title))); break;
      case 'alpha_desc':
        ordered.sort((a,b) => norm(b.title).localeCompare(norm(a.title))); break;
      case 'domain_asc':
        ordered.sort((a,b) => domain(a.url).localeCompare(domain(b.url))); break;
      case 'created_asc':
        ordered.sort((a,b) => ts(remoteByUrl.get(a.url)?.created) - ts(remoteByUrl.get(b.url)?.created)); break;
      case 'created_desc':
      default:
        ordered.sort((a,b) => ts(remoteByUrl.get(b.url)?.created) - ts(remoteByUrl.get(a.url)?.created)); break;
    }

    const minIndex = Math.min(...bookmarks.map(b => b.index));
    await this.applyOrder(folderId, ordered.map(b => b.id), minIndex);
  }

  async applyOrder(parentId, orderedChildIds, startIndex) {
    if (!orderedChildIds || orderedChildIds.length === 0) return;
    // If startIndex unspecified, use current minimum index among these children
    if (startIndex === undefined) {
      const siblings = await chrome.bookmarks.getChildren(parentId);
      const indexes = siblings.filter(s => orderedChildIds.includes(s.id)).map(s => s.index);
      startIndex = indexes.length ? Math.min(...indexes) : 0;
    }
    let idx = startIndex;
    for (const id of orderedChildIds) {
      await chrome.bookmarks.move(id, { index: idx++ });
    }
  }

  async apiFetch(url, options = {}, attempt = 0) {
    const { rateLimitRpm } = await chrome.storage.sync.get(['rateLimitRpm']);
    const rpm = Math.max(1, Number(rateLimitRpm) || this.RATE_LIMIT_RPM_DEFAULT);
    const minInterval = Math.ceil(60000 / rpm);

    const now = Date.now();
    const waitFor = Math.max(0, (this._lastRequestAt + minInterval) - now);
    if (waitFor > 0) await this.delay(waitFor + Math.floor(Math.random()*200));

    const res = await fetch(url, options);
    this._lastRequestAt = Date.now();
    if (res.status === 429 || res.status === 503) {
      if (attempt >= 5) return res; // give up to caller
      const retryAfter = res.headers.get('Retry-After');
      let delayMs = 0;
      if (retryAfter) {
        const sec = Number(retryAfter);
        if (!Number.isNaN(sec)) delayMs = sec * 1000; else {
          const when = Date.parse(retryAfter); if (!Number.isNaN(when)) delayMs = Math.max(0, when - Date.now());
        }
      }
      if (!delayMs) delayMs = Math.min(60000, 1000 * Math.pow(2, attempt));
      await this.delay(delayMs);
      return this.apiFetch(url, options, attempt + 1);
    }
    return res;
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Check if extension was updated and handle cleanup
  async checkForExtensionUpdate(rootFolderId) {
    try {
      const manifest = chrome.runtime.getManifest();
      const currentVersion = manifest.version;

      const { lastKnownVersion } = await chrome.storage.local.get(['lastKnownVersion']);

      if (!lastKnownVersion) {
        // First time install or no version stored
        console.log('First time setup or version not tracked');
        await chrome.storage.local.set({ lastKnownVersion: currentVersion });
        return;
      }

      if (lastKnownVersion !== currentVersion) {
        console.log(`Extension updated from ${lastKnownVersion} to ${currentVersion}`);

        // Clear mapping data to force rebuild
        await chrome.storage.local.remove(['rdMapRaindropToBookmark', 'rdMapCollectionToFolder']);
        console.log('Cleared mapping data due to extension update');

        // Clean up any existing duplicates
        await this.cleanupAllDuplicates(rootFolderId);

        // Update stored version
        await chrome.storage.local.set({ lastKnownVersion: currentVersion });

        console.log('Extension update cleanup complete');
      }
    } catch (error) {
      console.error('Error checking extension update:', error);
    }
  }

  // Clean up stale mapping entries where bookmarks no longer exist
  async cleanupMapping(rdMap) {
    const staleMappings = [];

    for (const [raindropId, bookmarkId] of Object.entries(rdMap)) {
      try {
        // Try to get the bookmark - if it doesn't exist, chrome.bookmarks.get will throw
        await chrome.bookmarks.get(bookmarkId);
      } catch (error) {
        // Bookmark doesn't exist anymore, mark for cleanup
        staleMappings.push(raindropId);
      }
    }

    // Remove stale mappings
    for (const raindropId of staleMappings) {
      delete rdMap[raindropId];
    }

    if (staleMappings.length > 0) {
      console.log(`Cleaned up ${staleMappings.length} stale bookmark mappings`);
    }
  }

  // Clean up stale folder mapping entries where folders no longer exist
  async cleanupFolderMapping(folderMap) {
    const staleMappings = [];

    for (const [collectionId, folderId] of Object.entries(folderMap)) {
      try {
        // Try to get the folder - if it doesn't exist, chrome.bookmarks.get will throw
        const [folder] = await chrome.bookmarks.get(folderId);
        if (!folder || folder.url) {
          // Not a folder anymore, mark for cleanup
          staleMappings.push(collectionId);
        }
      } catch (error) {
        // Folder doesn't exist anymore, mark for cleanup
        staleMappings.push(collectionId);
      }
    }

    // Remove stale mappings
    for (const collectionId of staleMappings) {
      delete folderMap[collectionId];
    }

    if (staleMappings.length > 0) {
      console.log(`Cleaned up ${staleMappings.length} stale folder mappings`);
    }
  }

  // Remove duplicate bookmarks in the same folder
  async cleanupDuplicateBookmarks(folderId) {
    try {
      const children = await chrome.bookmarks.getChildren(folderId);
      const bookmarks = children.filter(c => !!c.url);

      // Group by URL
      const urlGroups = new Map();
      for (const bookmark of bookmarks) {
        if (!urlGroups.has(bookmark.url)) {
          urlGroups.set(bookmark.url, []);
        }
        urlGroups.get(bookmark.url).push(bookmark);
      }

      let duplicatesRemoved = 0;
      for (const [url, duplicates] of urlGroups) {
        if (duplicates.length > 1) {
          // Keep the newest one (highest index), remove the rest
          duplicates.sort((a, b) => b.index - a.index);
          const toKeep = duplicates[0];
          const toRemove = duplicates.slice(1);

          for (const duplicate of toRemove) {
            await chrome.bookmarks.remove(duplicate.id);
            duplicatesRemoved++;
          }
        }
      }

      if (duplicatesRemoved > 0) {
        console.log(`Removed ${duplicatesRemoved} duplicate bookmarks from folder ${folderId}`);
      }

      return duplicatesRemoved;
    } catch (error) {
      console.error('Error cleaning duplicates:', error);
      return 0;
    }
  }

  // Cleanup duplicates in all collection folders
  async cleanupAllDuplicates(rootFolderId) {
    try {
      console.log('cleanupAllDuplicates: Starting with rootFolderId:', rootFolderId);
      let totalRemoved = 0;

      const children = await chrome.bookmarks.getChildren(rootFolderId);
      const folders = children.filter(c => !c.url);

      for (const folder of folders) {
        const removed = await this.cleanupDuplicateBookmarks(folder.id);
        totalRemoved += removed;
      }

      console.log(`Duplicate cleanup complete: ${totalRemoved} duplicates removed`);
      return totalRemoved;
    } catch (error) {
      console.error('Error during duplicate cleanup:', error);
      return 0;
    }
  }

  async clearAllSyncedBookmarks() {
    try {
      console.log('clearAllSyncedBookmarks: Starting to clear ALL bookmarks...');
      let totalDeleted = 0;

      // First count all bookmarks before deletion
      const allBookmarks = await this.getAllBookmarksRecursively();
      const totalCount = allBookmarks.length;
      console.log(`Found ${totalCount} total bookmarks to delete`);

      // Get the main bookmark folders (Bookmarks Bar = "1", Other Bookmarks = "2", Mobile = "3")
      const mainFolderIds = ['1', '2', '3'];

      for (const folderId of mainFolderIds) {
        try {
          const children = await chrome.bookmarks.getChildren(folderId);
          console.log(`Processing folder ${folderId}, found ${children.length} items`);

          // Remove all children of this main folder
          for (const item of children) {
            try {
              if (item.url) {
                // It's a bookmark
                await chrome.bookmarks.remove(item.id);
                totalDeleted++;
                console.log(`✓ Removed bookmark: ${item.title}`);
              } else {
                // It's a subfolder - remove the entire tree
                const subBookmarks = await this.getAllBookmarksInFolder(item.id);
                await chrome.bookmarks.removeTree(item.id);
                totalDeleted += subBookmarks.length;
                console.log(`✓ Removed folder "${item.title}" with ${subBookmarks.length} bookmarks`);
              }
            } catch (error) {
              console.error(`✗ Error removing ${item.title}:`, error);
            }
          }
        } catch (error) {
          console.error(`Error processing folder ${folderId}:`, error);
        }
      }

      // Clear all stored mappings
      await chrome.storage.local.remove(['rdMapRaindropToBookmark', 'rdMapCollectionToFolder']);

      console.log(`✅ Successfully cleared ${totalDeleted} bookmarks from all folders`);
      return { bookmarksDeleted: totalDeleted };
    } catch (error) {
      console.error('❌ Error clearing all bookmarks:', error);
      throw error;
    }
  }

  async getAllBookmarksRecursively() {
    try {
      const tree = await chrome.bookmarks.getTree();
      const bookmarks = [];

      function extractBookmarks(nodes) {
        for (const node of nodes) {
          if (node.url) {
            bookmarks.push(node);
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

  async getAllBookmarksInFolder(folderId) {
    try {
      const children = await chrome.bookmarks.getChildren(folderId);
      let allBookmarks = [];

      for (const child of children) {
        if (child.url) {
          // It's a bookmark
          allBookmarks.push(child);
        } else {
          // It's a folder, get its contents recursively
          const subBookmarks = await this.getAllBookmarksInFolder(child.id);
          allBookmarks = allBookmarks.concat(subBookmarks);
        }
      }

      return allBookmarks;
    } catch (error) {
      console.error('Error getting bookmarks in folder:', error);
      return [];
    }
  }

  // Find all bookmarks with a specific URL in the entire bookmark tree
  async findBookmarksByUrl(url) {
    try {
      const allBookmarks = await this.getAllBookmarksRecursively();
      return allBookmarks.filter(bookmark => bookmark.url === url);
    } catch (error) {
      console.error('Error finding bookmarks by URL:', error);
      return [];
    }
  }

  // Clean up duplicate bookmarks in a folder that aren't properly mapped
  async cleanupUnmappedDuplicates(folderId, rdMap) {
    try {
      const children = await chrome.bookmarks.getChildren(folderId);
      const bookmarks = children.filter(c => !!c.url);

      // Group bookmarks by URL
      const bookmarksByUrl = new Map();
      for (const bookmark of bookmarks) {
        if (!bookmarksByUrl.has(bookmark.url)) {
          bookmarksByUrl.set(bookmark.url, []);
        }
        bookmarksByUrl.get(bookmark.url).push(bookmark);
      }

      // Find and remove unmapped duplicates
      const mappedBookmarkIds = new Set(Object.values(rdMap));
      let removedCount = 0;

      for (const [url, duplicates] of bookmarksByUrl) {
        if (duplicates.length > 1) {
          // Keep the first mapped bookmark, or the first one if none are mapped
          const mappedBookmark = duplicates.find(b => mappedBookmarkIds.has(b.id));
          const keepBookmark = mappedBookmark || duplicates[0];

          // Remove the other duplicates
          for (const duplicate of duplicates) {
            if (duplicate.id !== keepBookmark.id) {
              try {
                await chrome.bookmarks.remove(duplicate.id);
                removedCount++;
                console.log(`Removed unmapped duplicate bookmark: ${duplicate.title} (${duplicate.url})`);
              } catch (error) {
                console.warn('Failed to remove duplicate bookmark:', duplicate.id, error);
              }
            }
          }
        }
      }

      if (removedCount > 0) {
        console.log(`Cleaned up ${removedCount} unmapped duplicate bookmarks in folder ${folderId}`);
      }
    } catch (error) {
      console.error('Error cleaning up unmapped duplicates:', error);
    }
  }
}

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
