# Chat Commands

This document lists all available commands in **tryl.chat**.

## Global Commands
Available to all users.

| Command | Description |
| :--- | :--- |
| - | - |

## Moderation Commands
Available to **Moderators** and **Admins**.

| Command | Usage | Description |
| :--- | :--- | :--- |
| **Kick/Ban** | `/ban <wallet>` | Bans a user by wallet address. Removes them from the whitelist and disconnects them. |
| **Mute** | `/mute <username>` | Mutes a user by username, preventing them from sending messages. |
| **Clear Chat** | `/clear` | Clears the entire chat history for everyone. |
| | `/clear <number>` | Clears the last `N` messages for everyone. |
| | `/clear <wallet>` | Clears all messages from a specific wallet address. |
| **Pin Message** | `/pin <message>` | Pins a message to the top of the chat area. |
| **Unpin** | `/unpin` | Removes the currently pinned message. |
| **Whitelist** | `/aa <wallet>` | **Add Access**: shortcuts to add a wallet to the whitelist. Grants access to holder rooms. |
| | `/ra <wallet>` | **Remove Access**: shortcuts to remove a wallet from the holder room. |
| | `/whitelist <wallet>` | Adds a wallet to the whitelist. |
| | `/whitelist remove <wallet>` | Removes a wallet from the whitelist. |
| | `/whitelist bulk <csv>` | Adds multiple wallets from a comma-separated list. |
| **URL Permission** | `/permission url <wallet>` | Grants a user permission to embed images/videos despite restrictions. |

## Administration Commands
Available to **Admins** and **Owner**.

| Command | Usage | Description |
| :--- | :--- | :--- |
| **Manage Mods** | `/mod add <wallet>` | Promotes a user to Moderator status. |
| | `/mod remove <wallet>` | Demotes a Moderator. |

## Owner Commands
Available only to the **Owner**.

| Command | Usage | Description |
| :--- | :--- | :--- |
| **Manage Admins** | `/admin add <wallet>` | Promotes a user to Admin status. |
| | `/admin remove <wallet>` | Demotes an Admin. |

## Notes
-   **Wallets**: Most commands require the user's **Wallet Address** (Base58 string), not their username. You can usually click a user's name (if you are admin) to copy their wallet address.
-   **Persistence**: Changes to roles (Mod/Admin) and Whitelists are saved to the server's storage and persist across restarts.
