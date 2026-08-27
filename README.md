# Portfolio CIO

A local, read-only Windows portfolio research dashboard for Zerodha users.

Portfolio CIO connects to Zerodha through **Kite MCP** and provides portfolio monitoring, technical analysis, research hand-off to ChatGPT, stock comparison, opportunity research, and portfolio rebalancing support.

> **Important:** This application is a local decision-support tool. It does not place orders or GTTs.

## Features

- Live Zerodha holdings sync through Kite MCP
- Portfolio dashboard with construction health and risk views
- Holdings analytics and per-stock technical analysis
- 20/50/100/200 DMA, RSI, MACD, ATR, volume and support/resistance analysis
- Any Stock research workflow
- Compare any number of NSE/BSE stocks
- Portfolio-aware opportunity research
- Smart Rebalancing across the complete live portfolio
- ChatGPT research prompts with structured JSON response parsing
- Read-only architecture; no order-placement workflow is exposed by this app

## Prerequisites

### 1. Windows

Windows 10/11 is recommended.

### 2. Node.js LTS

Install a current Node.js LTS release:

https://nodejs.org/

Verify:

```text
node --version
npm --version
```

### 3. Zerodha account

You need an active Zerodha account with access to Kite.

You must be able to complete Zerodha's normal browser authentication and 2FA flow.

### 4. Kite MCP

Portfolio CIO uses Zerodha's official Kite MCP endpoint:

https://mcp.kite.trade/mcp

Zerodha documents Kite MCP as a free connection for supported AI assistants and describes it as read-only for normal portfolio/market-data access. Authentication is performed through Zerodha's own login flow rather than by putting your Zerodha password into this repository.

Official Zerodha references:

- Kite MCP: https://zerodha.com/products/mcp/
- Kite MCP setup: https://support.zerodha.com/category/trading-and-markets/general-kite/others-kite/articles/connect-zerodha-ai-assistant
- Kite Connect/API overview: https://zerodha.com/products/api/

### 5. No credentials belong in GitHub

Do **not** commit any of the following:

- Zerodha password
- Zerodha PIN
- OTP/TOTP
- API key
- API secret
- Access token
- OAuth cache
- Personal portfolio snapshot
- Personal client/account information

The repository intentionally ships without personal portfolio data.

## Zerodha-side setup

For this Portfolio CIO build, the primary connection is **Kite MCP**, not a hard-coded Kite Connect API credential.

1. Have a working Zerodha Kite account.
2. Keep your normal Zerodha authentication and 2FA available.
3. Start Portfolio CIO locally.
4. Use **Connect Zerodha** inside the application.
5. The app opens the official Zerodha authorization page.
6. Complete login and 2FA in the Zerodha browser window.
7. Return to Portfolio CIO and use **Verify Login**.
8. Run **Re-sync** to retrieve the current holdings through the read-only Kite MCP connection.

Do not paste Zerodha credentials into the terminal, into the application source code, or into `.env`.

Zerodha states that authentication for Kite MCP happens through its secure login flow and that credentials are not passed to the AI assistant. See the official Kite MCP documentation above.

## Running Portfolio CIO

1. Extract the repository.
2. Open the extracted folder.
3. Double-click:

```text
run_windows.bat
```

On first launch the script installs the required MCP client package.

The application opens:

```text
http://127.0.0.1:8000
```

Keep the terminal window open while using the application.

## First-time connection

Inside Portfolio CIO:

1. Start the app.
2. Click **Connect Zerodha**.
3. Complete the Zerodha browser authorization.
4. Click **Verify Login**.
5. Click **Re-sync**.
6. Confirm that your live holdings and portfolio value appear.

The first sync creates local runtime data under `data/`. These files are intentionally ignored by Git.

## ChatGPT research workflow

Portfolio CIO does not automate your ChatGPT browser session and does not require an OpenAI API key.

For Research Stock, Compare, Opportunities, and Smart Rebalancing:

1. Prepare the research request inside Portfolio CIO.
2. Copy the generated prompt.
3. Paste it into ChatGPT.
4. Return the response to Portfolio CIO.
5. Paste the ChatGPT response into the application's response window.
6. Submit it.
7. Portfolio CIO parses the structured response and displays the result.

## Smart Rebalancing

Smart Rebalancing uses the **current live holdings array** as the source of truth.

The generated research request automatically reflects the current number of holdings. It does not assume a fixed portfolio size.

The workflow evaluates the complete portfolio for:

- Fundamental quality
- Valuation
- Technical structure
- Candles and price action
- Position sizing
- Theme concentration
- Diversification
- Capital redeployment
- Existing holdings and new-stock opportunities

No order is placed automatically.

## Security model

Portfolio CIO is intended to run locally.

The repository contains:

- no personal portfolio snapshot
- no Zerodha password
- no PIN or OTP
- no API secret
- no OAuth token
- no personal account identifier

The application uses a local runtime OAuth/cache directory for the MCP connector. That directory is ignored by Git.

The application also does not ship a raw holdings debug dump.

## GitHub publishing checklist

Before pushing:

1. Check that `.env` is not present.
2. Check that `data/mcp-auth/` is not present.
3. Check that personal portfolio/runtime JSON files are not staged.
4. Run:

```text
git status
```

5. Run a repository search for:

```text
password
api_secret
access_token
client_secret
otp
TOTP
Bearer
```

6. Confirm that only placeholders/examples remain.

Recommended safety check on Windows PowerShell:

```powershell
git grep -n -I -E "password|api_secret|access_token|client_secret|otp|TOTP|Bearer"
```

## Optional Kite Connect API plan

This repository does **not** require a Kite Connect API key/secret for its included Kite MCP connection.

Zerodha's separate Kite Connect API product is intended for direct programmatic API integrations. Plans and pricing can change, so refer to the official Zerodha documentation before enabling that route:

https://zerodha.com/products/api/

If you later add direct Kite Connect credentials, keep them in local environment/configuration only and never commit them.

## Data and compliance note

This project is designed for personal/local use with your own Zerodha account.

Do not publish or redistribute your personal portfolio data, authentication material, or other account information.

Zerodha also places restrictions on redistribution of Kite Connect market data. Review the current Zerodha terms and exchange-data requirements before turning this local application into a public hosted data service.

## Troubleshooting

### `mcp-remote` shows an SSE/524 message

A temporary Streamable HTTP/SSE transport message can occur at the remote edge layer. If Kite MCP tool calls continue to succeed, login/verification succeeds, and Re-sync updates successfully, the message may be transient.

If Re-sync starts failing, the connection becomes unauthenticated, or data stops updating, reconnect and verify the Zerodha authorization.

### Node.js not found

Install Node.js LTS, restart the terminal, then run `run_windows.bat` again.

### MCP package missing

`run_windows.bat` installs the required MCP client automatically on first launch.

## Project structure

```text
Portfolio CIO/
├─ web/
│  ├─ index.html
│  ├─ app.js
│  ├─ styles.css
│  └─ auth-complete.html
├─ data/
│  ├─ portfolio_snapshot.json
│  ├─ analysis_status.json
│  ├─ analysis_runs.json
│  └─ market_cap_metadata.json
├─ kite_service.mjs
├─ server.js
├─ package.json
├─ run_windows.bat
├─ .env.example
├─ .gitignore
└─ README.md
```

The JSON files under `data/` are runtime files and should remain local.

## License

Choose and add the license appropriate for your intended GitHub distribution.

Before public release, also review Zerodha's current API/MCP terms and any exchange-data licensing requirements relevant to your use case.
