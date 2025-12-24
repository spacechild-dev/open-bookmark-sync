# Privacy Policy for Open Bookmark Sync

**Last Updated: September 28, 2025**

## Introduction

Open Bookmark Sync ("we", "our", or "the extension") is committed to protecting your privacy. This privacy policy explains how our browser extension handles your data and what information we collect, use, and share.

## Data Collection and Usage

### What We DON'T Collect

**Open Bookmark Sync does NOT collect, store, transmit, or share any of the following:**

- Personal information (name, email, phone number, address)
- Browsing history or website visit data
- Bookmark content analysis or indexing
- Usage analytics or telemetry data
- Error reports or crash logs
- Device information or browser fingerprinting
- Location data
- Any form of user tracking or profiling

### What Data Stays Local

The extension works entirely on your device and only stores data locally in Chrome's secure storage:

- **Raindrop.io API credentials**: Your Client ID, Client Secret, and access tokens are stored locally in Chrome's encrypted storage and never transmitted to our servers
- **Extension settings**: Sync preferences, intervals, and configuration options
- **Temporary authentication data**: OAuth tokens managed locally for API communication

### Third-Party Services

The extension communicates directly with:

1. **Raindrop.io API** - To sync your bookmarks (per your explicit configuration)
2. **Optional Cloudflare Worker** - For managed OAuth authentication (if enabled)

**Important**: We do not operate or control these services. Please review their respective privacy policies:
- [Raindrop.io Privacy Policy](https://raindrop.io/privacy)

## Data Security

- All data storage uses Chrome's built-in encryption mechanisms
- Authentication tokens are handled securely and never logged or transmitted unnecessarily
- No data is transmitted to analytics services, advertising networks, or data brokers
- The extension operates entirely client-side with no central data collection

## Permissions Explanation

The extension requests only the minimum permissions necessary:

- **Storage**: To save your settings and authentication tokens locally
- **Identity**: To handle OAuth authentication flow (optional, only for managed auth)
- **Host permissions**: Only to communicate with Raindrop.io API endpoints

## Data Retention

- Data is retained only as long as you keep the extension installed
- Uninstalling the extension removes all locally stored data
- You can manually clear all data using the "Clear Tokens" feature in the extension

## Your Rights and Choices

- **Data portability**: Export your settings via the Import/Export feature
- **Data deletion**: Clear all extension data at any time or uninstall the extension
- **Opt-out**: Disable sync functionality at any time through extension settings

## No Tracking or Analytics

This extension:
- Does NOT use Google Analytics or similar tracking services
- Does NOT collect usage statistics
- Does NOT implement any form of user tracking
- Does NOT share data with advertising networks
- Does NOT use cookies for tracking purposes

## Children's Privacy

The extension does not target children under 13 and does not knowingly collect data from children.

## Updates to This Policy

We may update this privacy policy to reflect changes in our practices or for legal compliance. Updated versions will be posted in the extension's GitHub repository with a new "Last Updated" date.

## Contact Information

For privacy-related questions or concerns:

- **GitHub Issues**: [https://github.com/spacechild-dev/open-bookmark-sync/issues](https://github.com/spacechild-dev/open-bookmark-sync/issues)
- **Email**: dagkan@spacechild.dev
- **Repository**: [https://github.com/spacechild-dev/open-bookmark-sync](https://github.com/spacechild-dev/open-bookmark-sync)

## Compliance

This privacy policy is designed to comply with:
- Chrome Web Store Developer Program Policies
- General Data Protection Regulation (GDPR)
- California Consumer Privacy Act (CCPA)
- Other applicable privacy laws and regulations

---

**Summary**: Open Bookmark Sync is a privacy-focused extension that operates entirely on your device. We do not collect, analyze, or share any personal data. All functionality is local, and your data remains under your complete control.