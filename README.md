# Sleepy Bot (starter project)

## Included
- `/invites [user]` custom invite statistics embed
- `/leaderboard` top tracked inviters
- `/invited [user]` tracked invitee list
- `/resetinvites user` admin reset
- `/skin color title description image` admin customization
- `/welcome channel` welcome message channel
- SQLite persistence

## Setup (mobile-friendly)
1. Create an application at https://discord.com/developers/applications
2. Bot tab: enable **Server Members Intent** and **Guild Invites Intent** if shown.
3. OAuth2 > URL Generator: scopes `bot` and `applications.commands`; permissions: `Manage Server` (for invite fetching), `Send Messages`, `Embed Links`, `View Channels`, `Manage Guild` is not required for the bot itself. Invite it to your server.
4. Copy the bot token, application ID (Client ID), and server ID.
5. In the hosting workspace's Secrets/Environment Variables, add:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID`
   - optionally `FAKE_ACCOUNT_AGE_DAYS` (default 7)
6. Install packages and run `npm start`.

**Never put your token in a public file or share it.** If leaked, reset it in the Developer Portal immediately.

## Commands
- `/invites user` (omit user for yourself)
- `/leaderboard`
- `/invited user`
- `/resetinvites user` (requires Manage Server permission)
- `/skin color title description image` (admin; fields optional)
- `/welcome channel`

Skin description variables: `{user}`, `{total}`, `{fake}`, `{left}`, `{rejoins}`.
Example description:
`🦋 {user} has {total} invites\n» {fake} fake\n» {left} left\n» {rejoins} rejoined`

## Notes / limitations
- Invite attribution requires Manage Server permission and the Guild Invites intent.
- Fake detection here is a simple account-age heuristic, not definitive fraud detection.
- The first join after the bot starts can be attributed only if invite uses are fetched successfully.
- Invite tracking begins after bot is installed and running; it cannot reconstruct old invite history.
- The bot is configured for a single guild to simplify slash-command setup.
- The SQLite file `sleepy.sqlite` must be kept on persistent storage; ephemeral hosts can lose it.
