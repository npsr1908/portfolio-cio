
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";

let client = null;
let transport = null;
let connecting = null;
let connected = false;
let authenticated = false;

const REMOTE_URL = "https://mcp.kite.trade/mcp";
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_AUTH_DIR = join(APP_DIR, "data", "mcp-auth");

export const READ_ONLY_TOOLS = new Set([
  "login",
  "get_holdings",
  "get_positions",
  "get_margins",
  "get_ltp",
  "get_ohlc",
  "get_quotes",
  "get_historical_data",
  "search_instruments",
  "get_mf_holdings",
  "get_profile"
]);

const BLOCKED_TOOLS = new Set([
  "place_order","modify_order","cancel_order",
  "place_gtt_order","modify_gtt_order","delete_gtt_order",
  "get_orders","get_order_history","get_order_trades","get_trades","get_gtts"
]);

export async function connectKite() {
  if (connecting) return connecting;
  if (connected && client) return { connected:true, authenticated };

  connecting = (async () => {
    client = new Client(
      { name:"portfolio-cio-windows", version:"0.1.3" },
      { versionNegotiation:{ mode:"auto" } }
    );

    transport = new StdioClientTransport({
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["-y", "mcp-remote@latest", REMOTE_URL],
      env: {
        ...process.env,
        MCP_REMOTE_CONFIG_DIR: MCP_AUTH_DIR
      }
    });

    await client.connect(transport);
    connected = true;

    const tools = await client.listTools();
    return {
      connected:true,
      authenticated:false,
      toolCount:(tools.tools || []).length,
      tools:(tools.tools || []).map(t => t.name)
    };
  })().finally(() => { connecting = null; });

  return connecting;
}

export async function listTools() {
  if (!client) await connectKite();
  return await client.listTools();
}

function extractLoginLink(result) {
  const text = Array.isArray(result?.content)
    ? result.content.filter(x => x?.type === "text").map(x => x.text).join("\n")
    : "";
  const m = text.match(/https:\/\/mcp\.kite\.trade\/authorize\?session_id=[^\s)\]]+/i);
  return {
    text,
    link: m ? m[0] : null
  };
}

export async function login() {
  if (!client) await connectKite();

  const result = await client.callTool({ name:"login", arguments:{} });
  const info = extractLoginLink(result);

  // The login tool first returns an authorization link. That does NOT mean
  // the account is authenticated yet. The user must open the link in a browser,
  // complete Zerodha authentication, then the client can call login/get_holdings again.
  authenticated = false;

  return {
    raw: result,
    message: info.text,
    loginLink: info.link,
    needsUserAction: !!info.link,
    authenticated: false
  };
}


function isTransientTransportError(err) {
  const s = String(err?.message || err || "").toLowerCase();
  return (
    s.includes("streamablehttperror") ||
    s.includes("failed to open sse stream") ||
    s.includes("error posting to endpoint") ||
    s.includes("code 524") ||
    s.includes("just a moment") ||
    s.includes("cloudflare") ||
    s.includes("aborterror") ||
    s.includes("fetch failed") ||
    s.includes("502") ||
    s.includes("503") ||
    s.includes("504")
  );
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function reconnectKiteInternal() {
  try { if (transport) await transport.close(); } catch {}
  client = null;
  transport = null;
  connected = false;
  authenticated = false;
  await connectKite();
}

export async function callReadOnlyTool(name, args={}) {
  if (BLOCKED_TOOLS.has(name) || !READ_ONLY_TOOLS.has(name)) {
    throw new Error(`Blocked tool: ${name}`);
  }

  let lastErr = null;

  // A transient Cloudflare/edge interruption can happen on the hosted MCP
  // endpoint. Retry conservatively rather than hammering the endpoint.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!client) await connectKite();

      const r = await client.callTool({ name, arguments: args });
      const text = Array.isArray(r?.content)
        ? r.content.filter(x => x?.type === "text").map(x => x.text).join("\n")
        : "";

      if (r?.isError) {
        const err = new Error(text || `Kite MCP tool ${name} returned an error.`);
        err.tool = name;
        err.raw = r;
        throw err;
      }

      if (/please log in first/i.test(text)) {
        const err = new Error("Kite session is not authenticated. Complete Zerodha login and click Verify Login.");
        err.tool = name;
        err.raw = r;
        throw err;
      }

      return r;
    } catch (e) {
      lastErr = e;
      const retryable = isTransientStreamError(e) || isRateLimitError(e);
      if (!retryable || attempt === 3) throw e;

      // Conservative backoff for Kite MCP rate limiting.
      const delay = isRateLimitError(e)
        ? [5000, 10000, 15000][attempt - 1]
        : 1500 * attempt;

      await sleep(delay);

      // Reconnect after transport errors; for 429 keep the session and retry.
      if (isTransientStreamError(e)) {
        try {
          await reconnectKiteInternal();
        } catch (reconnectErr) {
          lastErr = reconnectErr;
          await sleep(1500 * attempt);
        }
      }
    }
  }

  throw lastErr || new Error(`Kite MCP tool ${name} failed.`);
}


export async function verifyAuthenticated() {
  if (!client) await connectKite();

  try {
    // After the user completes the browser OAuth flow, Kite MCP expects the
    // login tool to be checked again on the SAME MCP client session. If it still
    // returns an authorization link, the browser login is not complete yet.
    const loginCheck = await client.callTool({ name:"login", arguments:{} });
    const loginText = Array.isArray(loginCheck?.content)
      ? loginCheck.content.filter(x=>x?.type==="text").map(x=>x.text||"").join("\n")
      : "";
    const authLink = extractLoginLink(loginCheck).link;

    if (loginCheck?.isError || authLink) {
      authenticated=false;
      return {
        authenticated:false,
        stage:"login",
        result:loginCheck,
        message:loginText
      };
    }

    // Only after the second login handshake no longer asks for authorization
    // do we verify the actual account and holdings.
    const profile = await client.callTool({ name:"get_profile", arguments:{} });
    const profileText = Array.isArray(profile?.content)
      ? profile.content.filter(x=>x?.type==="text").map(x=>x.text||"").join("\n")
      : "";
    if (profile?.isError || /please log in first/i.test(profileText)) {
      authenticated=false;
      return {authenticated:false,stage:"profile",result:profile};
    }

    const holdings = await client.callTool({ name:"get_holdings", arguments:{} });
    const holdingsText = Array.isArray(holdings?.content)
      ? holdings.content.filter(x=>x?.type==="text").map(x=>x.text||"").join("\n")
      : "";
    if (holdings?.isError || /please log in first|failed to execute get_holdings/i.test(holdingsText)) {
      authenticated=false;
      return {authenticated:false,stage:"holdings",result:holdings};
    }

    authenticated=true;
    return {authenticated:true,profile,holdings};
  } catch (e) {
    authenticated=false;
    return {authenticated:false,error:e?.message||String(e)};
  }
}


export async function logoutKite() {
  authenticated = false;
  connected = false;

  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}

  client = null;
  transport = null;
  connecting = null;

  // Clear only this app's mcp-remote OAuth cache. The official mcp-remote
  // README documents MCP_REMOTE_CONFIG_DIR as the configurable credential
  // directory and recommends clearing it to reset stale auth state.
  try { await rm(MCP_AUTH_DIR, { recursive:true, force:true }); } catch {}

  return {
    status:"ok",
    authenticated:false,
    message:"Kite MCP session and Portfolio CIO local OAuth credentials cleared."
  };
}





export async function reconnectKite() {
  try {
    if (transport) {
      try { await transport.close(); } catch {}
    }
  } catch {}
  client = null;
  transport = null;
  connected = false;
  authenticated = false;
  return await connectKite();
}

function isTransientStreamError(err) {
  const s = String(err?.message || err || "").toLowerCase();
  return s.includes("failed to open sse stream") ||
         s.includes("streamablehttperror") ||
         s.includes("code 524") ||
         s.includes("aborterror") ||
         s.includes("502") ||
         s.includes("503") ||
         s.includes("504");
}

function isRateLimitError(err) {
  const text = [
    err?.message,
    err?.raw?.message,
    ...(Array.isArray(err?.raw?.content) ? err.raw.content.map(x => x?.text || "") : [])
  ].filter(Boolean).join(" ").toLowerCase();
  return /\b429\b|too many requests|rate.?limit/.test(text);
}


export function getStatus() {
  return { connected, authenticated };
}
