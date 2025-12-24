# Release Notes - v1.3.0

**Release Date**: January 9, 2025
**Status**: Chrome Web Store Compliant

---

## Major Highlights

### Chrome Web Store Compliance
This release resolves all Chrome Web Store policy violations and makes the extension fully compliant for distribution.

- **Removed Remote Code**: Eliminated all CDN dependencies (Buy Me a Coffee script)
- **Inline Code Only**: All scripts now bundled within the extension
- **Policy Compliant**: Meets all Chrome Web Store developer program requirements

### Critical Bug Fixes
- **Emergency Restore Fixed**: JSON backup imports now correctly restore all bookmarks
- **Empty Title Preservation**: Bookmarks with empty titles (favicon-only) are now preserved during import/restore
- **Backup Download Fixed**: "Backup Now" and "Create Backup" buttons now properly download files
- **Duplicate ID Resolution**: Fixed multiple HTML elements with same ID causing functionality issues

### New Features
- **HTML Backup Export**: All backup operations now generate both JSON and HTML files
  - JSON format for restoration within the extension
  - HTML format (Netscape Bookmark Format) for browser-native imports
  - Both files download automatically with single click
- **Better Progress Feedback**: Backup operations now show proper timing ("Creating backup..." → "Downloading files...")

### UI/UX Improvements
- **Reorganized Sidebar Navigation**:
  - New "Raindrop.io Sync" main category (Connect + Sync Settings)
  - Tools, Settings, and Help moved to collapsible "More" section
  - Clearer hierarchy emphasizing core sync functionality
- **Streamlined Interface**: Reduced tab count from 6 to 5
  - Removed Advanced tab (content moved to Tools → Danger Zone)
- **Notification Bar Optimization**: Reduced height for more screen space (12px → 8px padding)
- **Support Resources Redesign**: 2-column grid layout, cleaner organization

### Technical Improvements
- **Tools Tab Enhancement**: New "Danger Zone" section with proper styling
  - Red border and warning colors
  - Clear separation from safe operations
  - Includes Clear All Bookmarks with multi-step confirmation
- **Event Listener Coverage**: All new Tools buttons properly wired
- **Code Cleanup**: Removed duplicate HTML IDs and consolidated functionality

---

## Complete Change Log

### Added
- HTML backup export alongside JSON (Netscape Bookmark Format)
- Tools → Danger Zone section with Clear All Bookmarks
- Progress indication for backup operations
- Event listeners for all Tools Danger Zone buttons
- "Raindrop.io Sync" sidebar category

### Fixed
- Chrome Web Store remotely hosted code violation (removed BMC CDN)
- Emergency restore not loading bookmarks from JSON backup
- Empty bookmark titles being replaced with URLs during import
- Backup Now button not downloading files
- Create Backup button timing and download functionality
- Scan for Duplicates button functionality
- Duplicate HTML IDs (scanDuplicates)

### Changed
- Notification bar height reduced (more compact)
- Sidebar reorganized with "Raindrop.io Sync" as main category
- Support Resources layout (2-column grid)
- Tab count: 6 → 5 (Advanced tab removed)

### Removed
- Advanced tab (content moved to Tools)
- Remote CDN dependencies
- Duplicate HTML IDs and redundant elements

---

## Upgrade Instructions

### For Users
1. **No action required** - Simply update when available on Chrome Web Store
2. **For manual installs**: Replace the `extension/` folder with the new version
3. **Verify settings** after upgrade - all existing data and settings are preserved

### For Developers
1. Pull latest from `main` branch
2. Extension version updated to `1.3.0` in `manifest.json`
3. No breaking API changes - existing configurations remain compatible

---

## Testing Checklist

Before deploying, please verify:

- [ ] Extension loads without errors in Chrome
- [ ] Authentication flow works (OAuth2 with Raindrop.io)
- [ ] Sync operations complete successfully
- [ ] Backup Now downloads both JSON and HTML files
- [ ] Create Backup shows progress and downloads files
- [ ] Emergency Restore correctly imports JSON backups
- [ ] Empty bookmark titles preserved during import
- [ ] Tools → Danger Zone → Clear All functions properly
- [ ] No console errors related to duplicate IDs
- [ ] All sidebar navigation links work correctly

---

## Known Issues

None currently identified. Please report any issues on [GitHub Issues](https://github.com/spacechild-dev/open-bookmark-sync/issues).

---

## Installation

### Chrome Web Store (Recommended)
Extension is currently under review. Will be available soon at Chrome Web Store.

### Manual Installation (Development)
1. Download the latest release: [v1.3.0](https://github.com/spacechild-dev/open-bookmark-sync/releases/tag/v1.3.0)
2. Extract the ZIP file
3. Open `chrome://extensions`
4. Enable "Developer mode"
5. Click "Load unpacked"
6. Select the `extension/` folder

---

## Acknowledgments

Special thanks to:
- Chrome Web Store review team for detailed feedback
- All users who reported bugs and suggested improvements
- Claude Code for development assistance

---

## Support

- **Issues**: [GitHub Issues](https://github.com/spacechild-dev/open-bookmark-sync/issues)
- **Email**: dagkan@spacechild.dev
- **Privacy Policy**: [PRIVACY.md](PRIVACY.md)
- **Roadmap**: [ROADMAP.md](ROADMAP.md)

---

## What's Next?

See our [ROADMAP.md](ROADMAP.md) for upcoming features:
- Phase 2.1: Dry-run mode with preview
- Phase 2.2: Enhanced backup system
- Phase 3: Per-collection controls
- And much more!

---

**Full Changelog**: [v1.2.0...v1.3.0](https://github.com/spacechild-dev/open-bookmark-sync/compare/v1.2.0...v1.3.0)