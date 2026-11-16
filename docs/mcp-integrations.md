# Native MCP integrations

Lancer loads Pi's MCP, tool-search and codemode integrations in both the runtime inventory and actual sessions. MCP configuration and sign-in remain owned by Pi: use `mcp.json` in the agent directory, or the trusted project override. `PI_CODING_AGENT_DIR` selects an isolated agent profile. No server, credential or global directory is hardcoded by the desktop host.

Tools keep Pi's exposure behavior. Deferred servers are discovered with `tool_search`; codemode servers activate the script tool as needed. Registering the codemode factory does not make the tool active in every session. MCP tool calls, including calls nested inside codemode, pass through Pi's `tool_call` hooks.

Settings → General → **Tool permissions** selects the desktop approval policy for
all models, workspaces, conversations, child threads and scheduled tasks. Existing
profiles default to **Ask each time**. The setting persists across restarts and is
read for each tool call in already-open sessions, including nested calls. A dialog
already waiting for a response still needs to be answered or the run stopped.

- **Ask each time:** only known native inspection tools are exempt. Every MCP tool
  requires approval, including tools advertising `readOnlyHint: true`. Server
  annotations never grant trust. Codemode, child-thread creation, thread messaging,
  unknown tools, writes, edits and shell commands also require confirmation.
  Approving codemode does not approve its nested MCP calls. Approval is not remembered;
  without an available confirmation UI, the call is blocked.
- **Full access:** the user's explicit preference lets those tool calls execute
  without Lancer confirmation, including commands, file changes outside the workspace
  and external tools. This applies to control-API messages too. It does not grant new
  tools, credentials, macOS file permissions or administrator rights. Stop/abort
  remains effective, and switching back restores confirmation for the next call.

In Ask each time mode, the confirmation dialog follows the app language, masks
credential-shaped fields and common secrets inside string values, and refuses
oversized arguments instead of silently truncating them. Pattern masking cannot
identify every possible secret; review tool arguments.

MCP, codemode and tool-search are separate optional built-ins in Skills and extensions.
Disable their switches and reload the session to remove those integrations; the same
preference applies to inventory and runtime loading. The permission hook remains a
required hidden integration; its policy is controlled by Tool permissions, not an
extension switch.

These hooks are not an operating-system sandbox. Installed extensions and server
processes execute with their process permissions; review them before installation.
Regression tests cover false read-only claims, execution-wrapper confirmation,
per-call rejection, missing UI, masking, malformed saved modes and live policy changes.
The deterministic local model drives the actual Pi runtime in Electron, including
native write/edit/bash, stdio MCP calls inside codemode, preference persistence,
revocation and failed-save rollback. This does not establish external-provider or
macOS protected-folder access.
