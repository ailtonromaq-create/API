import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const API_BASE_URL = process.env.EPROM_API_BASE_URL || "https://open-api.eprom.com.br/api";
const PORT = process.env.PORT || 3000;

const DEFAULT_EMAIL = process.env.EPROM_EMAIL || null;
const DEFAULT_SENHA = process.env.EPROM_SENHA || null;

// Chave própria do servidor MCP (não confundir com login da Eprom).
// Se não for definida, o servidor sobe SEM autenticação e avisa no log.
const MCP_API_KEY = process.env.MCP_API_KEY || null;

const FETCH_TIMEOUT_MS = 15_000;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min sem atividade
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // varre a cada 5 min

// ---------------------------------------------------------------------------
// Logging simples com timestamp
// ---------------------------------------------------------------------------
function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (extra !== undefined) {
    (level === "ERROR" ? console.error : console.log)(line, extra);
  } else {
    (level === "ERROR" ? console.error : console.log)(line);
  }
}

// ---------------------------------------------------------------------------
// Estado de autenticação na API Eprom
// (single-tenant: um único par de credenciais compartilhado por todo o
// processo. Ver observação sobre multiusuário no histórico da conversa.)
// ---------------------------------------------------------------------------
const authState = {
  accessToken: null,
  accessTokenExpiration: null,
  refreshToken: null,
  refreshTokenExpiration: null,
};

function isExpired(iso) {
  if (!iso) return true;
  return new Date(iso).getTime() <= Date.now() + 5000;
}

async function login(email, senha) {
  log("INFO", `Efetuando login na Eprom (${email})`);
  const resp = await fetch(`${API_BASE_URL}/Auth/Login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, senha }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    log("ERROR", `Falha no login (HTTP ${resp.status})`, data);
    throw new Error(`Falha no login (HTTP ${resp.status}): ${JSON.stringify(data)}`);
  }

  authState.accessToken = data.access_token;
  authState.accessTokenExpiration = data.access_token_expiration;
  authState.refreshToken = data.refresh_token;
  authState.refreshTokenExpiration = data.refresh_token_expiration;

  log("INFO", `Login efetuado. Token expira em ${data.access_token_expiration}`);
  return data;
}

async function ensureAuthenticated() {
  if (authState.accessToken && !isExpired(authState.accessTokenExpiration)) {
    return;
  }
  if (DEFAULT_EMAIL && DEFAULT_SENHA) {
    await login(DEFAULT_EMAIL, DEFAULT_SENHA);
    return;
  }
  throw new Error(
    "Não autenticado. Defina as variáveis de ambiente EPROM_EMAIL e EPROM_SENHA ou chame eprom_login."
  );
}

async function epromFetch(method, path, { query, body } = {}) {
  await ensureAuthenticated();

  const url = new URL(
    path.startsWith("http") ? path : `${API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`
  );

  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const startedAt = Date.now();
  let resp;
  try {
    resp = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${authState.accessToken}`,
      },
      body: body !== undefined && method !== "GET" && method !== "DELETE"
        ? JSON.stringify(body)
        : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    log("ERROR", `${method} ${path} falhou${isTimeout ? " (timeout)" : ""}`, String(err));
    throw new Error(isTimeout ? `Tempo esgotado ao chamar ${path}` : String(err.message || err));
  }

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  const ms = Date.now() - startedAt;
  log("INFO", `${method} ${path} -> HTTP ${resp.status} (${ms}ms)`);

  return { status: resp.status, ok: resp.ok, data };
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Definição das tools MCP (compartilhada por Streamable HTTP e SSE)
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({
    name: "eprom-esolution-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "eprom_login",
    {
      title: "Login na API Eprom",
      description: "Autentica na Open API do ERP E-Solution.",
      inputSchema: {
        email: z.string().describe("E-mail de login cadastrado no sistema"),
        senha: z.string().describe("Senha de login"),
      },
    },
    async ({ email, senha }) => {
      try {
        const data = await login(email, senha);
        return toolResult({
          message: "Login realizado com sucesso.",
          access_token_expiration: data.access_token_expiration,
          refresh_token_expiration: data.refresh_token_expiration,
        });
      } catch (err) {
        return toolResult({ error: String(err.message || err) });
      }
    }
  );

  server.registerTool(
    "eprom_request",
    {
      title: "Chamada genérica à API Eprom",
      description: "Faz uma chamada a qualquer endpoint da Open API do ERP E-Solution.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("Método HTTP"),
        path: z.string().describe("Caminho relativo à API, ex: '/Despesa'"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.any().optional(),
      },
    },
    async ({ method, path, query, body }) => {
      try {
        const result = await epromFetch(method, path, { query, body });
        return toolResult(result);
      } catch (err) {
        return toolResult({ error: String(err.message || err) });
      }
    }
  );

  const shortcut = (name, title, description, path) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("Método HTTP"),
          id: z.union([z.string(), z.number()]).optional().describe("ID do registro"),
          query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
          body: z.any().optional(),
        },
      },
      async ({ method, id, query, body }) => {
        try {
          const fullPath = id ? `${path}/${id}` : path;
          const result = await epromFetch(method, fullPath, { query, body });
          return toolResult(result);
        } catch (err) {
          return toolResult({ error: String(err.message || err) });
        }
      }
    );
  };

  shortcut("eprom_despesa", "Despesas", "Gestão de Despesas.", "/Despesa");
  shortcut("eprom_pagamento", "Pagamentos", "Contas a pagar.", "/Pagamento");
  shortcut("eprom_recebimento", "Recebimentos", "Contas a receber.", "/Recebimento");
  shortcut("eprom_entrada_mercadoria", "Entrada de Mercadorias", "Compras.", "/EntradaMercadoria");
  shortcut("eprom_fatura", "Faturas", "Gestão de Faturas.", "/Fatura");
  shortcut("eprom_pedido_venda", "Pedidos de Venda", "Gestão de Pedidos.", "/PedidoVenda");
  shortcut("eprom_entidade", "Entidades", "Clientes e Fornecedores.", "/Entidade");
  shortcut("eprom_produto", "Produtos", "Gestão de Produtos.", "/Produto");

  return server;
}

const app = express();

app.use(cors({ origin: "*", exposedHeaders: ["Mcp-Session-Id"] }));
app.use(express.json({ limit: "5mb" }));

// ---------------------------------------------------------------------------
// Autenticação da própria camada MCP (independente do login da Eprom).
// Aceita "Authorization: Bearer <chave>" ou "?api_key=<chave>".
// Se MCP_API_KEY não estiver definida, o servidor fica aberto (com aviso).
// ---------------------------------------------------------------------------
function requireApiKey(req, res, next) {
  if (!MCP_API_KEY) {
    return next(); // sem chave configurada = sem checagem (modo aberto)
  }

  const authHeader = req.headers["authorization"];
  const headerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const queryKey = typeof req.query.api_key === "string" ? req.query.api_key : null;
  const providedKey = headerKey || queryKey;

  if (providedKey !== MCP_API_KEY) {
    log("WARN", `Tentativa de acesso não autorizada em ${req.path} (IP: ${req.ip})`);
    return res.status(401).json({ error: "Não autorizado. Chave de API ausente ou inválida." });
  }

  next();
}

// =============================================================================
// TRANSPORTE 1: Streamable HTTP (protocolo MCP atual — use este no GPT Maker)
// Rota única /mcp que lida com POST (mensagens), GET (stream do servidor) e
// DELETE (encerrar sessão). Sessão identificada pelo header Mcp-Session-Id.
// =============================================================================
const streamableTransports = new Map(); // sessionId -> { transport, server, lastActivity }

app.post("/mcp", requireApiKey, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let entry;

  if (sessionId && streamableTransports.has(sessionId)) {
    entry = streamableTransports.get(sessionId);
    entry.lastActivity = Date.now();
  } else if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        streamableTransports.set(newSessionId, { transport, server, lastActivity: Date.now() });
        log("INFO", `Nova sessão Streamable HTTP: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        streamableTransports.delete(transport.sessionId);
        log("INFO", `Sessão Streamable HTTP encerrada: ${transport.sessionId}`);
      }
    };

    const server = buildServer();
    await server.connect(transport);
    entry = { transport, server, lastActivity: Date.now() };
  } else {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Sessão inválida ou requisição de inicialização ausente." },
      id: null,
    });
  }

  await entry.transport.handleRequest(req, res, req.body);
});

async function handleStreamableSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !streamableTransports.has(sessionId)) {
    return res.status(400).send("Sessão inválida ou ausente.");
  }
  const entry = streamableTransports.get(sessionId);
  entry.lastActivity = Date.now();
  await entry.transport.handleRequest(req, res);
}

app.get("/mcp", requireApiKey, handleStreamableSessionRequest);
app.delete("/mcp", requireApiKey, handleStreamableSessionRequest);

// =============================================================================
// TRANSPORTE 2: SSE legado (fallback para clientes que ainda não suportam
// Streamable HTTP). Fica em /sse (stream) + /messages (envio de mensagens).
// =============================================================================
const sseTransports = new Map(); // sessionId -> { server, transport, lastActivity }

app.get("/sse", requireApiKey, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, { server, transport, lastActivity: Date.now() });
    log("INFO", `Nova sessão SSE: ${transport.sessionId}`);

    res.on("close", () => {
      transport.close();
      server.close();
      sseTransports.delete(transport.sessionId);
      log("INFO", `Sessão SSE encerrada: ${transport.sessionId}`);
    });

    await server.connect(transport);
  } catch (err) {
    log("ERROR", "Erro na conexão SSE", String(err));
    if (!res.headersSent) {
      res.status(500).send("Erro na conexão SSE");
    }
  }
});

app.post("/messages", requireApiKey, async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = sseTransports.get(sessionId);

  if (!entry) {
    return res.status(404).send("Sessão MCP não encontrada");
  }

  entry.lastActivity = Date.now();
  // req.body já foi parseado pelo express.json() acima — precisa ser
  // repassado explicitamente, senão o transporte tenta ler o stream de
  // novo e encontra o corpo vazio.
  await entry.transport.handlePostMessage(req, res, req.body);
});

// =============================================================================
// Limpeza periódica de sessões inativas (evita vazamento de memória se um
// cliente cair sem fechar a conexão corretamente).
// =============================================================================
setInterval(() => {
  const now = Date.now();

  for (const [id, entry] of streamableTransports.entries()) {
    if (now - entry.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
      log("INFO", `Encerrando sessão Streamable HTTP inativa: ${id}`);
      entry.transport.close?.();
      entry.server.close?.();
      streamableTransports.delete(id);
    }
  }

  for (const [id, entry] of sseTransports.entries()) {
    if (now - entry.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
      log("INFO", `Encerrando sessão SSE inativa: ${id}`);
      entry.transport.close?.();
      entry.server.close?.();
      sseTransports.delete(id);
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

// =============================================================================
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "Eprom MCP Server",
    transports: {
      streamable_http: "/mcp",
      sse_legacy: "/sse (stream) + /messages (post)",
    },
    auth_required: Boolean(MCP_API_KEY),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    eprom_authenticated: Boolean(authState.accessToken) && !isExpired(authState.accessTokenExpiration),
    active_sessions: streamableTransports.size + sseTransports.size,
  });
});

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  log("INFO", `Servidor MCP Eprom rodando na porta ${PORT}`);
  log("INFO", `Streamable HTTP: POST/GET/DELETE /mcp`);
  log("INFO", `SSE legado:      GET /sse  +  POST /messages`);
  if (!MCP_API_KEY) {
    log("WARN", "MCP_API_KEY não definida — servidor está ABERTO, sem autenticação própria.");
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown: fecha sessões ativas antes de encerrar o processo,
// para não deixar clientes MCP pendurados quando o Render reinicia o app.
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  log("INFO", `Recebido ${signal}, encerrando graciosamente...`);

  for (const entry of streamableTransports.values()) {
    entry.transport.close?.();
    entry.server.close?.();
  }
  for (const entry of sseTransports.values()) {
    entry.transport.close?.();
    entry.server.close?.();
  }

  httpServer.close(() => {
    log("INFO", "Servidor encerrado.");
    process.exit(0);
  });

  // Se não fechar em 10s, força saída.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
