VitaBot — Privacy Policy

1. Discord and auditing
The bot processes commands, messages containing links when security monitoring is
enabled, and voice-session state. Audit messages may include command names, user
tags and server names. Administrators choose the audit channel and enabled categories.
Image-generation prompts are no longer copied into audit logs. Other command integrations may process inputs for their requested function.
Discord audit messages remain until deleted by administrators or Discord.

2. Chat and external services
/chatconvita replies are ephemeral. It sends the current message and character
instructions to Google's Gemini API, without attaching Discord profiles, project
files or other users' conversations. It does not retain chat history or copy chat
prompts/responses into audit logs. Ephemeral replies still involve Google processing.
Other integrations send the inputs necessary to their respective providers.
Configured link-reputation providers receive URLs. urlscan is disabled by default;
explicit activation only attempts private reports and excludes query strings.
Private provider reports are still processed and retained under provider policies.
YouTube session cookies remain on the personal audio worker and are passed to yt-dlp
for authorized YouTube requests; they must not be committed or transferred with code.

3. Local moderation storage
The private security-state.json stores bound role-panel IDs and quarantine records
containing message text, author/server/channel/message IDs, reason and decision state.
A recoverable record and a private review panel are required before automatic deletion.
Attachments or other elements that cannot be preserved cause the original to remain.
Only members with current moderation permissions in the original channel and access
to the review channel may retrieve or decide a case. Retrieval is ephemeral; approved
restorations are posted to the original channel with mentions disabled.
Local quarantine records expire after seven days and are removed on writes or by
hourly cleanup, subject to the bot running and storage being writable. Role-panel
records expire after ninety days. Discord copies follow Discord's own retention.
An ambiguous restoration keeps the saved original available for manual recovery.
Configuration/state are stored on the bot host; audio extraction runs on the personal
worker. No database or separate moderation service is required.

4. Deletion
Administrators can delete Discord audit/restored messages and request removal of the
bot's per-server local state. Removing the bot does not itself delete Discord audit
channels, local configuration, private backups, or provider-side data. Do not submit
credentials or third-party private information to commands or public messages.

5. Request limits and operational backups
Link-reputation verdicts are cached only in memory, up to 200 entries, for two minutes with full coverage or thirty seconds otherwise; expired entries are retired on subsequent access. Chat messages and responses are not cached. Technical analysis generation receives domains and provider results without URL query strings. Image generation may send its prompt to Google Translate and the configured Hugging Face provider. Local backups contain audit and security configuration, without environment files or YouTube cookies. Up to seven daily snapshots are retained; expired moderation records are also removed from backups during hourly maintenance, subject to the bot running and writable storage. Restored messages and ephemeral review attachments follow Discord retention. Operational logs are rotated on both hosts and are not a replacement for recoverable moderation state.
