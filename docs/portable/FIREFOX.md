# Load the extension in Firefox

This guide loads the extension from this folder. You need Firefox and the start
window of `start.sh`. Keep that window open: it shows the token.

1. Start Firefox.

> **Warning:** The extension is temporary. After a Firefox restart it is gone.
> Repeat steps 2 to 4. Firefox keeps the endpoint and the token in the profile;
> if the connection fails after a reload, check them.

2. Type `about:debugging#/runtime/this-firefox` in the address bar and press Enter.
3. Select **Load Temporary Add-on…** on the page.
4. In the file dialog, select the XPI file from this folder: `browser-control-<version>.xpi`.
5. Type `about:addons` in a new tab, select **Browser Control**, then select
   **Preferences**. A temporary add-on has no settings link in `about:debugging`;
   this page is the only way to its settings.
6. Enter `ws://127.0.0.1:8110` in the endpoint field.
7. Select the **Browser Control** icon in the toolbar to switch the extension on.
   The icon is crossed out while the extension is off, and **nothing happens
   until you switch** it on — no tab, no connection. When the tab is open and the
   bridge answers, the icon shows a bridge. A yellow bolt means: on, but the
   bridge does not answer.
8. Enter the token from the `token:` line of the start window.
9. Select **Save**.
10. Reload the extension in `about:debugging` one time: select **Reload** next to
    Browser Control.

The start window shows three lines. The line `endpoint:` carries
`ws://127.0.0.1:8110`; this address belongs to the extension. The line `http:`
carries `http://127.0.0.1:8111/mcp`; this address belongs to the MCP client
(`CLIENTS.md`).

If the bridge runs on another machine, replace `127.0.0.1` with its address in
step 6. Do not change the port unless you changed `BC_BIND`.
