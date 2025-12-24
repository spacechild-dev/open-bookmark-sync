// Google Drive API service for Open Bookmark Sync

class DriveAPI {
  constructor() {
    this.API_BASE = 'https://www.googleapis.com/drive/v3';
    this.API_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
    this.FILENAME = 'open-bookmark-sync.json';
    this.fileId = null;
  }

  async getAuthToken(interactive = false) {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(token);
        }
      });
    });
  }

  async findFile() {
    if (this.fileId) {
      return this.fileId;
    }

    const token = await this.getAuthToken();
    const url = new URL(`${this.API_BASE}/files`);
    url.searchParams.set('q', `name='${this.FILENAME}' and 'appDataFolder' in parents`);
    url.searchParams.set('spaces', 'appDataFolder');
    url.searchParams.set('fields', 'files(id, name)');

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error(`Failed to find file: ${res.status}`);
    }

    const data = await res.json();
    if (data.files && data.files.length > 0) {
      this.fileId = data.files[0].id;
      return this.fileId;
    }

    return null;
  }

  async createFile(content) {
    const token = await this.getAuthToken();
    const metadata = {
      name: this.FILENAME,
      parents: ['appDataFolder']
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'application/json' }));
    
    const res = await fetch(`${this.API_UPLOAD_BASE}/files?uploadType=multipart`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: form
    });

    if (!res.ok) {
      throw new Error(`Failed to create file: ${res.status}`);
    }

    const data = await res.json();
    this.fileId = data.id;
    return this.fileId;
  }

  async readFile(fileId) {
    const token = await this.getAuthToken();
    const url = new URL(`${this.API_BASE}/files/${fileId}`);
    url.searchParams.set('alt', 'media');

    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error(`Failed to read file: ${res.status}`);
    }

    return res.json();
  }

  async updateFile(fileId, content) {
    const token = await this.getAuthToken();
    const url = new URL(`${this.API_UPLOAD_BASE}/files/${fileId}`);
    url.searchParams.set('uploadType', 'media');

    const res = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: content
    });

    if (!res.ok) {
      throw new Error(`Failed to update file: ${res.status}`);
    }

    return res.json();
  }

  async getSyncData() {
    const fileId = await this.findFile();
    if (fileId) {
      return this.readFile(fileId);
    }
    return null;
  }

  async saveSyncData(data) {
    const content = JSON.stringify(data);
    const fileId = await this.findFile();

    if (fileId) {
      return this.updateFile(fileId, content);
    } else {
      return this.createFile(content);
    }
  }
}

window.driveAPI = new DriveAPI();
