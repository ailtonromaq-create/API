import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const API_BASE_URL = process.env.EPROM_API_BASE_URL || "https://open-api.eprom.com.br/api";
const PORT = process.env.PORT || 3000;

const DEFAULT_EMAIL = process.env.EPROM_EMAIL || null;
const DEFAULT_SENHA = process.env.EPROM_SENHA || null;

// ---------------------------------------------------------------------------
// Estado de autenticação (em memória)
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
  const resp = await fetch(`${API_BASE_URL}/Auth/Login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, senha }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(
      `Falha no login (HTTP ${resp.status}): ${JSON.stringify(data)}`
    );
  }

  authState.accessToken = data.access_token;
  authState.accessTokenExpiration = data.access_token_expiration;
  authState.refreshToken = data.refresh_token;
  authState.refreshTokenExpiration = data.refresh_token_expiration;

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
    "Não autenticado. Chame a ferramenta 'eprom_login' com email e senha, " +
      "ou defina as variáveis de ambiente EPROM_EMAIL e EPROM_SENHA no servidor."
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

  const resp = await fetch(url.toString(), {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${authState.accessToken}`,
    },
    body: body !== undefined && method !== "GET" && method !== "DELETE"
      ? JSON.stringify(body)
      : undefined,
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { status: resp.status, ok: resp.ok, data };
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Lista de Ferramentas MCP
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "eprom_login",
    description: "Autentica na Open API do ERP E-Solution.",
    parameters: z.object({
      email: z.string().describe("E-mail de login cadastrado no sistema"),
      senha: z.string().describe("Senha de login"),
    }),
    handler: async ({ email, senha }) => {
      const data = await login(email, senha);
      return toolResult({
        message: "Login realizado com sucesso.",
        access_token_expiration: data.access_token_expiration,
        refresh_token_expiration: data.refresh_token_expiration,
      });
    }
  },
  {
    name: "eprom_request",
    description: "Faz uma chamada a qualquer endpoint da Open API do ERP E-Solution.",
    parameters: z.object({
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("Método HTTP"),
      path: z.string().describe("Caminho relativo à API, ex: '/Despesa'"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.any().optional(),
    }),
    handler: async ({ method, path, query, body }) => {
      const result = await epromFetch(method, path, { query, body });
      return toolResult(result);
    }
  }
];

const shortcuts = [
  ["eprom_despesa", "Gestão de Despesas.", "/Despesa"],
  ["eprom_pagamento", "Contas a pagar.", "/Pagamento"],
  ["eprom_recebimento", "Contas a receber.", "/Recebimento"],
  ["eprom_entrada_mercadoria", "Compras.", "/EntradaMercadoria"],
  ["eprom_fatura", "Gestão de Faturas.", "/Fatura"],
  ["eprom_pedido_venda", "Gestão de Pedidos.", "/PedidoVenda"],
  ["eprom_entidade", "Clientes e Fornecedores.", "/Entidade"],
  ["eprom_produto", "Gestão de Produtos.", "/Produto"]
];

shortcuts.forEach(([name, description, path]) => {
  TOOLS.push({
    name,
    description,
    parameters: z.object({
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("Método HTTP"),
      id: z.union([z.string(), z.number()]).optional().describe("ID do registro"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.any().optional(),
    }),
    handler: async ({ method, id, query, body }) => {
      const fullPath = id ? `${path}/${id}` : path;
      const result = await epromFetch(method, fullPath, { query, body });
      return toolResult(result);
    }
  });
});

// ---------------------------------------------------------------------------
// Express Server compatível com GPT Maker (SSE & JSON-RPC)
// ---------------------------------------------------------------------------
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "5mb" }));

// Endpoint SSE (/mcp)
app.get("/mcp", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const host = req.get("host");
  const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
  const sessionId = Math.random().toString(36).substring(2, 15);
  const endpointUrl = `${protocol}://${host}/messages?sessionId=${sessionId}`;

  res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(":\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

// Processamento de Mensagens JSON-RPC MCP (/messages)
app.post("/messages", async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};

  if (method === "initialize") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "eprom-esolution-mcp", version: "1.0.0" }
      }
    });
  }

  if (method === "notifications/initialized") {
    return res.status(202).send();
  }

  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: "object",
            properties: {}
          }
        }))
      }
    });
  }

  if (method === "tools/call") {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Ferramenta ${params?.name} não encontrada.` }
      });
    }

    try {
      const result = await tool.handler(params?.arguments || {});
      return res.json({
        jsonrpc: "2.0",
        id,
        result
      });
    } catch (err) {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: toolResult({ error: String(err.message || err) })
      });
    }
  }

  return res.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Método não suportado" }
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.json({ status: "ok", service: "Eprom MCP Server" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor MCP Eprom rodando na porta ${PORT}`);
});
