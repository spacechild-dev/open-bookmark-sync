// OAuth2 flow for Google Drive authentication

class GoogleOAuth {
  constructor() {
    this.API_BASE = 'https://www.googleapis.com/drive/v3';
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

  async startAuthFlow() {
    try {
      console.log('🔐 Starting Google OAuth authentication flow...');
      const token = await this.getAuthToken(true);
      if (token) {
        return { success: true, message: 'Authentication successful' };
      } else {
        throw new Error('Authentication failed');
      }
    } catch (error) {
      console.error('Google OAuth flow failed:', error);
      throw error;
    }
  }

  async testConnection() {
    try {
      const token = await this.getAuthToken();
      if (!token) {
        return { success: false, message: 'Not authenticated' };
      }

      const res = await fetch(`${this.API_BASE}/about?fields=user`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (res.ok) {
        const data = await res.json();
        return {
          success: true,
          message: 'Connection successful',
          user: data.user
        };
      } else {
        return {
          success: false,
          message: `Connection failed: ${res.status}`
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Connection error: ${error.message}`
      };
    }
  }

  async logout() {
    try {
      const token = await this.getAuthToken();
      if (token) {
        await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
        await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
      }
      return { success: true, message: 'Logged out successfully' };
    } catch (error) {
      console.error('Logout failed:', error);
      throw error;
    }
  }
}

window.googleOAuth = new GoogleOAuth();