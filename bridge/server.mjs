import http from "node:http";
import { CopilotClient, approveAll } from "@github/copilot-sdk";

const HOST = process.env.COPILOT_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.COPILOT_BRIDGE_PORT || 8787);

const warmClients = new Map();

function getClientKey(githubToken) {
  const trimmed = String(githubToken || "").trim();
  return trimmed ? `token:${trimmed}` : "logged-in";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large."));
      }
    });

    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON request: ${error.message}`));
      }
    });

    request.on("error", reject);
  });
}

function writeJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,X-GitHub-Token",
    "Access-Control-Allow-Methods": "POST,OPTIONS,GET"
  });
  response.end(JSON.stringify(data));
}

function getGitHubToken(request) {
  const headerValue = request.headers["x-github-token"];
  if (!headerValue) {
    return "";
  }

  return Array.isArray(headerValue) ? String(headerValue[0] || "") : String(headerValue);
}

function applyGitHubToken(token) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return false;
  }

  process.env.GH_TOKEN = trimmed;
  process.env.GITHUB_TOKEN = trimmed;
  return true;
}

function extractTextContent(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractTextContent(item)).join("\n");
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }

    if (Array.isArray(value.content)) {
      return value.content.map((item) => extractTextContent(item)).join("\n");
    }
  }

  return "";
}

async function callSdk(requestData) {
  const { model, systemPrompt, userPrompt, githubToken } = requestData;

  const client = await getOrCreateWarmClient(githubToken);
  let session;

  try {
    session = await client.createSession({
      model: model || "gpt-5-mini",
      onPermissionRequest: approveAll,
      systemMessage: {
        mode: "replace",
        content: String(systemPrompt || "You are a helpful assistant.")
      }
    });

    const finalMessage = await session.sendAndWait(
      {
        prompt: String(userPrompt || "")
      },
      120000
    );

    const content = extractTextContent(finalMessage?.data?.content);
    if (!content) {
      throw new Error("No assistant content returned from Copilot session.");
    }

    return content;
  } finally {
    if (session) {
      await session.disconnect().catch(() => undefined);
    }
  }
}

async function getOrCreateWarmClient(githubToken) {
  const key = getClientKey(githubToken);
  const existing = warmClients.get(key);

  if (existing && existing.getState?.() === "connected") {
    return existing;
  }

  if (existing) {
    warmClients.delete(key);
    await existing.stop?.().catch(() => []);
  }

  const clientOptions = githubToken?.trim()
    ? { githubToken: githubToken.trim(), useLoggedInUser: false }
    : { useLoggedInUser: true };

  const client = new CopilotClient(clientOptions);
  await client.start();
  warmClients.set(key, client);
  return client;
}

async function stopAllWarmClients() {
  const clients = Array.from(warmClients.values());
  warmClients.clear();
  await Promise.all(clients.map((client) => client.stop?.().catch(() => [])));
}

async function handleAuthCheck(request, response) {
  const token = getGitHubToken(request);
  const usedToken = applyGitHubToken(token);

  const clientOptions = usedToken ? token.trim() : "";

  const client = await getOrCreateWarmClient(clientOptions);
  const auth = await client.getAuthStatus();
  if (!auth?.isAuthenticated) {
    throw new Error(auth?.statusMessage || "GitHub is not authenticated for Copilot.");
  }

  writeJson(response, 200, {
    ok: true,
    authorized: true,
    usedToken,
    authType: auth.authType || "unknown",
    login: auth.login || null,
    host: auth.host || null,
    statusMessage: auth.statusMessage || "Authenticated"
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    writeJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { ok: true, status: "up" });
    return;
  }

  if (request.method === "POST" && request.url === "/auth/check") {
    try {
      await handleAuthCheck(request, response);
    } catch (error) {
      writeJson(response, 401, { ok: false, error: error.message });
    }
    return;
  }

  if (request.method !== "POST" || request.url !== "/ai/json") {
    writeJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    applyGitHubToken(getGitHubToken(request));
    const requestData = await readBody(request);
    const content = await callSdk({
      model: requestData.model || "gpt-5-mini",
      systemPrompt: String(requestData.systemPrompt || ""),
      userPrompt: String(requestData.userPrompt || ""),
      githubToken: getGitHubToken(request)
    });

    if (!content) {
      throw new Error("SDK returned an empty completion.");
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = content;
    }

    writeJson(response, 200, { content: parsed });
  } catch (error) {
    writeJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Copilot bridge listening on http://${HOST}:${PORT}/ai/json`);
});

process.on("SIGINT", async () => {
  await stopAllWarmClients();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stopAllWarmClients();
  process.exit(0);
});
